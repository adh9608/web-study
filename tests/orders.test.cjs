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
  const admin = randomUUID(),
    employee = randomUUID(),
    stranger = randomUUID();
  for (const id of [admin, employee, stranger])
    await db.query("insert into auth.users values($1)", [id]);
  await db.query(
    "insert into flow_members(user_id,role)values($1,'admin'),($2,'employee')",
    [admin, employee],
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
  async function save(table, record, v = null, user = admin) {
    return as(
      user,
      async () =>
        (
          await db.query("select flow_save($1,$2::jsonb,$3)as result", [
            table,
            JSON.stringify(record),
            v,
          ])
        ).rows[0].result,
    );
  }
  async function remove(table, id, v, user = admin) {
    return as(
      user,
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
    other = randomUUID();
  for (const id of [cid, other])
    await save("customers", {
      id,
      customer_code_mode: "auto",
      name: "고객",
      address: "",
      phone: "",
      notes: "",
    });
  const oid = randomUUID(),
    iid = randomUUID(),
    second = randomUUID();
  const order = {
    id: oid,
    received: "2026-10-01",
    customerId: cid,
    due: "2026-10-20",
    stage: "접수",
    notes: "다품목",
    items: [
      { id: iid, model: "HS-100", specification: "500mm", quantity: 2 },
      { id: second, model: "HS-200", specification: "800mm", quantity: 1 },
    ],
  };
  let snapshot = await save("orders", order, null, employee);
  assert.equal(snapshot.orders_enabled, true);
  assert.equal(snapshot.data.orders[0].number, "SO0001");
  assert.equal(snapshot.data.orders[0].items.length, 2);
  async function prod(model = "HS-100", rail = "500mm") {
    const id = randomUUID();
    await save("products", {
      id,
      category: "0",
      code: model,
      production: "2026-09-30",
      rail,
      inspection: "합격",
      status: "재고",
      notes: "",
    });
    return id;
  }
  const p1 = await prod(),
    p2 = await prod(),
    p3 = await prod(),
    wrong = await prod("WRONG", "500mm"),
    last = await prod("HS-200", "800mm");
  const sid = randomUUID(),
    s2 = randomUUID(),
    s3 = randomUUID();
  const ship = {
    id: sid,
    date: "2026-10-13",
    customerId: cid,
    name: "ignored",
    productId: p1,
    orderItemId: iid,
    notes: "",
  };
  snapshot = await save("shipments", ship, null, employee);
  assert.equal(snapshot.data.orders[0].items[0].delivered, 1);
  assert.equal(snapshot.data.orders[0].version, 2);
  assert.equal(snapshot.data.shipments[0].name, "HS-100");
  await assert.rejects(save("orders", order, 1), /STALE_RECORD/);
  await assert.rejects(
    save("orders", { ...order, customerId: other }, 2),
    /ORDER_CUSTOMER_LOCKED/,
  );
  await assert.rejects(
    save(
      "orders",
      { ...order, items: [{ ...order.items[0], quantity: 0 }, order.items[1]] },
      2,
    ),
    /ORDER_QUANTITY_BELOW_SHIPPED/,
  );
  await assert.rejects(
    save(
      "orders",
      {
        ...order,
        items: [{ ...order.items[0], model: "changed" }, order.items[1]],
      },
      2,
    ),
    /ORDER_ITEM_LOCKED/,
  );
  await assert.rejects(
    save("orders", { ...order, items: [order.items[1]] }, 2),
    /foreign key/,
  );
  await assert.rejects(
    save("shipments", { ...ship, id: s2, productId: wrong }),
    /ORDER_PRODUCT_MISMATCH/,
  );
  await assert.rejects(
    save("shipments", { ...ship, id: s2, productId: p2, customerId: other }),
    /ORDER_CUSTOMER_MISMATCH/,
  );
  await assert.rejects(
    save("shipments", { ...ship, id: s2, productId: p2, date: "2026-09-30" }),
    /ORDER_SHIPMENT_DATE/,
  );
  snapshot = await save("shipments", { ...ship, id: s2, productId: p2 });
  assert.equal(snapshot.data.orders[0].items[0].delivered, 2);
  await assert.rejects(
    save("shipments", { ...ship, id: s3, productId: p3 }),
    /ORDER_OVERSHIP/,
  );
  snapshot = await save("shipments", {
    ...ship,
    id: s3,
    productId: last,
    orderItemId: second,
  });
  assert.deepEqual(
    snapshot.data.orders[0].items.map((i) => i.delivered),
    [2, 1],
  );
  await assert.rejects(remove("orders", oid, 4), /foreign key/);
  await assert.rejects(remove("orders", oid, 4, employee), /ADMIN_REQUIRED/);
  snapshot = await remove("shipments", s2, 1);
  assert.equal(snapshot.data.orders[0].items[0].delivered, 1);
  assert.equal(snapshot.data.orders[0].version, 5);
  snapshot = await save("orders", { ...order, stage: "취소" }, 5);
  assert.equal(snapshot.data.orders[0].stage, "취소");
  await assert.rejects(
    save("shipments", { ...ship, id: s2, productId: p2 }),
    /ORDER_CANCELLED/,
  );
  await as(stranger, () =>
    assert.rejects(
      db.query("select flow_save_order($1::jsonb,null)", [
        JSON.stringify({ ...order, id: randomUUID() }),
      ]),
      /STAFF_REQUIRED/,
    ),
  );
  await as(stranger, async () => {
    assert.equal((await db.query("select * from orders")).rows.length, 0);
    assert.equal((await db.query("select * from order_items")).rows.length, 0);
  });
  await as(employee, () =>
    assert.rejects(db.query("delete from order_items"), /permission denied/),
  );
  snapshot=await save("shipments",{...ship,orderItemId:undefined,notes:"older client"},1);
  assert.equal(snapshot.data.shipments.find(s=>s.id===sid).orderItemId,iid);
  const migration = fs.readFileSync(
    path.join(__dirname, "../supabase/migrations/20261013_orders.sql"),
    "utf8",
  );
  await db.exec(migration);
  await db.exec(migration);
  snapshot = await as(
    admin,
    async () =>
      (await db.query("select flow_snapshot()as result")).rows[0].result,
  );
  assert.equal(snapshot.data.orders[0].number, "SO0001");
  assert.equal(snapshot.data.orders[0].items[0].delivered, 1);
  const newOrder = {
    ...order,
    id: randomUUID(),
    items: [{ id: randomUUID(), model: "NEW", specification: "", quantity: 1 }],
  };
  snapshot = await save("orders", newOrder);
  assert.equal(
    snapshot.data.orders.find((o) => o.id === newOrder.id).number,
    "SO0002",
  );
  await remove("orders", newOrder.id, 1);
  snapshot = await save("orders", {
    ...newOrder,
    id: randomUUID(),
    items: [{ id: randomUUID(), model: "NEW", specification: "", quantity: 1 }],
  });
  assert.ok(snapshot.data.orders.some((o) => o.number === "SO0003"));
  console.log(
    "PASS: multi-item orders, numbering, staff permissions, partial shipments, quantity/customer/model/spec/date validation, version conflicts, cancellation, guarded deletion, shipment deletion counts and repeatable cumulative migration",
  );
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
