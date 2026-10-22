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
  const admin = randomUUID();
  await db.query("insert into auth.users values($1)", [admin]);
  await db.query("insert into flow_members(user_id,role)values($1,'admin')", [
    admin,
  ]);
  async function as(fn) {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      admin,
    ]);
    try {
      return await fn();
    } finally {
      await db.exec("reset role");
    }
  }
  async function save(t, row, v = null) {
    return as(
      async () =>
        (
          await db.query("select flow_save($1,$2::jsonb,$3)as result", [
            t,
            JSON.stringify(row),
            v,
          ])
        ).rows[0].result,
    );
  }
  const cid = randomUUID(),
    pid = randomUUID(),
    sid = randomUUID();
  await save("customers", {
    id: cid,
    customer_code_mode: "auto",
    name: "과거 고객",
    address: "",
    phone: "02-1234-5678",
    notes: "",
  });
  await save("products", {
    id: pid,
    serial_mode: "manual",
    serial: "OLD-SERIAL",
    category: "0",
    code: "HS",
    production: "2026-10-01",
    rail: "",
    inspection: "합격",
    status: "재고",
    notes: "",
  });
  const ship = {
    id: sid,
    customerId: cid,
    name: "HS",
    productId: pid,
    notes: "과거 출고",
    date: "",
  };
  let snapshot = await save("shipments", ship);
  assert.equal(snapshot.shipment_date_unknown, true);
  assert.equal(snapshot.data.shipments[0].date, null);
  assert.equal(snapshot.data.shipments[0].quantity, 1);
  const older = { ...ship, notes: "older client" };
  delete older.date;
  snapshot = await save("shipments", older, 1);
  assert.equal(snapshot.data.shipments[0].date, null);
  snapshot = await save("shipments", { ...ship, date: "2026-10-10" }, 2);
  assert.equal(snapshot.data.shipments[0].date, "2026-10-10");
  await assert.rejects(
    save("shipments", { ...ship, date: "2026-09-30" }, 3),
    /SHIPMENT_DATE/,
  );
  const oid = randomUUID(),
    iid = randomUUID();
  const order = {
    id: oid,
    customerId: cid,
    received: "2026-10-10",
    due: "2026-10-31",
    stage: "접수",
    notes: "",
    items: [
      {
        id: iid,
        model: "수량 품목",
        specification: "",
        tracking_mode: "quantity",
        quantity: 10,
      },
    ],
  };
  await save("orders", order);
  const qty = {
    id: randomUUID(),
    date: null,
    customerId: cid,
    name: "수량 품목",
    productId: null,
    orderItemId: iid,
    quantity: 4,
    notes: "",
  };
  snapshot = await save("shipments", qty);
  assert.equal(snapshot.data.orders[0].items[0].delivered, 4);
  await assert.rejects(
    save("shipments", { ...qty, date: "2026-10-09" }, 1),
    /ORDER_SHIPMENT_DATE/,
  );
  snapshot = await save("shipments", { ...qty, date: "2026-10-11" }, 1);
  assert.equal(snapshot.data.orders[0].items[0].delivered, 4);
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20261023_unknown_shipment.sql",
    ),
    "utf8",
  );
  await db.exec(migration);
  await db.exec(migration);
  snapshot = await as(
    async () =>
      (await db.query("select flow_snapshot()as result")).rows[0].result,
  );
  assert.equal(
    snapshot.data.shipments.find((s) => s.id === sid).date,
    "2026-10-10",
  );
  assert.equal(snapshot.production_unknown, true);
  snapshot = await save("shipments", { ...ship, date: null }, 3);
  assert.equal(snapshot.data.shipments.find((s) => s.id === sid).date, null);
  console.log(
    "PASS: undated standalone and linked shipments, serial/quantity aggregation, later date correction and validation, legacy client preservation, repeated cumulative migration and existing-date retention",
  );
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
