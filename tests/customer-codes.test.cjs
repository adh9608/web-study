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
    "drop trigger flow_customer_code_trigger on customers;alter table customers drop column code_generated;drop table flow_customer_counter;",
  );
  const legacy = randomUUID(),
    admin = randomUUID();
  await db.query(
    "insert into customers(id,code,name)values($1,'C0042','기존 고객')",
    [legacy],
  );
  const migration = fs.readFileSync(
    path.join(__dirname, "../supabase/migrations/20261013_customer_codes.sql"),
    "utf8",
  );
  await db.exec(migration);
  await db.exec(migration);
  assert.equal(
    (await db.query("select code from customers where id=$1", [legacy])).rows[0]
      .code,
    "C0042",
  );
  await db.query("insert into auth.users values($1)", [admin]);
  await db.query("insert into flow_members(user_id,role)values($1,'admin')", [
    admin,
  ]);
  async function rpc(record, v = null) {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      admin,
    ]);
    try {
      return (
        await db.query("select flow_save($1,$2::jsonb,$3)as result", [
          "customers",
          JSON.stringify(record),
          v,
        ])
      ).rows[0].result;
    } finally {
      await db.exec("reset role");
    }
  }
  const base = { name: "고객", address: "", phone: "", notes: "" };
  async function add(extra = {}) {
    const id = randomUUID();
    const s = await rpc({ ...base, id, customer_code_mode: "auto", ...extra });
    assert.equal(s.customer_code_auto, true);
    assert.equal(s.serial_manual, true);
    return s.data.customers.find((c) => c.id === id);
  }
  const auto = await add();
  assert.equal(auto.code, "C0043");
  assert.equal(auto.code_generated, true);
  const manual = await add({
    customer_code_mode: "manual",
    code: "  MY-CUSTOMER  ",
  });
  assert.equal(manual.code, "MY-CUSTOMER");
  assert.equal(manual.code_generated, false);
  assert.equal((await add()).code, "C0044");
  await assert.rejects(
    add({ customer_code_mode: "manual", code: "my-customer" }),
    /unique/,
  );
  await assert.rejects(
    add({ customer_code_mode: "manual", code: " " }),
    /MANUAL_CUSTOMER_CODE_REQUIRED/,
  );
  await assert.rejects(
    add({ customer_code_mode: "bad" }),
    /INVALID_CUSTOMER_CODE_MODE/,
  );
  await add({ customer_code_mode: "manual", code: "c9999" });
  const expanded = await add();
  assert.equal(expanded.code, "C10000");
  await db.exec("set role authenticated");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    admin,
  ]);
  await db.query("select flow_delete('customers',$1,1)", [expanded.id]);
  await assert.rejects(
    db.query("select * from flow_customer_counter"),
    /permission denied/,
  );
  await db.exec("reset role");
  assert.equal((await add()).code, "C10001");
  await assert.rejects(add({ name: "" }), /check constraint/);
  assert.equal((await add()).code, "C10002");
  const edited = (
    await rpc({ ...base, id: legacy, code: "REPLACED" }, 1)
  ).data.customers.find((c) => c.id === legacy);
  assert.equal(edited.code, "C0042");
  await db.exec(migration);
  assert.equal((await add()).code, "C10003");
  const [a, b] = await Promise.all([add(), add()]);
  assert.notEqual(a.code, b.code);
  console.log(
    "PASS: customer migration preservation/repeatability, auto/manual generation, duplicate validation, 9999→10000, deleted number nonreuse, rollback, immutable existing code, counter protection and previous serial capabilities",
  );
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
