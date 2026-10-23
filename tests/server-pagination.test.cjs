const { PGlite } = require("@electric-sql/pglite");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
(async () => {
  const db = new PGlite();
  await db.exec(
    "create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;",
  );
  await db.exec(
    fs.readFileSync(path.join(__dirname, "../supabase/schema.sql"), "utf8"),
  );
  const admin = randomUUID(),
    employee = randomUUID(),
    outsider = randomUUID();
  for (const [id, role] of [
    [admin, "admin"],
    [employee, "employee"],
    [outsider, null],
  ]) {
    await db.query("insert into auth.users values($1)", [id]);
    if (role)
      await db.query("insert into flow_members(user_id,role) values($1,$2)", [
        id,
        role,
      ]);
  }
  async function as(id, fn) {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    try {
      return await fn();
    } finally {
      await db.exec("reset role");
    }
  }
  const call = (sql, args = [], id = admin) =>
    as(id, async () => (await db.query(sql, args)).rows[0].result);
  const query = (
    table,
    search = "",
    filter = "전체",
    page = 1,
    mode = "list",
    id = null,
    link = null,
    current = null,
    lot = null,
    user = admin,
  ) =>
    call(
      "select flow_query($1,$2,$3,$4,$5,$6::uuid,$7::uuid,$8::uuid,$9::uuid) result",
      [table, search, filter, page, mode, id, link, current, lot],
      user,
    );
  const write = (table, record, version = null, user = admin) =>
    call(
      "select flow_write($1,$2::jsonb,$3) result",
      [table, JSON.stringify(record), version],
      user,
    );
  await db.exec(
    "insert into customers(id,code,name,phone) select gen_random_uuid(),'CUST-'||n,'고객-'||lpad(n::text,3,'0'),'010-1234-5678' from generate_series(1,121) n",
  );
  await db.exec(
    "insert into products(id,serial,code,production,category,rail,inspection,status) select gen_random_uuid(),'P-'||lpad(n::text,4,'0'),'MODEL','2026-01-01','0','','합격','재고' from generate_series(1,125) n",
  );
  const pages = [];
  for (let p = 1; p <= 3; p++) {
    const result = await query("products", "", "전체", p);
    assert.equal(result.total, 125);
    assert.equal(result.rows.length, p === 3 ? 25 : 50);
    assert.equal(result.data.products.length, result.rows.length);
    pages.push(...result.rows.map((r) => r.id));
  }
  assert.equal(new Set(pages).size, 125);
  assert.equal((await query("products", "", "전체", 999)).page, 3);
  assert.equal((await query("products", "", "전체", -5)).page, 1);
  assert.equal((await query("products", "P-0125")).rows.length, 1);
  assert.equal((await query("products", "%")).total, 0); // literal search, not a wildcard
  assert.equal((await query("products", "' OR true --")).total, 0);
  assert.equal((await query("products", "없는값")).rows.length, 0);
  const lookup = await query("customers", "01012345678", "전체", 1, "lookup");
  assert.equal(lookup.total, 121);
  assert.equal(lookup.rows.length, 20);
  const cid = (await query("customers")).rows[0].id,
    pid = pages[0],
    oid = randomUUID(),
    iid = randomUUID();
  const order = {
    id: oid,
    customerId: cid,
    received: "2026-01-01",
    due: "2026-01-30",
    stage: "접수",
    notes: "",
    items: [
      {
        id: iid,
        model: "MODEL",
        specification: "",
        quantity: 1,
        tracking_mode: "serial",
      },
    ],
  };
  await write("orders", order);
  const sid = randomUUID();
  const shipment = {
    id: sid,
    customerId: cid,
    productId: pid,
    orderItemId: iid,
    date: "",
    name: "레일방제기",
    quantity: 1,
    notes: "",
  };
  const saved = await write("shipments", shipment, null, employee);
  assert.equal(saved.rows.length, 1);
  assert.equal(saved.rows[0].name, "레일방제기");
  assert.equal(saved.data.products.length, 1);
  assert.equal(saved.data.orders.length, 1);
  assert.equal((await query("products", "", "출고")).total, 1);
  assert.equal((await query("products", "", "재고")).total, 124);
  assert.equal((await query("orders", "", "완료")).total, 1);
  assert.equal((await query("orders", "", "접수")).total, 0);
  assert.equal((await query("orders", "", "전체", 1, "options")).total, 0);
  assert.equal(
    (await query("products", "P-0001", "전체", 1, "options")).total,
    0,
  );
  assert.equal(
    (await query("products", "P-0001", "전체", 1, "options", null, null, pid))
      .total,
    1,
  );
  assert.equal(
    (await query("shipments", "레일방제기")).rows[0]._display.customerId,
    "고객-001",
  );
  assert.equal(
    (await query("shipments", "P-0001")).rows[0]._display.date,
    "미상",
  );
  const aid = randomUUID();
  await write("service", {
    id: aid,
    productId: pid,
    model: "MODEL",
    received: "2026-01-02",
    symptom: "점검",
    action: "",
    owner: "",
    completed: "",
    billingType: "유상",
    chargeAmount: 100,
    paidAmount: 50,
    paidDate: "2026-01-02",
  });
  assert.equal((await query("service", "", "부분입금")).total, 1);
  assert.equal((await query("service", "", "완료")).total, 0);
  assert.equal((await query("service", "", "진행중")).total, 1);
  const lid = randomUUID();
  await write("lots", {
    id: lid,
    code: "LOT-PAGE",
    model: "MODEL",
    specification: "different allowed",
    started: "2026-01-01",
    ended: "",
    inspection: "합격",
    status: "진행중",
    notes: "",
  });
  await db.query(`update products set "lotId"=$1 where serial<='P-0075'`, [
    lid,
  ]);
  assert.equal(
    (await query("products", "", "전체", 1, "history", null, null, null, lid))
      .total,
    75,
  );
  assert.equal(
    (await query("products", "", "전체", 2, "history", null, null, null, lid))
      .rows.length,
    25,
  );
  assert.equal((await query("lots", "LOT-PAGE")).rows[0].productCount, 75);
  assert.equal(
    (await query("shipments", "", "전체", 1, "history", null, null, null, lid))
      .total,
    1,
  );
  assert.equal(
    (await query("products", "고객-001", "전체", 1, "lookup")).rows[0].id,
    pid,
  );
  const listOrder = (await query("orders")).rows[0];
  assert.equal(listOrder.items, undefined);
  assert.match(listOrder._display.items_summary, /MODEL/);
  const detailOrder = (await query("orders", "", "전체", 1, "detail", oid))
    .rows[0];
  assert.equal(detailOrder.items.length, 1);
  const summary = await call("select flow_summary() result");
  assert.equal(summary.counts.products, 125);
  assert.deepEqual(summary.metrics.products, [125, 124, 1, 0]);
  assert.equal(summary.metrics.orders[2], 1);
  assert.ok(Object.values(summary.data).every((a) => a.length === 0));
  const legacy = await call("select flow_snapshot() result");
  assert.equal(legacy.data.products.length, 125); // compact scope must not leak into later requests
  await assert.rejects(
    query("products", "", "전체", 1, "list", null, null, null, null, outsider),
    /STAFF_REQUIRED/,
  );
  await assert.rejects(
    call("select flow_summary() result", [], outsider),
    /STAFF_REQUIRED/,
  );
  await assert.rejects(query("flow_members"), /INVALID_TABLE/);
  await db.exec("set role anon");
  await assert.rejects(db.query("select flow_summary()"), /permission denied/);
  await assert.rejects(
    db.query("select flow_query('products')"),
    /permission denied/,
  );
  await assert.rejects(
    db.query("select flow_write('products')"),
    /permission denied/,
  );
  await db.exec("reset role");
  await as(employee, () =>
    assert.rejects(
      db.query("select * from flow_products_read"),
      /permission denied/,
    ),
  );
  await as(employee, () =>
    assert.rejects(
      db.query("select flow_read_rows('products')"),
      /permission denied/,
    ),
  );
  await assert.rejects(
    write("shipments", { ...shipment, name: "changed" }, 99),
    /STALE_RECORD/,
  );
  await call("select flow_write($1,null,$2,true,$3::uuid) result", [
    "shipments",
    1,
    sid,
  ]);
  assert.equal((await query("products", "", "재고")).total, 125);
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20261024_server_pagination.sql",
    ),
    "utf8",
  );
  await db.exec(migration);
  await db.exec(migration);
  assert.equal((await query("products")).total, 125);
  assert.equal((await query("service", "", "부분입금")).total, 1);
  console.log(
    "PASS: bounded DB pages, totals and aggregates, search across all records, literal search, filters, related context, compact writes, version conflicts, authorization and repeatable migration",
  );
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
