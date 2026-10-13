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
  // Test upgrade from the preceding automatic-only implementation.
  await db.exec(
    fs.readFileSync(
      path.join(__dirname, "../supabase/migrations/20261013_auto_serial.sql"),
      "utf8",
    ),
  );
  const admin = randomUUID();
  await db.query("insert into auth.users values($1)", [admin]);
  await db.query("insert into flow_members(user_id,role)values($1,'admin')", [
    admin,
  ]);
  const base = {
    category: "0",
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
  async function add(extra = {}) {
    const id = randomUUID();
    const result = await save({ ...base, id, ...extra });
    return result.data.products.find((p) => p.id === id);
  }
  const old = await add();
  assert.equal(old.serial, "SN02610130001");
  const migration = fs.readFileSync(
    path.join(__dirname, "../supabase/migrations/20261013_manual_serial.sql"),
    "utf8",
  );
  await db.exec(migration);
  const custom = await add({
    serial_mode: "manual",
    serial: "  OLD-CUSTOM-001  ",
  });
  assert.equal(custom.serial, "OLD-CUSTOM-001");
  assert.equal(custom.serial_generated, false);
  assert.equal((await add()).serial, "SN02610130002");
  const high = await add({ serial_mode: "manual", serial: "SN02610139999" });
  assert.equal(high.serial_generated, false);
  assert.equal((await add()).serial, "SN026101310000");
  await assert.rejects(
    add({ serial_mode: "manual", serial: "old-custom-001" }),
    /unique/,
  );
  await assert.rejects(
    add({ serial_mode: "manual", serial: "  " }),
    /MANUAL_SERIAL_REQUIRED/,
  );
  await assert.rejects(
    add({ serial_mode: "manual", serial: "SN12610130099" }),
    /SERIAL_CATEGORY_MISMATCH/,
  );
  await assert.rejects(
    add({ serial_mode: "unknown", serial: "X" }),
    /INVALID_SERIAL_MODE/,
  );
  const next = await add();
  assert.equal(next.serial, "SN026101310001");
  const change = await save({ ...custom, serial: "REPLACE" }, 1);
  assert.equal(
    change.data.products.find((p) => p.id === custom.id).serial,
    "OLD-CUSTOM-001",
  );
  await assert.rejects(
    save({ ...old, category: "1" }, 1),
    /SERIAL_SOURCE_IMMUTABLE/,
  );
  await db.exec(migration);
  assert.equal((await add()).serial, "SN026101310002");
  console.log(
    "PASS: automatic-only DB upgrade, manual trimmed serial preservation, case-insensitive duplicate denial, required/mode/category validation, manual sequence advancement through 9999, existing serial immutability, repeatable migration",
  );
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
