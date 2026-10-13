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
  // Reproduce a pre-migration installation with legacy identifiers.
  await db.exec(
    "drop trigger flow_product_serial_trigger on products;alter table products drop column category;alter table products drop column serial_generated;drop table flow_serial_counters;",
  );
  const legacy = randomUUID(),
    known = randomUUID(),
    admin = randomUUID();
  await db.query(
    "insert into products(id,serial,code,production,inspection,status)values($1,'OLD-123','모델A','2026-01-01','합격','재고'),($2,'SN02601010007','모델B','2026-01-01','합격','재고')",
    [legacy, known],
  );
  const migration = fs.readFileSync(
    path.join(__dirname, "../supabase/migrations/20261013_auto_serial.sql"),
    "utf8",
  );
  await db.exec(migration);
  await db.exec(migration);
  assert.equal(
    (await db.query("select serial from products where id=$1", [legacy]))
      .rows[0].serial,
    "OLD-123",
  );
  assert.equal(
    (await db.query("select category from products where id=$1", [known]))
      .rows[0].category,
    "0",
  );
  await db.query("insert into auth.users values($1)", [admin]);
  await db.query("insert into flow_members(user_id,role)values($1,'admin')", [
    admin,
  ]);
  const base = {
    code: "모델",
    production: "2026-10-13",
    rail: "",
    inspection: "합격",
    status: "재고",
    notes: "",
  };
  async function save(record, version = null) {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      admin,
    ]);
    try {
      return (
        await db.query("select flow_save($1,$2::jsonb,$3) as result", [
          "products",
          JSON.stringify(record),
          version,
        ])
      ).rows[0].result;
    } finally {
      await db.exec("reset role");
    }
  }
  async function add(category, production = "2026-10-13") {
    const id = randomUUID();
    const snapshot = await save({
      ...base,
      id,
      category,
      production,
      serial: "MANUAL-IGNORED",
    });
    return snapshot.data.products.find((p) => p.id === id);
  }
  const first = await add("0");
  assert.equal(first.serial, "SN02610130008");
  const nextDate = await add("0", "2026-10-14");
  assert.equal(nextDate.serial, "SN02610140009");
  assert.equal((await add("1")).serial, "SN12610130001");
  assert.equal((await add("2")).serial, "SN22610130001");
  const legacyRow = (
    await save(
      { ...base, id: legacy, serial: "TRY-TO-REPLACE", category: "" },
      1,
    )
  ).data.products.find((p) => p.id === legacy);
  assert.equal(legacyRow.serial, "OLD-123");
  assert.equal(legacyRow.category, null);
  await assert.rejects(
    save({ ...first, category: "1" }, 1),
    /SERIAL_SOURCE_IMMUTABLE/,
  );
  await assert.rejects(
    save({ ...first, production: "2026-10-14" }, 1),
    /SERIAL_SOURCE_IMMUTABLE/,
  );
  await assert.rejects(
    save({ ...base, id: randomUUID(), category: "9" }),
    /PRODUCT_CATEGORY_REQUIRED/,
  );
  await assert.rejects(
    save({ ...base, id: randomUUID() }),
    /PRODUCT_CATEGORY_REQUIRED/,
  );
  await db.query(
    "update flow_serial_counters set last_number=9998 where category='0'",
  );
  const n9999 = await add("0");
  assert.equal(n9999.serial, "SN02610139999");
  const n10000 = await add("0");
  assert.equal(n10000.serial, "SN026101310000");
  await db.exec("set role authenticated");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    admin,
  ]);
  await db.query("select flow_delete('products',$1,1)", [n10000.id]);
  await assert.rejects(
    db.query("select * from flow_serial_counters"),
    /permission denied/,
  );
  await db.exec("reset role");
  assert.equal((await add("0")).serial, "SN026101310001");
  await assert.rejects(
    save({ ...base, id: randomUUID(), category: "0", code: "" }),
    /check constraint/,
  );
  assert.equal((await add("0")).serial, "SN026101310002");
  // Rerunning the migration must not reset a counter containing deleted records.
  await db.exec(migration);
  assert.equal((await add("0")).serial, "SN026101310003");
  const [a, b] = await Promise.all([add("1"), add("1")]);
  assert.notEqual(a.serial, b.serial);
  console.log(
    "PASS: migration preserves legacy serials, repeatable migration, per-category cumulative numbering across dates, 9999→10000, no deleted-number reuse, immutable source fields, rollback, concurrent queued registrations, restricted counter access",
  );
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
