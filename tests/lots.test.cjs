const { PGlite } = require("@electric-sql/pglite");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
(async () => {
  const db = new PGlite();
  await db.exec(
    `create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;`,
  );
  await db.exec(
    fs.readFileSync(path.join(__dirname, "../supabase/schema.sql"), "utf8"),
  );
  await db.exec(
    "drop view flow_products_read,flow_lots_read,flow_orders_read,flow_shipments_read,flow_service_read;",
  );
  // Upgrade a DB without LOT tables, preserving an existing product.
  await db.exec(
    'drop trigger flow_lot_product_guard on products;alter table products drop column "lotId";drop table manufacturing_lots;',
  );
  const admin = randomUUID(),
    employee = randomUUID(),
    stranger = randomUUID();
  for (const id of [admin, employee, stranger])
    await db.query("insert into auth.users values($1)", [id]);
  await db.query(
    "insert into flow_members(user_id,role)values($1,'admin'),($2,'employee')",
    [admin, employee],
  );
  const legacy = randomUUID();
  await db.query(
    "insert into products(id,serial,code,production,category,serial_generated,inspection,status) values($1,'LEGACY','HS-100','2026-10-20','0',false,'합격','재고')".replace(
      "합격",
      "합격",
    ),
    [legacy],
  );
  const migration = fs.readFileSync(
    path.join(__dirname, "../supabase/migrations/20261020_lot_model_only.sql"),
    "utf8",
  );
  await db.exec(migration);
  assert.equal(
    (await db.query('select "lotId" from products where id=$1', [legacy]))
      .rows[0].lotId,
    null,
  );
  async function as(user, fn) {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      user,
    ]);
    try {
      return await fn();
    } finally {
      await db.exec("reset role");
    }
  }
  async function save(table, row, v = null, user = employee) {
    return as(
      user,
      async () =>
        (
          await db.query("select flow_save($1,$2::jsonb,$3)as result", [
            table,
            JSON.stringify(row),
            v,
          ])
        ).rows[0].result,
    );
  }
  async function remove(id, v, user = admin) {
    return as(user, () =>
      db.query("select flow_delete('lots',$1::uuid,$2)", [id, v]),
    );
  }
  const lid = randomUUID(),
    pid = randomUUID(),
    lot = {
      id: lid,
      code: "LOT-20261020-01",
      model: "HS-100",
      specification: "500mm",
      started: "2026-10-20",
      ended: "2026-10-22",
      inspection: "검사대기",
      status: "진행중",
      notes: "",
    };
  let snapshot = await save("lots", lot);
  assert.equal(snapshot.manufacturing_lots, true);
  assert.equal(snapshot.lots, undefined);
  assert.equal(snapshot.data.lots[0].code, lot.code);
  const prod = {
    id: pid,
    category: "0",
    code: "HS-100",
    production: "2026-10-20",
    rail: "500mm",
    inspection: "합격",
    status: "재고",
    notes: "",
    lotId: lid,
  };
  await save("products", prod);
  await assert.rejects(
    save("lots", { ...lot, id: randomUUID(), code: lot.code.toLowerCase() }),
    /unique/,
  );
  await assert.rejects(
    save("lots", { ...lot, code: "CHANGED" }, 1),
    /LOT_CODE_LOCKED/,
  );
  await assert.rejects(
    save("lots", { ...lot, model: "OTHER" }, 1),
    /LOT_LINKED_PRODUCTS/,
  );

  await save("products", { ...prod, id: randomUUID(), rail: "800mm" });
  await assert.rejects(
    save("products", { ...prod, id: randomUUID(), code: "OTHER" }),
    /LOT_PRODUCT_MISMATCH/,
  );
  await save("products", {
    ...prod,
    id: randomUUID(),
    production: "2026-10-19",
  });
  await save("products", {
    ...prod,
    id: randomUUID(),
    code: " hs-100 ",
    production: "2026-11-01",
    rail: "",
  });
  await assert.rejects(remove(lid, 1), /foreign key/);
  await assert.rejects(remove(lid, 1, employee), /ADMIN_REQUIRED/);
  snapshot = await save("lots", { ...lot, status: "마감" }, 1);
  assert.equal(snapshot.data.lots[0].status, "마감");
  await assert.rejects(
    save("products", { ...prod, id: randomUUID() }),
    /LOT_CLOSED/,
  );
  await assert.rejects(
    save("products", { ...prod, lotId: "" }, 1),
    /LOT_CLOSED/,
  );
  const older = { ...prod, notes: "older client" };
  delete older.lotId;
  snapshot = await save("products", older, 1);
  assert.equal(snapshot.data.products.find((p) => p.id === pid).lotId, lid);
  await assert.rejects(
    save("lots", { ...lot, notes: "stale" }, 1),
    /STALE_RECORD/,
  );
  await as(stranger, async () =>
    assert.equal(
      (await db.query("select * from manufacturing_lots")).rows.length,
      0,
    ),
  );
  await as(employee, () =>
    assert.rejects(
      db.query("delete from manufacturing_lots"),
      /permission denied/,
    ),
  );
  await save(
    "lots",
    {
      ...lot,
      status: "마감",
      specification: "changed",
      started: "2026-11-01",
      ended: "2026-11-02",
    },
    2,
  );
  await db.exec(migration);
  await db.exec(migration);
  snapshot = await as(
    admin,
    async () =>
      (await db.query("select flow_snapshot()as result")).rows[0].result,
  );
  assert.equal(snapshot.data.products.find((p) => p.id === pid).lotId, lid);
  assert.equal(snapshot.data.lots[0].status, "마감");
  assert.equal(snapshot.service_billing, true);
  assert.equal(snapshot.quantity_management, true);
  console.log(
    "PASS: LOT upgrade preserving products, linking and validation, unique codes, closed LOT protection, linked deletion prevention, staff access, version conflicts, older-client link retention and repeatable cumulative migration",
  );
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
