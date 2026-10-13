const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs');const assert=require('node:assert/strict');
(async()=>{const db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;`);await db.exec(fs.readFileSync(require('node:path').join(__dirname,'../supabase/schema.sql'),'utf8'));
const admin='10000000-0000-4000-8000-000000000001',employee='10000000-0000-4000-8000-000000000002',stranger='10000000-0000-4000-8000-000000000003';await db.query('insert into auth.users(id) values ($1),($2),($3)',[admin,employee,stranger]);await db.query("insert into flow_members(user_id,role) values ($1,'admin'),($2,'employee')",[admin,employee]);
async function as(user,fn){await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);try{return await fn();}finally{await db.exec('reset role');}}
async function save(t,r,v=null){return (await db.query('select flow_save($1,$2::jsonb,$3) as result',[t,JSON.stringify(r),v])).rows[0].result;}
async function remove(t,id,v){return db.query('select flow_delete($1,$2::uuid,$3)',[t,id,v]);}
const pid='20000000-0000-4000-8000-000000000001',cid='30000000-0000-4000-8000-000000000001',sid='40000000-0000-4000-8000-000000000001',aid='50000000-0000-4000-8000-000000000001';
const p={id:pid,serial:'SN-1',code:'P-1',production:'2026-10-01',rail:'100mm',inspection:'합격',status:'재고',notes:''};
await as(admin,()=>save('products',p));
await as(admin,()=>save('customers',{id:cid,code:'C-1',name:'테스트',address:'서울',phone:'010',notes:''}));
await as(employee,()=>save('shipments',{id:sid,date:'2026-10-13',customerId:cid,name:'레일',productId:pid,notes:''}));
await as(employee,()=>assert.rejects(remove('shipments',sid,1),/ADMIN_REQUIRED/));
await as(employee,()=>assert.rejects(save('products',{...p,rail:'200mm'},99),/STALE_RECORD/));
await as(employee,()=>save('products',{...p,rail:'200mm'},1));
await as(employee,()=>assert.rejects(save('products',{...p,rail:'300mm'},1),/STALE_RECORD/));
await as(admin,()=>assert.rejects(save('products',{...p,id:'20000000-0000-4000-8000-000000000002',serial:'sn-1'}),/unique/));
await as(admin,()=>assert.rejects(save('shipments',{id:'40000000-0000-4000-8000-000000000002',date:'2026-10-13',customerId:cid,name:'레일',productId:pid,notes:''}),/ALREADY_SHIPPED/));
await as(admin,()=>assert.rejects(remove('products',pid,2),/foreign key/));
await as(admin,()=>assert.rejects(save('products',{...p,production:'2026-11-01'},2),/SHIPMENT_DATE/));
await as(admin,()=>save('service',{id:aid,productId:pid,model:'레일',received:'2026-10-13',symptom:'점검',action:'',owner:'김',completed:''}));
await as(admin,()=>assert.rejects(save('service',{id:aid,productId:pid,model:'레일',received:'2026-10-13',symptom:'점검',action:'',owner:'김',completed:'2026-10-01'},1),/check constraint/));
await as(stranger,()=>assert.rejects(db.query('select flow_snapshot()'),/STAFF_REQUIRED/));
await as(stranger,async()=>{assert.equal((await db.query('select * from customers')).rows.length,0);await assert.rejects(db.query("insert into flow_members(user_id,role) values ($1,'admin')",[stranger]),/permission denied/);});
await as(employee,()=>assert.rejects(db.query("delete from products where id=$1",[pid]),/permission denied/));
await db.exec('set role anon');await assert.rejects(db.query('select flow_snapshot()'),/permission denied/);await assert.rejects(db.query('select * from customers'),/permission denied/);await db.exec('reset role');
await as(admin,()=>remove('shipments',sid,1));assert.equal((await db.query('select count(*)::int as count from shipments')).rows[0].count,0);
console.log('PASS: PostgreSQL schema, employee CRUD/admin delete, RLS anonymous and nonstaff denial, direct writes/role escalation denial, duplicate and date constraints, FK restrictions, optimistic version conflict, atomic rollback');await db.close();})().catch(e=>{console.error(e);process.exit(1)});
