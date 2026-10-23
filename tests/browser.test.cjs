const { PGlite } = require("@electric-sql/pglite");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
(async () => {
  fs.mkdirSync("test-results", { recursive: true });
  const db = new PGlite();
  await db.exec(
    `create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;`,
  );
  await db.exec(
    fs.readFileSync(
      require("node:path").join(__dirname, "../supabase/schema.sql"),
      "utf8",
    ),
  );
  const ids = {
    admin: "10000000-0000-4000-8000-000000000001",
    employee: "10000000-0000-4000-8000-000000000002",
    outsider: "10000000-0000-4000-8000-000000000003",
  };
  for (const [name, id] of Object.entries(ids)) {
    await db.query("insert into auth.users(id)values($1)", [id]);
    if (name !== "outsider")
      await db.query("insert into flow_members(user_id,role)values($1,$2)", [
        id,
        name === "admin" ? "admin" : "employee",
      ]);
  }
  let queue = Promise.resolve();
  const b = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  const errors = [];
  let refreshCount = 0;
  let networkFailure = false;
  async function context() {
    const c = await b.newContext();
    c.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
    await c.route("**/config.js*", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: "window.FLOW_CONFIG={supabaseUrl:'https://test-project.supabase.co',supabasePublishableKey:'sb_publishable_test_fixture',usernameEmailDomain:'flow.invalid'};",
      }),
    );
    await c.route("https://test-project.supabase.co/**", async (route) => {
      const r = route.request(),
        path = new URL(r.url()).pathname,
        body = r.postDataJSON() || {};
      if (networkFailure) return route.abort("failed");
      if (path === "/auth/v1/token") {
        const name = body.email?.split("@")[0] || body.refresh_token;
        if (body.email) assert.equal(body.email, name + "@flow.invalid");
        if (body.refresh_token) refreshCount++;
        if (!ids[name] || (body.email && body.password !== "test-password"))
          return route.fulfill({
            status: 400,
            json: { message: "Invalid login credentials" },
          });
        return route.fulfill({
          json: {
            access_token: name,
            refresh_token: name,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: { id: ids[name], email: name + "@flow.invalid" },
          },
        });
      }
      if (path === "/auth/v1/logout") return route.fulfill({ json: {} });
      let response;
      queue = queue.then(async () => {
        const token = r.headers().authorization?.replace("Bearer ", "");
        if (!ids[token]) {
          response = { status: 401, json: { message: "expired" } };
          return;
        }
        await db.exec("set role authenticated");
        await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
          ids[token],
        ]);
        try {
          let result;
          if (path.endsWith("flow_summary"))
            result = await db.query("select flow_summary() as result");
          else if (path.endsWith("flow_query"))
            result = await db.query(
              "select flow_query($1,$2,$3,$4,$5,$6::uuid,$7::uuid,$8::uuid,$9::uuid) as result",
              [
                body.p_table,
                body.p_search || "",
                body.p_filter || "전체",
                body.p_page || 1,
                body.p_mode || "list",
                body.p_id || null,
                body.p_link || null,
                body.p_current || null,
                body.p_lot || null,
              ],
            );
          else if (path.endsWith("flow_write"))
            result = await db.query(
              "select flow_write($1,$2::jsonb,$3,$4,$5::uuid) as result",
              [
                body.p_table,
                body.p_record ? JSON.stringify(body.p_record) : null,
                body.p_expected_version ?? null,
                body.p_delete || false,
                body.p_id || null,
              ],
            );
          else throw Error("Unexpected RPC: " + path);
          const payload = result.rows[0].result;
          if (path.endsWith("flow_query")) {
            assert.ok(payload.rows.length <= payload.pageSize);
            assert.ok(payload.pageSize <= 50);
          }
          if (path.endsWith("flow_summary"))
            assert.ok(
              Object.values(payload.data).every((rows) => rows.length === 0),
            );
          if (path.endsWith("flow_write") && !body.p_delete)
            assert.equal(payload.rows.length, 1);
          response = { json: payload };
        } catch (e) {
          response = {
            status: e.code === "42501" ? 403 : 400,
            json: { message: e.message, code: e.code },
          };
        } finally {
          await db.exec("reset role");
        }
      });
      await queue;
      await route.fulfill(response);
    });
    return c;
  }
  async function waitSaved(p) {
    try {
      await p.locator("#editor").waitFor({ state: "hidden", timeout: 5000 });
      await p.waitForFunction(
        () =>
          document.querySelector("#table-body").getAttribute("aria-busy") ===
          "false",
      );
    } catch (e) {
      console.error(
        "SAVE DEBUG",
        await p.locator("#form-error").innerText(),
        await p.locator("#record-form").evaluate((f) =>
          [...f.elements]
            .filter((e) => e.name)
            .map((e) => ({
              name: e.name,
              value: e.value,
              disabled: e.disabled,
              valid: e.validity?.valid,
              message: e.validationMessage,
            })),
        ),
      );
      throw e;
    }
  }
  async function login(p, name) {
    await p.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:8001");
    assert.equal(await p.locator("#app-content").isVisible(), false);
    await p.locator("#login-username").fill(name);
    await p.locator("#login-password").fill("test-password");
    await p.getByRole("button", { name: "로그인", exact: true }).click();
    await p.locator("#app-content").waitFor({ state: "visible" });
  }
  async function nav(p, name) {
    await p
      .locator("#navigation")
      .getByRole("button", { name, exact: false })
      .click();
    await p.waitForFunction(
      () =>
        document.querySelector("#table-body").getAttribute("aria-busy") ===
        "false",
    );
  }
  async function pickCustomer(p) {
    await p.locator("#customer-search").click();
    await p.locator("#customer-results [role=option]").first().click();
  }
  async function add(p, fields) {
    await p.locator("#add-button").click();
    await p.locator("#editor").waitFor({ state: "visible" });
    if (fields.code && (await p.locator("#customer-code-mode").count()))
      await p.locator("#customer-code-mode").selectOption("manual");
    for (const [key, value] of Object.entries(fields)) {
      const el = p.locator('[name="' + key + '"]');
      if (await el.evaluate((e) => e.tagName === "SELECT"))
        await el.selectOption(value);
      else await el.fill(value);
    }
    await p.getByRole("button", { name: "저장하기", exact: true }).click();
    await waitSaved(p);
  }
  const admin = await context(),
    ap = await admin.newPage();
  await login(ap, "admin");
  await add(ap, {
    category: "0",
    code: "RAIL-100",
    production: "2026-10-01",
    rail: "표준",
    inspection: "합격",
    status: "재고",
  });
  await ap.locator("[data-edit]").click();
  await ap.locator("#editor").waitFor({ state: "visible" });
  assert.equal(await ap.locator("[name=serial]").getAttribute("readonly"), "");
  assert.equal(await ap.locator("[name=category]").isDisabled(), true);
  assert.equal(
    await ap.locator("[name=production]").evaluate((e) => e.readOnly),
    true,
  );
  await ap.locator("#cancel-dialog").click();
  await nav(ap, "고객관리");
  await add(ap, {
    code: "C-1",
    name: "공유 고객",
    address: "서울",
    phone: "010-1111-2222",
  });
  const employee = await context(),
    ep = await employee.newPage();
  await login(ep, "employee");
  assert.match(await ep.locator("tbody").innerText(), /SN02610010001/);
  await ep.locator("[data-edit]").click();
  await ep.locator("#editor").waitFor({ state: "visible" });
  assert.equal(await ep.locator("#delete-button").isVisible(), false);
  await ep.locator("#cancel-dialog").click();
  await nav(ep, "고객관리");
  assert.match(await ep.locator("tbody").innerText(), /공유 고객/);
  // Both tabs edit the same row. The second writer must not overwrite the first.
  await ap.locator("[data-edit]").click();
  await ap.locator("#editor").waitFor({ state: "visible" });
  await ep.locator("[data-edit]").click();
  await ep.locator("#editor").waitFor({ state: "visible" });
  await ap.locator("[name=address]").fill("부산");
  await ap.getByRole("button", { name: "저장하기" }).click();
  await waitSaved(ap);
  await ep.locator("[name=address]").fill("인천");
  await ep.getByRole("button", { name: "저장하기" }).click();
  await ep.locator("#form-error").filter({ hasText: "다른 직원" }).waitFor();
  await ep.locator("#cancel-dialog").click();
  await ep.locator("#refresh-button").click();
  await ep.locator("tbody").filter({ hasText: "부산" }).waitFor();
  await nav(ep, "출고관리");
  await ep.locator("#add-button").click();
  await pickCustomer(ep);
  await ep.locator("[name=productId]").selectOption({ index: 1 });
  await ep.locator("[name=name]").fill("레일");
  await ep.getByRole("button", { name: "저장하기" }).click();
  await waitSaved(ep);
  await nav(ep, "제품관리");
  assert.match(await ep.locator("tbody").innerText(), /출고/);
  await ep.reload();
  await ep.locator("#app-content").waitFor({ state: "visible" });
  assert.match(await ep.locator("tbody").innerText(), /출고/);
  await nav(ep, "A/S");
  await ep.locator("#add-button").click();
  await ep.locator("#service-product-search").click();
  await ep.locator("#service-product-results [role=option]").first().click();
  await ep.locator("[name=received]").fill("2026-10-13");
  await ep.locator("[name=model]").fill("RAIL-100");
  await ep.locator("[name=symptom]").fill("점검 요청");
  await ep.getByRole("button", { name: "저장하기" }).click();
  await waitSaved(ep);
  assert.match(await ep.locator("tbody").innerText(), /진행중/);
  await ep.locator("[data-edit]").click();
  await ep.locator("#editor").waitFor({ state: "visible" });
  await ep.locator("[name=completed]").fill("2026-10-14");
  await ep.getByRole("button", { name: "저장하기" }).click();
  await waitSaved(ep);
  assert.match(await ep.locator("tbody").innerText(), /완료/);
  await ap.locator("#refresh-button").click();
  await ap.locator("#refresh-button").waitFor({ state: "visible" });
  await nav(ap, "출고관리");
  await ap.locator("[data-edit]").click();
  await ap.locator("#editor").waitFor({ state: "visible" });
  ap.once("dialog", (d) => d.accept());
  await ap.locator("#delete-button").click();
  await waitSaved(ap);
  await nav(ap, "제품관리");
  assert.match(await ap.locator("tbody").innerText(), /재고/);
  // Session refresh is tested against the local auth stand-in, not the real Supabase service.
  await ep.evaluate(() => {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k.startsWith("flow-auth:")) {
        const s = JSON.parse(sessionStorage.getItem(k));
        s.expires_at = 1;
        sessionStorage.setItem(k, JSON.stringify(s));
      }
    }
  });
  await ep.reload();
  await ep.locator("#app-content").waitFor({ state: "visible" });
  assert.equal(refreshCount, 1);
  networkFailure = true;
  await ep.locator("#refresh-button").click();
  await ep.locator("#sync-error").waitFor({ state: "visible" });
  assert.match(await ep.locator("#sync-error").innerText(), /接続|接|연결/);
  networkFailure = false;
  await ap.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await ap.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await ap.screenshot({
    path: "test-results/cloud-mobile.png",
    fullPage: true,
  });
  await ep.locator("#logout-button").click();
  await ep.locator("#login-screen").waitFor({ state: "visible" });
  assert.equal(await ep.locator("#app-content").isVisible(), false);
  assert.equal(await ep.evaluate(() => sessionStorage.length), 0);
  const outsider = await context(),
    op = await outsider.newPage();
  await op.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:8001");
  await op.locator("#login-username").fill("outsider");
  await op.locator("#login-password").fill("test-password");
  await op.getByRole("button", { name: "로그인", exact: true }).click();
  await op.locator("#login-error").filter({ hasText: "직원 권한" }).waitFor();
  assert.equal(await op.locator("#app-content").isVisible(), false);
  const invalid = await context(),
    ip = await invalid.newPage();
  await ip.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:8001");
  await ip.locator("#login-username").fill("ADMIN");
  await ip.locator("#login-password").fill("wrong");
  await ip.getByRole("button", { name: "로그인", exact: true }).click();
  await ip.locator("#login-error").filter({ hasText: "비밀번호" }).waitFor();
  await ip.screenshot({ path: "test-results/cloud-login.png", fullPage: true });
  await ip.locator("#login-username").fill("bad@email");
  assert.equal(
    await ip.locator("#login-username").evaluate((e) => e.checkValidity()),
    false,
  );
  assert.match(
    await ip.evaluate(async () => {
      try {
        await FlowCloud.login("bad@email", "test");
        return "";
      } catch (e) {
        return e.message;
      }
    }),
    /아이디/,
  );
  await invalid.route("https://test-project.supabase.co/auth/v1/token**", (r) =>
    r.fulfill({
      status: 400,
      json: { code: "email_not_confirmed", message: "Email not confirmed" },
    }),
  );
  await ip.locator("#login-username").fill("admin");
  await ip.locator("#login-password").fill("test-password");
  await ip.getByRole("button", { name: "로그인", exact: true }).click();
  await ip.locator("#login-error").filter({ hasText: "확인 상태" }).waitFor();
  const legacy = await context();
  await legacy.route(
    (process.env.TEST_BASE_URL || "http://127.0.0.1:8001") + "/",
    async (r) => {
      const response = await r.fetch();
      const html = (await response.text())
        .replaceAll("login-username", "login-email")
        .replace('name="username" type="text"', 'name="username" type="email"');
      await r.fulfill({ response, body: html });
    },
  );
  const lp = await legacy.newPage();
  await lp.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:8001");
  await lp.locator("#login-email").fill("admin");
  await lp.locator("#login-password").fill("test-password");
  await lp.getByRole("button", { name: "로그인", exact: true }).click();
  await lp.locator("#app-content").waitFor({ state: "visible" });
  const oldDb = await context();
  await oldDb.route(
    "https://test-project.supabase.co/rest/v1/rpc/flow_summary",
    (r) =>
      r.fulfill({
        json: {
          role: "admin",
          data: { products: [], customers: [], shipments: [], service: [] },
        },
      }),
  );
  const oldPage = await oldDb.newPage();
  await login(oldPage, "admin");
  await oldPage.locator("#add-button").click();
  assert.equal(await oldPage.locator("#editor").isVisible(), false);
  assert.match(await oldPage.locator("#toast").innerText(), /DB 업데이트/);
  const manualContext = await context();
  const mp = await manualContext.newPage();
  await login(mp, "admin");
  await mp.locator("#add-button").click();
  await mp.locator("#serial-mode").selectOption("manual");
  assert.equal(
    await mp.locator("[name=serial]").evaluate((e) => e.readOnly),
    false,
  );
  await mp.locator("[name=serial]").fill("MANUAL-001");
  await mp.locator("[name=code]").fill("수기 모델");
  await mp.getByRole("button", { name: "저장하기" }).click();
  await waitSaved(mp);
  assert.match(await mp.locator("tbody").innerText(), /MANUAL-001/);
  await mp.locator("#add-button").click();
  await mp.locator("#serial-mode").selectOption("manual");
  await mp.locator("[name=serial]").fill("manual-001");
  await mp.locator("[name=code]").fill("수기 모델");
  await mp.getByRole("button", { name: "저장하기" }).click();
  await mp.locator("#form-error").filter({ hasText: "이미 등록" }).waitFor();
  await mp.locator("#cancel-dialog").click();
  await nav(mp, "고객관리");
  await mp.locator("#add-button").click();
  assert.equal(await mp.locator("#customer-code-mode").inputValue(), "auto");
  assert.equal(
    await mp.locator("[name=code]").evaluate((e) => e.readOnly),
    true,
  );
  await mp.locator("[name=name]").fill("자동 코드 고객");
  await mp.getByRole("button", { name: "저장하기" }).click();
  await waitSaved(mp);
  assert.match(await mp.locator("tbody").innerText(), /C0001/);
  await add(mp, { code: "MY-CLIENT", name: "수기 코드 고객" });
  assert.match(await mp.locator("tbody").innerText(), /MY-CLIENT/);
  await nav(mp, "제품관리");
  await add(mp, {
    category: "0",
    code: "ORDER-500",
    rail: "500mm",
    production: "2026-10-13",
    inspection: "합격",
    status: "재고",
  });
  await add(mp, {
    category: "0",
    code: "ORDER-500",
    rail: "500mm",
    production: "2026-10-13",
    inspection: "합격",
    status: "재고",
  });
  await add(mp, {
    category: "1",
    code: "ORDER-800",
    rail: "800mm",
    production: "2026-10-13",
    inspection: "합격",
    status: "재고",
  });
  await nav(mp, "수주관리");
  await mp.locator("#add-button").click();
  await mp.locator("[name=received]").fill("2026-10-13");
  await mp.locator("[name=due]").fill("2026-11-01");
  await pickCustomer(mp);
  await mp
    .locator(".order-line")
    .first()
    .locator("[data-item=model]")
    .fill("ORDER-500");
  await mp
    .locator(".order-line")
    .first()
    .locator("[data-item=specification]")
    .fill("500mm");
  await mp
    .locator(".order-line")
    .first()
    .locator("[data-item=quantity]")
    .fill("2");
  await mp.locator("#add-order-line").click();
  await mp
    .locator(".order-line")
    .last()
    .locator("[data-item=model]")
    .fill("ORDER-800");
  await mp
    .locator(".order-line")
    .last()
    .locator("[data-item=specification]")
    .fill("800mm");
  await mp.getByRole("button", { name: "저장하기" }).click();
  await waitSaved(mp);
  assert.match(await mp.locator("tbody").innerText(), /SO0001/);
  for (let n = 0; n < 3; n++) {
    await nav(mp, "출고관리");
    await mp.locator("#add-button").click();
    await mp.locator("[name=orderItemId]").selectOption({ index: 1 });
    await mp.locator("[name=date]").fill("2026-10-13");
    await mp.locator("[name=productId]").selectOption({ index: 1 });
    assert.equal(
      await mp.locator("[name=name]").evaluate((e) => e.readOnly),
      false,
    );
    await mp.locator("[name=name]").fill("레일리프트");
    await mp.getByRole("button", { name: "저장하기" }).click();
    await waitSaved(mp);
    await nav(mp, "수주관리");
    assert.equal(
      await mp.locator("tbody tr").first().locator("td").nth(7).innerText(),
      String(n + 1),
    );
    assert.equal(
      await mp.locator("tbody tr").first().locator("td").nth(8).innerText(),
      String(2 - n),
    );
  }
  assert.match(await mp.locator("tbody").innerText(), /완료/);
  await mp.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await mp.locator("[data-edit]").click();
  await mp.locator("#editor").waitFor({ state: "visible" });
  assert.equal(await mp.locator(".order-line").count(), 2);
  assert.equal(
    await mp
      .locator(".order-line [data-item=model]")
      .first()
      .evaluate((e) => e.readOnly),
    true,
  );
  await mp.locator("#cancel-dialog").click();
  await mp.screenshot({
    path: "test-results/orders-mobile.png",
    fullPage: true,
  });

  await mp.setViewportSize({ width: 1440, height: 1000 });
  await nav(mp, "수주관리");
  await mp.locator("#add-button").click();
  await mp.locator("[name=received]").fill("2026-10-14");
  await mp.locator("[name=due]").fill("2026-11-01");
  await pickCustomer(mp);
  await mp
    .locator(".order-line [data-item=tracking_mode]")
    .selectOption("quantity");
  await mp.locator(".order-line [data-item=model]").fill("WELD-20");
  await mp.locator(".order-line [data-item=quantity]").fill("20");
  await mp.getByRole("button", { name: "저장하기" }).click();
  await waitSaved(mp);
  for (const amount of [5, 16, 15]) {
    await nav(mp, "출고관리");
    await mp.locator("#add-button").click();
    await mp.locator("[name=orderItemId]").selectOption({ index: 1 });
    assert.equal(await mp.locator("[name=productId]").isVisible(), false);
    assert.equal(
      await mp.locator("[name=quantity]").evaluate((e) => e.readOnly),
      false,
    );
    await mp.locator("[name=date]").fill("2026-10-14");
    await mp.locator("[name=quantity]").fill(String(amount));
    await mp.locator("[name=name]").fill("용접품 납품명");
    await mp.getByRole("button", { name: "저장하기" }).click();
    if (amount === 16) {
      await mp.locator("#form-error").filter({ hasText: "초과" }).waitFor();
      await mp.locator("#cancel-dialog").click();
      continue;
    }
    await waitSaved(mp);
    await nav(mp, "수주관리");
    const row = mp.locator("tbody tr").filter({ hasText: "WELD-20" });
    assert.equal(
      await row.locator("td").nth(7).innerText(),
      amount === 5 ? "5" : "20",
    );
    assert.equal(
      await row.locator("td").nth(8).innerText(),
      amount === 5 ? "15" : "0",
    );
  }
  await nav(mp, "A/S");
  await mp.locator("#add-button").click();
  await mp.locator("#service-product-search").click();
  await mp.locator("#service-product-results [role=option]").first().click();
  await mp.locator("[name=model]").fill("BILLING-TEST");
  await mp.locator("[name=received]").fill("2026-10-14");
  await mp.locator("[name=symptom]").fill("비용 테스트");
  await mp.locator("[name=billingType]").selectOption("유상");
  await mp.locator("[name=chargeAmount]").fill("100000");
  await mp.locator("[name=paidAmount]").fill("30000");
  await mp.locator("[name=paidDate]").fill("2026-10-14");
  await mp.getByRole("button", { name: "저장하기" }).click();
  await waitSaved(mp);
  let bill = mp.locator("tbody tr").filter({ hasText: "BILLING-TEST" });
  assert.match(await bill.innerText(), /부분입금/);
  assert.match(await bill.innerText(), /70,000/);
  assert.match(await bill.innerText(), /진행중/);
  await mp.locator('[data-filter="부분입금"]').click();
  await mp.waitForFunction(
    () =>
      document.querySelector("#table-body").getAttribute("aria-busy") ===
      "false",
  );
  assert.equal(await mp.locator("tbody tr").count(), 1);
  await bill.locator("[data-edit]").click();
  await mp.locator("#editor").waitFor({ state: "visible" });
  await mp.locator("[name=paidAmount]").fill("100000");
  await mp.getByRole("button", { name: "저장하기" }).click();
  await waitSaved(mp);
  assert.equal(await mp.locator("tbody tr").count(), 0);
  await mp.locator('[data-filter="입금완료"]').click();
  await mp.waitForFunction(
    () =>
      document.querySelector("#table-body").getAttribute("aria-busy") ===
      "false",
  );
  assert.match(await mp.locator("tbody").innerText(), /입금완료/);
  await bill.locator("[data-edit]").click();
  await mp.locator("#editor").waitFor({ state: "visible" });
  await mp.locator("[name=billingType]").selectOption("무상");
  assert.equal(await mp.locator("[name=paidAmount]").inputValue(), "0");
  assert.equal(await mp.locator("[name=paidDate]").inputValue(), "");
  await mp.getByRole("button", { name: "저장하기" }).click();
  await waitSaved(mp);
  await mp.locator('[data-filter="무상"]').click();
  await mp.waitForFunction(
    () =>
      document.querySelector("#table-body").getAttribute("aria-busy") ===
      "false",
  );
  assert.match(await mp.locator("tbody").innerText(), /해당 없음/);
  await nav(mp, "제품관리");
  await mp.locator("#add-button").click();
  assert.equal(await mp.locator("[name=status]").isDisabled(), false);
  assert.equal(await mp.locator("[name=status]").inputValue(), "재고");
  await mp.locator("#cancel-dialog").click();

  await nav(mp, "제조 LOT");
  await add(mp, {
    code: "LOT-20261020-01",
    model: "LOT-MODEL",
    specification: "500mm",
    started: "2026-10-20",
    ended: "2026-10-22",
  });
  await nav(mp, "제품관리");
  await mp.locator("#add-button").click();
  await mp.locator("[name=category]").selectOption("0");
  await mp.locator("[name=code]").fill("LOT-MODEL");
  await mp.locator("[name=rail]").fill("500mm");
  await mp.locator("[name=production]").fill("2026-10-20");
  await mp.locator("[name=lotId]").selectOption({ index: 1 });
  await mp.getByRole("button", { name: "저장하기" }).click();
  await waitSaved(mp);
  const lotProduct = mp.locator("tbody tr").filter({ hasText: "LOT-MODEL" });
  const lotSerial = await lotProduct.locator("td").first().innerText();
  await nav(mp, "출고관리");
  await mp.locator("#add-button").click();
  await pickCustomer(mp);
  await mp.locator("[name=date]").fill("2026-10-20");
  await mp.locator("[name=name]").fill("LOT-MODEL");
  await mp
    .locator("[name=productId]")
    .selectOption({ label: lotSerial + " · LOT-MODEL" });
  await mp.getByRole("button", { name: "저장하기" }).click();
  await waitSaved(mp);
  await nav(mp, "A/S");
  await mp.locator("#add-button").click();
  await mp.locator("#service-product-search").fill("LOT-20261020-01");
  await mp.waitForFunction(
    () =>
      document
        .querySelector("#service-product-results")
        .getAttribute("aria-busy") === "false",
  );
  assert.equal(
    await mp.locator("#service-product-results [role=option]").count(),
    1,
  );
  await mp.locator("#service-product-search").press("ArrowDown");
  await mp.locator("#service-product-search").press("Enter");
  assert.equal(
    await mp.locator("#service-product-search").inputValue(),
    lotSerial,
  );
  assert.equal(await mp.locator("[name=model]").inputValue(), "LOT-MODEL");
  await mp.locator("#service-product-search").fill("NOT-A-SERIAL");
  await mp.waitForFunction(
    () =>
      document
        .querySelector("#service-product-results")
        .getAttribute("aria-busy") === "false",
  );
  assert.match(
    await mp.locator("#service-product-results").innerText(),
    /검색 결과가 없습니다/,
  );
  assert.equal(await mp.locator("[name=productId]").inputValue(), "");
  await mp
    .locator("#service-product-search")
    .fill(lotSerial.toLowerCase().slice(-8));
  await mp.locator("#service-product-results [role=option]").first().click();
  await mp.locator("[name=received]").fill("2026-10-20");
  await mp.locator("[name=symptom]").fill("LOT 점검");
  await mp.getByRole("button", { name: "저장하기" }).click();
  await waitSaved(mp);
  assert.match(await mp.locator("tbody").innerText(), /LOT 점검/);
  await nav(mp, "제조 LOT");
  await mp.locator("[data-edit]").click();
  await mp.locator("#editor").waitFor({ state: "visible" });
  assert.match(await mp.locator(".lot-history").innerText(), /LOT 점검/);
  assert.match(await mp.locator(".lot-history").innerText(), /LOT-MODEL/);
  assert.match(
    await mp.locator(".lot-history").innerText(),
    new RegExp(lotSerial),
  );
  await mp.locator("[name=status]").selectOption("마감");
  await mp.getByRole("button", { name: "저장하기" }).click();
  await waitSaved(mp);
  await nav(mp, "제품관리");
  await mp.locator("#add-button").click();
  assert.equal(await mp.locator("[name=lotId] option").count(), 1);
  await mp.locator("#cancel-dialog").click();
  await mp.setViewportSize({ width: 390, height: 844 });
  await nav(mp, "A/S");
  await mp.locator("#add-button").click();
  await mp.locator("#service-product-search").fill("LOT-MODEL");
  await mp.waitForFunction(
    () =>
      document
        .querySelector("#service-product-results")
        .getAttribute("aria-busy") === "false",
  );
  assert.equal(
    await mp.locator("#service-product-results [role=option]").count(),
    1,
  );
  await mp.screenshot({
    path: "test-results/lot-serial-search-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await mp.locator("#cancel-dialog").click();
  for (let n = 1; n <= 25; n++)
    await db.query(
      "insert into products(id,serial,code,production,category,serial_generated,rail,inspection,status,notes) values($1,$2,'BULK-MODEL','2026-10-20','0',false,'','합격','재고','')",
      [
        require("node:crypto").randomUUID(),
        `BULK-${String(n).padStart(4, "0")}`,
      ],
    );
  await mp.locator("#refresh-button").click();
  await mp.waitForFunction(
    () => !document.querySelector("#refresh-button").disabled,
  );
  await nav(mp, "A/S");
  await mp.locator("#add-button").click();
  await mp.locator("#service-product-search").fill("BULK-");
  await mp.waitForFunction(
    () =>
      document
        .querySelector("#service-product-results")
        .getAttribute("aria-busy") === "false",
  );
  assert.equal(
    await mp.locator("#service-product-results [role=option]").count(),
    20,
  );
  assert.match(
    await mp.locator("#service-product-results").innerText(),
    /25개 중 20개/,
  );
  await mp.locator("#service-product-search").fill("BULK-NO-MATCH");
  await mp.waitForFunction(
    () =>
      document
        .querySelector("#service-product-results")
        .getAttribute("aria-busy") === "false",
  );
  await mp.locator("[name=model]").fill("BULK-MODEL");
  await mp.locator("[name=symptom]").fill("선택 검증");
  await mp.getByRole("button", { name: "저장하기" }).click();
  await mp
    .locator("#form-error")
    .filter({ hasText: "검색 결과에서" })
    .waitFor();
  await mp.locator("#cancel-dialog").click();

  await nav(mp, "제품관리");
  await mp.locator("#add-button").click();
  assert.equal(await mp.locator("#production-unknown").isDisabled(), true);
  await mp.locator("#serial-mode").selectOption("manual");
  await mp.locator("#production-unknown").check();
  assert.equal(await mp.locator("[name=production]").isDisabled(), true);
  assert.equal(await mp.locator("[name=production]").inputValue(), "");
  await mp.locator("[name=serial]").fill("BEFORE-SYSTEM-001");
  await mp.locator("[name=code]").fill("LEGACY-MODEL");
  await mp.locator("[name=notes]").fill("시스템 도입 전 생산 제품");
  await mp.getByRole("button", { name: "저장하기" }).click();
  await waitSaved(mp);
  let legacyProduct = mp
    .locator("tbody tr")
    .filter({ hasText: "BEFORE-SYSTEM-001" });
  assert.match(await legacyProduct.innerText(), /미상/);
  await legacyProduct.locator("[data-edit]").click();
  assert.equal(await mp.locator("#production-unknown").isChecked(), true);
  await mp.locator("#production-unknown").uncheck();
  await mp.locator("[name=production]").fill("2019-01-01");
  await mp.getByRole("button", { name: "저장하기" }).click();
  await waitSaved(mp);
  assert.match(await legacyProduct.innerText(), /2019-01-01/);
  await mp.locator("#add-button").click();
  await mp.locator("#serial-mode").selectOption("manual");
  await mp.locator("#production-unknown").check();
  await mp.locator("#serial-mode").selectOption("auto");
  assert.equal(await mp.locator("#production-unknown").isChecked(), false);
  assert.equal(
    await mp.locator("[name=production]").evaluate((e) => e.required),
    true,
  );
  assert.equal(await mp.locator("[name=production]").isDisabled(), false);
  await mp.locator("#cancel-dialog").click();

  await nav(mp, "출고관리");
  await mp.locator("#add-button").click();
  await mp.locator("#customer-search").fill("01011112222");
  await mp.waitForFunction(
    () =>
      document.querySelector("#customer-results").getAttribute("aria-busy") ===
      "false",
  );
  assert.equal(await mp.locator("#customer-results [role=option]").count(), 1);
  await mp.locator("#customer-search").press("ArrowDown");
  await mp.locator("#customer-search").press("Enter");
  assert.match(
    await mp.locator("#selected-customer").innerText(),
    /010-1111-2222/,
  );
  await mp.locator("[name=name]").fill("LEGACY-MODEL");
  await mp
    .locator("[name=productId]")
    .selectOption({ label: "BEFORE-SYSTEM-001 · LEGACY-MODEL" });
  await mp.locator("#shipment-date-unknown").check();
  assert.equal(await mp.locator("[name=date]").isDisabled(), true);
  await mp.getByRole("button", { name: "저장하기" }).click();
  await waitSaved(mp);
  const historical = mp
    .locator("tbody tr")
    .filter({ hasText: "BEFORE-SYSTEM-001" });
  assert.match(await historical.innerText(), /미상/);
  assert.match(await mp.locator("#stats").innerText(), /출고일 미상/);
  await historical.locator("[data-edit]").click();
  assert.equal(await mp.locator("#shipment-date-unknown").isChecked(), true);
  assert.equal(await mp.locator("#customer-search").inputValue(), "공유 고객");
  await mp.locator("#shipment-date-unknown").uncheck();
  await mp.locator("[name=date]").fill("2018-12-31");
  await mp.getByRole("button", { name: "저장하기" }).click();
  await mp.locator("#form-error").filter({ hasText: "생산일" }).waitFor();
  await mp.locator("[name=date]").fill("2020-01-01");
  await mp.getByRole("button", { name: "저장하기" }).click();
  await waitSaved(mp);
  assert.match(await historical.innerText(), /2020-01-01/);
  for (let n = 1; n <= 25; n++)
    await db.query(
      "insert into customers(id,code,name,address,phone,notes) values($1,$2,'동명 고객',$3,$4,'')",
      [
        require("node:crypto").randomUUID(),
        `SEARCH-${String(n).padStart(4, "0")}`,
        `주소 ${n}`,
        `02-9999-${String(n).padStart(4, "0")}`,
      ],
    );
  await mp.locator("#refresh-button").click();
  await mp.waitForFunction(
    () => !document.querySelector("#refresh-button").disabled,
  );
  await nav(mp, "수주관리");
  await mp.locator("#add-button").click();
  await mp.locator("#customer-search").fill("동명 고객");
  await mp.waitForFunction(
    () =>
      document.querySelector("#customer-results").getAttribute("aria-busy") ===
      "false",
  );
  assert.equal(await mp.locator("#customer-results [role=option]").count(), 20);
  assert.match(
    await mp.locator("#customer-results").innerText(),
    /25개 중 20개/,
  );
  await mp.locator("#customer-search").fill("SEARCH-0025");
  await mp.waitForFunction(
    () =>
      document.querySelector("#customer-results").getAttribute("aria-busy") ===
      "false",
  );
  await mp.locator("#customer-search").press("Enter");
  assert.match(
    await mp.locator("#selected-customer").innerText(),
    /SEARCH-0025/,
  );
  await mp.locator("#customer-search").fill("없는 고객");
  await mp.waitForFunction(
    () =>
      document.querySelector("#customer-results").getAttribute("aria-busy") ===
      "false",
  );
  assert.equal(await mp.locator("[name=customerId]").inputValue(), "");
  assert.match(
    await mp.locator("#customer-results").innerText(),
    /검색 결과가 없습니다/,
  );
  await mp.locator("#cancel-dialog").click();
  await nav(mp, "출고관리");
  await mp
    .locator("tbody tr")
    .filter({ hasText: "레일리프트" })
    .first()
    .locator("[data-edit]")
    .click();
  await mp.locator("#editor").waitFor({ state: "visible" });
  assert.equal(
    await mp.locator("#customer-search").evaluate((e) => e.readOnly),
    true,
  );
  assert.ok(await mp.locator("#customer-search").inputValue());
  await mp.locator("#cancel-dialog").click();
  await nav(mp, "출고관리");
  await mp
    .locator("tbody tr")
    .filter({ hasText: "레일리프트" })
    .first()
    .locator("[data-edit]")
    .click();
  await mp.locator("#editor").waitFor({ state: "visible" });
  const originalLink = await mp.locator("[name=orderItemId]").inputValue(),
    originalProduct = await mp.locator("[name=productId]").inputValue(),
    originalCustomer = await mp.locator("[name=customerId]").inputValue();
  assert.ok(originalLink);
  assert.equal(
    await mp.locator("[name=name]").evaluate((e) => e.readOnly),
    false,
  );
  await mp.locator("[name=name]").fill("레일방제기 납품명");
  await mp.getByRole("button", { name: "저장하기" }).click();
  await mp.locator("#editor").waitFor({ state: "hidden" });
  await mp
    .locator("tbody tr")
    .filter({ hasText: "레일방제기 납품명" })
    .locator("[data-edit]")
    .click();
  await mp.locator("#editor").waitFor({ state: "visible" });
  assert.equal(
    await mp.locator("[name=orderItemId]").inputValue(),
    originalLink,
  );
  assert.equal(
    await mp.locator("[name=productId]").inputValue(),
    originalProduct,
  );
  assert.equal(
    await mp.locator("[name=customerId]").inputValue(),
    originalCustomer,
  );
  await mp.locator("#cancel-dialog").click();
  // Pagination covers the entire search result, including records beyond page one.
  await db.exec(
    "insert into customers(id,code,name,address,phone,notes) select gen_random_uuid(),'PAGE-' || n,'페이지검증-' || lpad(n::text,3,'0'),'','','' from generate_series(1,101) n",
  );
  await mp.locator("#refresh-button").click();
  await mp.waitForFunction(
    () => !document.querySelector("#refresh-button").disabled,
  );
  await nav(mp, "고객관리");
  await mp.locator("#search").fill("페이지검증-");
  await mp.waitForFunction(
    () =>
      document.querySelector("#table-body").getAttribute("aria-busy") ===
      "false",
  );
  assert.equal(await mp.locator("tbody tr").count(), 50);
  assert.equal(await mp.locator("#previous-page").isDisabled(), true);
  const firstCustomer = await mp.locator("tbody tr").first().innerText();
  await mp.locator("#next-page").click();
  await mp.waitForFunction(
    () =>
      document.querySelector("#table-body").getAttribute("aria-busy") ===
      "false",
  );
  assert.equal(await mp.locator("tbody tr").count(), 50);
  assert.notEqual(
    await mp.locator("tbody tr").first().innerText(),
    firstCustomer,
  );
  await mp.locator("#next-page").click();
  await mp.waitForFunction(
    () =>
      document.querySelector("#table-body").getAttribute("aria-busy") ===
      "false",
  );
  assert.equal(await mp.locator("tbody tr").count(), 1);
  assert.equal(await mp.locator("#page-status").innerText(), "3 / 3 페이지");
  assert.equal(await mp.locator("#next-page").isDisabled(), true);
  await mp.locator("#previous-page").click();
  await mp.waitForFunction(
    () =>
      document.querySelector("#table-body").getAttribute("aria-busy") ===
      "false",
  );
  assert.equal(await mp.locator("#page-status").innerText(), "2 / 3 페이지");
  await mp.locator("#search").fill("페이지검증-101");
  await mp.waitForFunction(
    () =>
      document.querySelector("#table-body").getAttribute("aria-busy") ===
      "false",
  );
  assert.equal(await mp.locator("tbody tr").count(), 1);
  assert.equal(await mp.locator("#page-status").innerText(), "1 / 1 페이지");
  await mp.locator("#search").fill("존재하지않는페이지검증");
  await mp.waitForFunction(
    () =>
      document.querySelector("#table-body").getAttribute("aria-busy") ===
      "false",
  );
  assert.equal(await mp.locator("tbody tr").count(), 0);
  assert.equal(await mp.locator("#previous-page").isDisabled(), true);
  assert.equal(await mp.locator("#next-page").isDisabled(), true);
  await mp.locator("#search").fill("페이지검증-");
  await mp.waitForFunction(
    () =>
      document.querySelector("#table-body").getAttribute("aria-busy") ===
      "false",
  );
  await mp.locator("#next-page").click();
  await mp.waitForFunction(
    () =>
      document.querySelector("#table-body").getAttribute("aria-busy") ===
      "false",
  );
  await nav(mp, "제품관리");
  assert.match(await mp.locator("#page-status").innerText(), /^1 \/ /);
  assert.equal(await mp.locator("#previous-page").isDisabled(), true);
  assert.equal(await mp.locator("#next-page").isVisible(), true);
  await nav(mp, "고객관리");
  await mp.locator("#search").fill("페이지검증-");
  await mp.waitForFunction(
    () =>
      document.querySelector("#table-body").getAttribute("aria-busy") ===
      "false",
  );
  const [download] = await Promise.all([
    mp.waitForEvent("download"),
    mp.locator("#export-button").click(),
  ]);
  const csv = fs.readFileSync(await download.path(), "utf8");
  assert.equal(csv.trim().split(/\r?\n/).length, 102);
  assert.match(csv, /페이지검증-001/);
  assert.match(csv, /페이지검증-101/);
  // Delay an older search until after a newer one has completed.
  let releaseOld, signalOld;
  const held = new Promise((resolve) => (releaseOld = resolve));
  const requested = new Promise((resolve) => (signalOld = resolve));
  const queryUrl = "https://test-project.supabase.co/rest/v1/rpc/flow_query";
  const delayOldSearch = async (route) => {
    if (route.request().postDataJSON().p_search === "페이지검증-001") {
      signalOld();
      await held;
    }
    await route.fallback();
  };
  await mp.route(queryUrl, delayOldSearch);
  await mp.locator("#search").fill("페이지검증-001");
  await requested;
  await mp.locator("#search").fill("페이지검증-101");
  await mp.waitForFunction(
    () =>
      document.querySelector("#table-body").getAttribute("aria-busy") ===
      "false",
  );
  const oldResponse = mp.waitForResponse(
    (r) =>
      r.url() === queryUrl &&
      r.request().postDataJSON().p_search === "페이지검증-001",
  );
  releaseOld();
  await oldResponse;
  await mp.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.match(await mp.locator("tbody").innerText(), /페이지검증-101/);
  assert.doesNotMatch(await mp.locator("tbody").innerText(), /페이지검증-001/);
  await mp.unroute(queryUrl, delayOldSearch);
  networkFailure = true;
  await mp.locator("#search").fill("페이지검증-002");
  await mp.locator("#sync-error").waitFor({ state: "visible" });
  assert.equal(await mp.locator("#next-page").isDisabled(), true);
  networkFailure = false;
  await mp.locator("#search").fill("페이지검증-003");
  await mp.waitForFunction(
    () =>
      document.querySelector("#table-body").getAttribute("aria-busy") ===
      "false",
  );
  assert.match(await mp.locator("tbody").innerText(), /페이지검증-003/);
  assert.equal(await mp.locator("#sync-error").isHidden(), true);
  await nav(mp, "수주관리");
  await mp.locator("#add-button").click();
  await mp.locator("#customer-search").fill("PAGE-101");
  await mp
    .locator("#customer-results [role=option]")
    .filter({ hasText: "페이지검증-101" })
    .click();
  assert.ok(await mp.locator("[name=customerId]").inputValue());
  await mp.locator("#cancel-dialog").click();
  assert.deepEqual(errors, []);
  await b.close();
  await db.close();
  console.log(
    "PASS: Browser login/logout, two users sharing PostgreSQL records, employee role UI, conflict handling, shipments, A/S completion, session reload/refresh, network errors, nonstaff/wrong-password rejection mobile layout, bounded DB requests, pagination, full CSV export, late-response protection and remote selection. Auth transport simulated locally; real Supabase not verified.",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
