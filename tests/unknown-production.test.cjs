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
  async function save(table, row, v = null) {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      admin,
    ]);
    try {
      return (
        await db.query("select flow_save($1,$2::jsonb,$3)as result", [
          table,
          JSON.stringify(row),
          v,
        ])
      ).rows[0].result;
    } finally {
      await db.exec("reset role");
    }
  }
  const base = {
    category: "0",
    code: "HS",
    production: "2026-10-01",
    rail: "",
    inspection: "합격",
    status: "재고",
    notes: "",
  };
  const known = randomUUID();
  await save("products", { ...base, id: known });
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20261023_unknown_production.sql",
    ),
    "utf8",
  );
  await db.exec(migration);
  assert.equal(
    (
      await db.query("select production::text from products where id=$1", [
        known,
      ])
    ).rows[0].production,
    "2026-10-01",
  );
  for (const production of [null, "", undefined]) {
    const id = randomUUID();
    const snapshot = await save("products", {
      ...base,
      id,
      serial_mode: "manual",
      serial: "OLD-" + id,
      production,
    });
    assert.equal(snapshot.production_unknown, true);
    assert.equal(
      snapshot.data.products.find((p) => p.id === id).production,
      null,
    );
    await assert.rejects(
      save("products", { ...base, id: randomUUID(), production }),
      /PRODUCTION_REQUIRED/,
    );
  }
  const pid = randomUUID(),
    cid = randomUUID(),
    sid = randomUUID();
  const manual = {
    ...base,
    id: pid,
    serial_mode: "manual",
    serial: "LEGACY-UNKNOWN",
    production: "",
  };
  await save("products", manual);
  await save("customers", {
    id: cid,
    code: "LEGACY-CUST",
    name: "과거 고객",
    address: "",
    phone: "",
    notes: "",
  });
  await save("shipments", {
    id: sid,
    date: "2020-01-01",
    customerId: cid,
    name: "HS",
    productId: pid,
    notes: "",
  });
  const older = { ...manual };
  delete older.production;
  let snapshot = await save("products", { ...older, notes: "older client" }, 1);
  assert.equal(
    snapshot.data.products.find((p) => p.id === pid).production,
    null,
  );
  snapshot = await save("products", { ...manual, production: "2019-01-01" }, 2);
  assert.equal(
    snapshot.data.products.find((p) => p.id === pid).production,
    "2019-01-01",
  );
  await assert.rejects(
    save("products", { ...manual, production: "2021-01-01" }, 3),
    /SHIPMENT_DATE/,
  );
  await assert.rejects(
    save("products", { ...base, id: known, production: null }, 1),
    /SERIAL_SOURCE_IMMUTABLE|check constraint/,
  );
  await db.exec(migration);
  await db.exec(migration);
  assert.equal(
    (await db.query("select production::text from products where id=$1", [pid]))
      .rows[0].production,
    "2019-01-01",
  );
  console.log(
    "PASS: manual unknown dates (null/empty/missing), automatic date requirement, existing date preservation, legacy shipment/A/S-compatible product links, later date correction and historical-shipment guard, repeatable migration",
  );
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
