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
      await db.query("insert into flow_members(user_id,role)values($1,$2)", [
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
  const rpc = (sql, args = [], id = admin) =>
    as(id, async () => (await db.query(sql, args)).rows[0].result);
  const save = (table, row) =>
    rpc("select flow_write($1,$2::jsonb) result", [table, JSON.stringify(row)]);
  const detail = (id, n = 1, user = admin) =>
    rpc("select flow_product_detail($1::uuid,$2) result", [id, n], user);
  const cid = randomUUID(),
    pid = randomUUID(),
    stock = randomUUID(),
    standalone = randomUUID(),
    oid = randomUUID(),
    iid = randomUUID(),
    lid = randomUUID();
  await save("customers", {
    id: cid,
    customer_code_mode: "auto",
    name: "상세 고객",
    phone: "010-1234-5678",
    address: "부산",
    notes: "",
  });
  await save("lots", {
    id: lid,
    code: "DETAIL-LOT",
    model: "MODEL",
    specification: "",
    started: "2026-01-01",
    ended: "",
    inspection: "합격",
    status: "진행중",
    notes: "",
  });
  for (const [id, serial] of [
    [pid, "DETAIL-1"],
    [stock, "STOCK-1"],
    [standalone, "OLD-1"],
  ])
    await save("products", {
      id,
      serial_mode: "manual",
      serial,
      category: "0",
      code: "MODEL",
      production: "",
      rail: "",
      lotId: id === pid ? lid : "",
      inspection: "합격",
      status: "재고",
      notes: "제품 비고",
    });
  await save("orders", {
    id: oid,
    customerId: cid,
    received: "2026-01-01",
    due: "2026-01-30",
    stage: "접수",
    notes: "수주 비고",
    items: [
      {
        id: iid,
        tracking_mode: "serial",
        model: "MODEL",
        specification: "",
        quantity: 1,
      },
    ],
  });
  await save("shipments", {
    id: randomUUID(),
    customerId: cid,
    productId: pid,
    orderItemId: iid,
    date: "",
    name: "레일방제기",
    quantity: 1,
    notes: "출고 비고",
  });
  await save("shipments", {
    id: randomUUID(),
    customerId: cid,
    productId: standalone,
    orderItemId: "",
    date: "",
    name: "과거 제품",
    quantity: 1,
    notes: "",
  });
  await db.query(
    `insert into service(id,"productId",model,received,symptom) select gen_random_uuid(),$1,'MODEL','2026-01-02','A/S '||n from generate_series(1,21) n`,
    [pid],
  );
  let result = await detail(pid);
  assert.equal(result.product.serial, "DETAIL-1");
  assert.equal(result.customer.name, "상세 고객");
  assert.equal(result.order.id, oid);
  assert.equal(result.order.items[0].delivered, 1);
  assert.equal(result.lot.code, "DETAIL-LOT");
  assert.equal(result.shipment.date, null);
  assert.equal(result.service_total, 21);
  assert.equal(result.service.length, 20);
  assert.equal(result.files_enabled, false);
  assert.equal((await detail(pid, 2)).service.length, 1);
  assert.equal((await detail(standalone)).order, null);
  assert.equal((await detail(standalone)).customer.id, cid);
  assert.equal((await detail(stock)).shipment, null);
  assert.equal((await detail(stock)).customer, null);
  await assert.rejects(detail(randomUUID()), /PRODUCT_NOT_FOUND/);
  await assert.rejects(detail(pid, 1, outsider), /STAFF_REQUIRED/);
  await require("./storage-fixture.cjs")(db);
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20261102_product_details_files.sql",
    ),
    "utf8",
  );
  await db.exec(migration);
  await db.exec(migration);
  assert.equal((await detail(pid)).files_enabled, true);
  const bucket = (
    await db.query("select * from storage.buckets where id='product-files'")
  ).rows[0];
  assert.equal(bucket.public, false);
  assert.equal(Number(bucket.file_size_limit), 10485760);
  assert.ok(!bucket.allowed_mime_types.includes("image/svg+xml"));
  const filePath = `${stock}/${randomUUID()}/검사 성적서.pdf`;
  const insert = (name, user = employee) =>
    as(user, () =>
      db.query(
        'insert into storage.objects(bucket_id,name,metadata)values(\'product-files\',$1,\'{"size":100,"mimetype":"application/pdf"}\')',
        [name],
      ),
    );
  await insert(filePath);
  assert.equal(
    (
      await rpc(
        "select flow_product_files($1::uuid,1) result",
        [stock],
        employee,
      )
    ).files[0].name,
    "검사 성적서.pdf",
  );
  await assert.rejects(
    insert(`${randomUUID()}/${randomUUID()}/no.pdf`),
    /PRODUCT_NOT_FOUND/,
  );
  await assert.rejects(insert(`invalid-path`), /INVALID_FILE_PATH/);
  await assert.rejects(
    insert(`${stock}/${randomUUID()}/no.pdf`, outsider),
    /row-level security/,
  );
  await assert.rejects(
    rpc("select flow_product_files($1::uuid,1) result", [stock], outsider),
    /STAFF_REQUIRED/,
  );
  await as(outsider, async () =>
    assert.equal(
      (await db.query("select * from storage.objects")).rows.length,
      0,
    ),
  );
  await as(employee, () =>
    db.query("delete from storage.objects where name=$1", [filePath]),
  );
  assert.equal(
    (await rpc("select flow_product_files($1::uuid,1) result", [stock])).total,
    1,
  );
  await as(employee, () =>
    db.query("update storage.objects set name='changed' where name=$1", [
      filePath,
    ]),
  );
  assert.equal(
    (await rpc("select flow_product_files($1::uuid,1) result", [stock]))
      .files[0].path,
    filePath,
  );
  await assert.rejects(
    rpc("select flow_write('products',null,1,true,$1::uuid) result", [stock]),
    /PRODUCT_HAS_FILES/,
  );
  for (let n = 0; n < 20; n++)
    await insert(`${stock}/${randomUUID()}/도면-${n}.pdf`);
  assert.equal(
    (await rpc("select flow_product_files($1::uuid,1) result", [stock])).files
      .length,
    20,
  );
  assert.equal(
    (await rpc("select flow_product_files($1::uuid,99) result", [stock])).files
      .length,
    1,
  );
  await db.exec(migration);
  assert.equal(
    (await rpc("select flow_product_files($1::uuid,1) result", [stock])).total,
    21,
  );
  await as(admin, () =>
    db.query("delete from storage.objects where bucket_id='product-files'"),
  );
  await rpc("select flow_write('products',null,1,true,$1::uuid) result", [
    stock,
  ]);
  await db.exec("set role anon");
  await assert.rejects(
    db.query("select flow_product_detail($1::uuid)", [pid]),
    /permission denied/,
  );
  await assert.rejects(
    db.query("select flow_product_files($1::uuid)", [pid]),
    /permission denied/,
  );
  assert.equal(
    (await db.query("select * from storage.objects")).rows.length,
    0,
  );
  await db.exec("reset role");
  console.log(
    "PASS: scoped product relationships, historical/stock products, paged A/S and files, private bucket settings, staff-only file access, admin-only delete, no overwrite, product deletion guard and repeatable migration",
  );
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
