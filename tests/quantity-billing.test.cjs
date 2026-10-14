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
  async function save(table, row, v = null) {
    return as(
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
  async function remove(table, id, v) {
    return as(
      async () =>
        (
          await db.query("select flow_delete($1,$2::uuid,$3)as result", [
            table,
            id,
            v,
          ])
        ).rows[0].result,
    );
  }
  const cid = randomUUID(),
    pid = randomUUID(),
    oid = randomUUID(),
    iid = randomUUID();
  await save("customers", {
    id: cid,
    name: "고객",
    code: "",
    customer_code_mode: "auto",
    address: "",
    phone: "",
    notes: "",
  });
  await save("products", {
    id: pid,
    category: "0",
    code: "HS",
    production: "2026-10-01",
    rail: "",
    inspection: "합격",
    status: "재고",
    notes: "",
  });
  const order = {
    id: oid,
    customerId: cid,
    received: "2026-10-01",
    due: "2026-10-30",
    stage: "접수",
    notes: "",
    items: [
      {
        id: iid,
        model: "용접품",
        specification: "",
        quantity: 20,
        tracking_mode: "quantity",
      },
    ],
  };
  let snapshot = await save("orders", order);
  assert.equal(snapshot.quantity_management, true);
  const sid = randomUUID();
  const ship = {
    id: sid,
    date: "2026-10-14",
    customerId: cid,
    productId: "",
    quantity: 5,
    orderItemId: iid,
    name: "용접품",
    notes: "",
  };
  snapshot = await save("shipments", ship);
  assert.equal(snapshot.data.shipments[0].productId, null);
  assert.equal(snapshot.data.orders[0].items[0].delivered, 5);
  await assert.rejects(
    save("shipments", { ...ship, id: randomUUID(), quantity: 16 }),
    /ORDER_OVERSHIP/,
  );
  await assert.rejects(
    save("shipments", { ...ship, id: randomUUID(), quantity: 0 }),
    /INVALID_SHIPMENT_QUANTITY/,
  );
  await assert.rejects(
    save("shipments", { ...ship, id: randomUUID(), quantity: 1.5 }),
    /integer/,
  );
  await assert.rejects(
    save("shipments", {
      ...ship,
      id: randomUUID(),
      quantity: 1,
      productId: pid,
    }),
    /QUANTITY_SHIPMENT_NO_SERIAL/,
  );
  await assert.rejects(
    save("shipments", { ...ship, id: randomUUID(), orderItemId: null }),
    /SERIAL_SHIPMENT_REQUIRED/,
  );
  await assert.rejects(
    save(
      "orders",
      { ...order, items: [{ ...order.items[0], tracking_mode: "serial" }] },
      2,
    ),
    /ORDER_TRACKING_LOCKED/,
  );
  snapshot = await save("shipments", { ...ship, quantity: 8 }, 1);
  assert.equal(snapshot.data.orders[0].items[0].delivered, 8);
  await assert.rejects(
    save(
      "orders",
      { ...order, items: [{ ...order.items[0], quantity: 7 }] },
      3,
    ),
    /ORDER_QUANTITY_BELOW_SHIPPED/,
  );
  snapshot = await remove("shipments", sid, 2);
  assert.equal(snapshot.data.orders[0].items[0].delivered, 0);
  const oldShip = {
    ...ship,
    id: randomUUID(),
    productId: pid,
    quantity: 1,
    orderItemId: null,
  };
  await save("shipments", oldShip);
  await assert.rejects(
    save("shipments", { ...oldShip, quantity: 2 }, 1),
    /SERIAL_SHIPMENT_REQUIRED/,
  );
  const aid = randomUUID();
  const service = {
    id: aid,
    productId: pid,
    model: "HS",
    received: "2026-10-14",
    symptom: "점검",
    action: "",
    owner: "김",
    completed: "",
    billingType: "유상",
    chargeAmount: 100000,
    paidAmount: 30000,
    paidDate: "2026-10-14",
  };
  snapshot = await save("service", service);
  assert.equal(snapshot.service_billing, true);
  assert.equal(snapshot.data.service[0].paidAmount, 30000);
  assert.equal(snapshot.data.service[0].completed, null);
  await assert.rejects(
    save("service", { ...service, paidAmount: 110000 }, 1),
    /check constraint/,
  );
  await assert.rejects(
    save("service", { ...service, paidDate: "" }, 1),
    /check constraint/,
  );
  await assert.rejects(
    save("service", { ...service, billingType: "무상" }, 1),
    /check constraint/,
  );
  await assert.rejects(
    save("service", { ...service, chargeAmount: -1 }, 1),
    /check constraint/,
  );
  const legacy = { ...service };
  for (const key of ["billingType", "chargeAmount", "paidAmount", "paidDate"])
    delete legacy[key];
  snapshot = await save("service", { ...legacy, completed: "2026-10-15" }, 1);
  assert.equal(snapshot.data.service[0].paidAmount, 30000);
  snapshot = await save(
    "service",
    { ...service, completed: "2026-10-15", paidAmount: 100000 },
    2,
  );
  assert.equal(snapshot.data.service[0].paidAmount, 100000);
  const free = await save("service", {
    ...service,
    id: randomUUID(),
    billingType: "무상",
    chargeAmount: 0,
    paidAmount: 0,
    paidDate: "",
  });
  assert.ok(
    free.data.service.some(
      (s) => s.billingType === "무상" && s.paidDate === null,
    ),
  );
  // Simulate old columns, then apply the cumulative upgrade and prove data preservation.
  await db.exec(
    'alter table service drop column "billingType" cascade;alter table service drop column "chargeAmount" cascade;alter table service drop column "paidAmount" cascade;alter table service drop column "paidDate" cascade;',
  );
  const migration = fs.readFileSync(
    path.join(__dirname, "../supabase/migrations/20261014_service_billing.sql"),
    "utf8",
  );
  await db.exec(migration);
  await db.exec(migration);
  snapshot = await as(
    async () =>
      (await db.query("select flow_snapshot()as result")).rows[0].result,
  );
  assert.equal(
    snapshot.data.service.find((s) => s.id === aid).billingType,
    "미정",
  );
  assert.ok(snapshot.data.orders.some((o) => o.id === oid));
  assert.equal(
    snapshot.data.shipments.find((s) => s.id === oldShip.id).quantity,
    1,
  );
  const qty2 = { ...ship, id: randomUUID(), quantity: 20 };
  snapshot = await save("shipments", qty2);
  assert.equal(snapshot.data.orders[0].items[0].delivered, 20);
  console.log(
    "PASS: quantity shipment aggregation/edit/delete and overship validation, serial backwards compatibility, locked tracking mode, billing amounts/date/free rules, repair/payment independence, legacy-client preservation, cumulative upgrade and existing data retention",
  );
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
