-- Latest cumulative update: editable shipment display name independent of order model.
-- Latest cumulative update: unknown shipment dates, preserving existing history.
-- Latest cumulative update: unknown production dates for manual serial products.
-- Latest cumulative update: LOT linkage compares model only.
-- Latest cumulative update: manufacturing LOTs; preserves earlier business data.
-- Latest cumulative update: quantity shipments and A/S billing/payment.
-- Latest cumulative update: serial and quantity-managed sales order items.
-- Latest cumulative update: customer sales orders and shipment linkage.
-- Latest cumulative migration: customer codes plus previous serial capabilities.
-- Allow automatic or manual serials on existing FLOW installations: run this file in Supabase SQL Editor.
-- Keeps existing serials and relations. Does not reset counters when rerun.
begin;
select pg_advisory_xact_lock(83421671);
alter table public.products add column if not exists category text check(category in ('0','1','2'));
alter table public.products add column if not exists serial_generated boolean not null default false;
create table if not exists public.flow_serial_counters (
 category text primary key check(category in ('0','1','2')),
 last_number numeric(100,0) not null default 0 check(last_number>=0)
);
alter table public.flow_serial_counters enable row level security;
revoke all on public.flow_serial_counters from public,anon,authenticated;

-- Recover known sequence maxima without changing any existing serial.
update public.products set category=substring(upper(serial) from 3 for 1)
where category is null and upper(serial) ~ '^SN[012][0-9]{10,}$';
insert into public.flow_serial_counters(category,last_number)
select substring(upper(serial) from 3 for 1),max(substring(serial from 10)::numeric)
from public.products where upper(serial) ~ '^SN[012][0-9]{10,}$'
group by substring(upper(serial) from 3 for 1)
on conflict(category) do update set last_number=greatest(flow_serial_counters.last_number,excluded.last_number);
insert into public.flow_serial_counters(category,last_number) values('0',0),('1',0),('2',0) on conflict do nothing;

create or replace function public.flow_product_serial() returns trigger
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare seq numeric(100,0); generated text;
begin
 if TG_OP='UPDATE' then
  if new.serial is distinct from old.serial then raise exception 'SERIAL_IMMUTABLE'; end if;
  if old.serial_generated and (new.category is distinct from old.category or new.production is distinct from old.production) then raise exception 'SERIAL_SOURCE_IMMUTABLE'; end if;
  new.serial_generated:=old.serial_generated;
  return new;
 end if;
 if new.category is null or new.category not in ('0','1','2') then raise exception 'PRODUCT_CATEGORY_REQUIRED'; end if;
 if new.production is null then raise exception 'PRODUCTION_REQUIRED'; end if;
 if not new.serial_generated then
  new.serial:=btrim(new.serial);
  if new.serial is null or new.serial='' then raise exception 'MANUAL_SERIAL_REQUIRED'; end if;
  if upper(new.serial) ~ '^SN[012][0-9]{10,}$' then
   if substring(upper(new.serial) from 3 for 1)<>new.category then raise exception 'SERIAL_CATEGORY_MISMATCH'; end if;
   update public.flow_serial_counters set last_number=greatest(last_number,substring(new.serial from 10)::numeric) where category=new.category;
  end if;
  return new;
 end if;
 loop
  update public.flow_serial_counters set last_number=last_number+1 where category=new.category returning last_number into seq;
  if seq is null then raise exception 'SERIAL_COUNTER_MISSING'; end if;
  generated:='SN'||new.category||to_char(new.production,'YYMMDD')||lpad(seq::text,greatest(4,length(seq::text)),'0');
  exit when not exists(select 1 from public.products where lower(serial)=lower(generated));
 end loop;
 new.serial:=generated;
 new.serial_generated:=true;
 return new;
end $$;
revoke all on function public.flow_product_serial() from public,anon,authenticated;
drop trigger if exists flow_product_serial_trigger on public.products;
create trigger flow_product_serial_trigger before insert or update on public.products for each row execute function public.flow_product_serial();


create or replace function public.flow_snapshot() returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare member_role text;
begin
 member_role:=public.flow_role();
 if member_role is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 return jsonb_build_object('serial_auto',true,'serial_manual',true,'role',member_role,'data',jsonb_build_object(
  'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.serial) from public.products p),'[]'::jsonb),
  'customers',coalesce((select jsonb_agg(to_jsonb(c) order by c.name) from public.customers c),'[]'::jsonb),
  'shipments',coalesce((select jsonb_agg(to_jsonb(s) order by s.date desc,s.id) from public.shipments s),'[]'::jsonb),
  'service',coalesce((select jsonb_agg(to_jsonb(s) order by s.received desc,s.id) from public.service s),'[]'::jsonb)
 ));
end $$;
revoke all on function public.flow_snapshot() from public,anon;
grant execute on function public.flow_snapshot() to authenticated;

create or replace function public.flow_save(p_table text,p_record jsonb,p_expected_version integer default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare
 record_id uuid; current_version integer; col_list text; assignments text; payload jsonb;
 existing_product uuid; prod public.products;
begin
 if public.flow_role() is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 if p_table not in ('products','customers','shipments','service') or p_table is null then raise exception 'INVALID_TABLE'; end if;
 -- All application writes share a transaction lock: stock checks and writes stay atomic.
 perform pg_advisory_xact_lock(83421671);
 record_id:=(p_record->>'id')::uuid;
 if record_id is null then raise exception 'INVALID_ID'; end if;
 execute format('select version from public.%I where id=$1 for update',p_table) into current_version using record_id;
 if (p_expected_version is null and current_version is not null) or
    (p_expected_version is not null and current_version is distinct from p_expected_version) then
  raise exception 'STALE_RECORD';
 end if;
 payload:=p_record||jsonb_build_object('version',coalesce(current_version,0)+1);
 if p_table='products' then
  if current_version is null then
   if coalesce(p_record->>'serial_mode','auto') not in ('auto','manual') then raise exception 'INVALID_SERIAL_MODE'; end if;
   payload:=payload||jsonb_build_object('serial',case when p_record->>'serial_mode'='manual' then btrim(coalesce(p_record->>'serial','')) else '' end,'serial_generated',coalesce(p_record->>'serial_mode','auto')<>'manual');
  else
   select * into prod from public.products where id=record_id;
   -- Preserve the immutable identifier even when older clients omit it.
   payload:=payload||jsonb_build_object('serial',prod.serial,'serial_generated',prod.serial_generated);
  end if;
  if payload->>'category'='' or not payload?'category' then payload:=payload||jsonb_build_object('category',case when current_version is null then null else prod.category end); end if;
 end if;
 if p_table='service' and payload->>'completed'='' then payload:=payload||'{"completed":null}'::jsonb; end if;
 if p_table='shipments' then
  select * into prod from public.products where id=(payload->>'productId')::uuid for update;
  if prod.id is null then raise exception 'PRODUCT_MISSING' using errcode='23503'; end if;
  select "productId" into existing_product from public.shipments where id=record_id;
  if exists(select 1 from public.shipments where "productId"=prod.id and id<>record_id) or
     (prod.status<>'재고' and existing_product is distinct from prod.id) then raise exception 'ALREADY_SHIPPED'; end if;
  if (payload->>'date')::date < prod.production then raise exception 'SHIPMENT_DATE'; end if;
 end if;
 -- Column lists are read from allowlisted tables, never client-supplied SQL.
 select string_agg(format('%I',column_name),',' order by ordinal_position),
        string_agg(format('%I=excluded.%I',column_name,column_name),',' order by ordinal_position) filter(where column_name<>'id')
 into col_list,assignments
 from information_schema.columns where table_schema='public' and table_name=p_table;
 if current_version is null then
  execute format('insert into public.%1$I (%2$s) select %2$s from jsonb_populate_record(null::public.%1$I,$1)',p_table,col_list) using payload;
 else
  select string_agg(format('%I=r.%I',column_name,column_name),',' order by ordinal_position) into assignments
  from information_schema.columns where table_schema='public' and table_name=p_table and column_name<>'id';
  execute format('update public.%1$I t set %2$s from jsonb_populate_record(null::public.%1$I,$1) r where t.id=r.id',p_table,assignments) using payload;
 end if;
 if p_table='products' and exists(select 1 from public.shipments s join public.products p on p.id=s."productId" where p.id=record_id and s.date<p.production) then
  raise exception 'SHIPMENT_DATE';
 end if;
 return public.flow_snapshot();
end $$;
revoke all on function public.flow_save(text,jsonb,integer) from public,anon;
grant execute on function public.flow_save(text,jsonb,integer) to authenticated;



alter table public.customers add column if not exists code_generated boolean not null default false;
create table if not exists public.flow_customer_counter (
 id integer primary key check(id=1),
 last_number numeric(100,0) not null default 0 check(last_number>=0)
);
alter table public.flow_customer_counter enable row level security;
revoke all on public.flow_customer_counter from public,anon,authenticated;
insert into public.flow_customer_counter(id,last_number)
select 1,coalesce(max(substring(code from 2)::numeric),0) from public.customers where upper(code) ~ '^C[0-9]+$'
on conflict(id) do update set last_number=greatest(flow_customer_counter.last_number,excluded.last_number);

create or replace function public.flow_customer_code() returns trigger
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare seq numeric(100,0); generated text;
begin
 if TG_OP='UPDATE' then
  if new.code is distinct from old.code then raise exception 'CUSTOMER_CODE_IMMUTABLE'; end if;
  new.code_generated:=old.code_generated;
  return new;
 end if;
 if not new.code_generated then
  new.code:=btrim(new.code);
  if new.code is null or new.code='' then raise exception 'MANUAL_CUSTOMER_CODE_REQUIRED'; end if;
  if upper(new.code) ~ '^C[0-9]+$' then
   update public.flow_customer_counter set last_number=greatest(last_number,substring(new.code from 2)::numeric) where id=1;
  end if;
  return new;
 end if;
 loop
  update public.flow_customer_counter set last_number=last_number+1 where id=1 returning last_number into seq;
  if seq is null then raise exception 'CUSTOMER_COUNTER_MISSING'; end if;
  generated:='C'||lpad(seq::text,greatest(4,length(seq::text)),'0');
  exit when not exists(select 1 from public.customers where lower(code)=lower(generated));
 end loop;
 new.code:=generated;
 return new;
end $$;
revoke all on function public.flow_customer_code() from public,anon,authenticated;
drop trigger if exists flow_customer_code_trigger on public.customers;
create trigger flow_customer_code_trigger before insert or update on public.customers for each row execute function public.flow_customer_code();

create or replace function public.flow_snapshot() returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare member_role text;
begin
 member_role:=public.flow_role();
 if member_role is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 return jsonb_build_object('serial_auto',true,'serial_manual',true,'customer_code_auto',true,'role',member_role,'data',jsonb_build_object(
  'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.serial) from public.products p),'[]'::jsonb),
  'customers',coalesce((select jsonb_agg(to_jsonb(c) order by c.name) from public.customers c),'[]'::jsonb),
  'shipments',coalesce((select jsonb_agg(to_jsonb(s) order by s.date desc,s.id) from public.shipments s),'[]'::jsonb),
  'service',coalesce((select jsonb_agg(to_jsonb(s) order by s.received desc,s.id) from public.service s),'[]'::jsonb)
 ));
end $$;
revoke all on function public.flow_snapshot() from public,anon;
grant execute on function public.flow_snapshot() to authenticated;

create or replace function public.flow_save(p_table text,p_record jsonb,p_expected_version integer default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare
 record_id uuid; current_version integer; col_list text; assignments text; payload jsonb;
 existing_product uuid; prod public.products; cust public.customers;
begin
 if public.flow_role() is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 if p_table not in ('products','customers','shipments','service') or p_table is null then raise exception 'INVALID_TABLE'; end if;
 -- All application writes share a transaction lock: stock checks and writes stay atomic.
 perform pg_advisory_xact_lock(83421671);
 record_id:=(p_record->>'id')::uuid;
 if record_id is null then raise exception 'INVALID_ID'; end if;
 execute format('select version from public.%I where id=$1 for update',p_table) into current_version using record_id;
 if (p_expected_version is null and current_version is not null) or
    (p_expected_version is not null and current_version is distinct from p_expected_version) then
  raise exception 'STALE_RECORD';
 end if;
 payload:=p_record||jsonb_build_object('version',coalesce(current_version,0)+1);
 if p_table='products' then
  if current_version is null then
   if coalesce(p_record->>'serial_mode','auto') not in ('auto','manual') then raise exception 'INVALID_SERIAL_MODE'; end if;
   payload:=payload||jsonb_build_object('serial',case when p_record->>'serial_mode'='manual' then btrim(coalesce(p_record->>'serial','')) else '' end,'serial_generated',coalesce(p_record->>'serial_mode','auto')<>'manual');
  else
   select * into prod from public.products where id=record_id;
   -- Preserve the immutable identifier even when older clients omit it.
   payload:=payload||jsonb_build_object('serial',prod.serial,'serial_generated',prod.serial_generated);
  end if;
  if payload->>'category'='' or not payload?'category' then payload:=payload||jsonb_build_object('category',case when current_version is null then null else prod.category end); end if;
 end if;
 if p_table='customers' then
  if current_version is null then
   if coalesce(p_record->>'customer_code_mode','manual') not in ('auto','manual') then raise exception 'INVALID_CUSTOMER_CODE_MODE'; end if;
   payload:=payload||jsonb_build_object('code',case when p_record->>'customer_code_mode'='auto' then '' else btrim(coalesce(p_record->>'code','')) end,'code_generated',p_record->>'customer_code_mode'='auto');
   -- SQL NULL must not leave the mode flag unset for older clients.
   payload:=payload||jsonb_build_object('code_generated',coalesce(p_record->>'customer_code_mode','manual')='auto');
  else
   select * into cust from public.customers where id=record_id;
   payload:=payload||jsonb_build_object('code',cust.code,'code_generated',cust.code_generated);
  end if;
 end if;
 if p_table='service' and payload->>'completed'='' then payload:=payload||'{"completed":null}'::jsonb; end if;
 if p_table='shipments' then
  select * into prod from public.products where id=(payload->>'productId')::uuid for update;
  if prod.id is null then raise exception 'PRODUCT_MISSING' using errcode='23503'; end if;
  select "productId" into existing_product from public.shipments where id=record_id;
  if exists(select 1 from public.shipments where "productId"=prod.id and id<>record_id) or
     (prod.status<>'재고' and existing_product is distinct from prod.id) then raise exception 'ALREADY_SHIPPED'; end if;
  if (payload->>'date')::date < prod.production then raise exception 'SHIPMENT_DATE'; end if;
 end if;
 -- Column lists are read from allowlisted tables, never client-supplied SQL.
 select string_agg(format('%I',column_name),',' order by ordinal_position),
        string_agg(format('%I=excluded.%I',column_name,column_name),',' order by ordinal_position) filter(where column_name<>'id')
 into col_list,assignments
 from information_schema.columns where table_schema='public' and table_name=p_table;
 if current_version is null then
  execute format('insert into public.%1$I (%2$s) select %2$s from jsonb_populate_record(null::public.%1$I,$1)',p_table,col_list) using payload;
 else
  select string_agg(format('%I=r.%I',column_name,column_name),',' order by ordinal_position) into assignments
  from information_schema.columns where table_schema='public' and table_name=p_table and column_name<>'id';
  execute format('update public.%1$I t set %2$s from jsonb_populate_record(null::public.%1$I,$1) r where t.id=r.id',p_table,assignments) using payload;
 end if;
 if p_table='products' and exists(select 1 from public.shipments s join public.products p on p.id=s."productId" where p.id=record_id and s.date<p.production) then
  raise exception 'SHIPMENT_DATE';
 end if;
 return public.flow_snapshot();
end $$;
revoke all on function public.flow_save(text,jsonb,integer) from public,anon;
grant execute on function public.flow_save(text,jsonb,integer) to authenticated;



create table if not exists public.orders (
 id uuid primary key,
 number text not null unique,
 received date not null,
 "customerId" uuid not null references public.customers(id) on delete restrict,
 due date not null check(due>=received),
 stage text not null check(stage in ('접수','생산중','출고대기','취소')),
 notes text not null default '' check(length(notes)<=2000),
 version integer not null default 1 check(version>0)
);
create table if not exists public.order_items (
 id uuid primary key,
 "orderId" uuid not null references public.orders(id) on delete cascade,
 position integer not null,
 model text not null check(length(btrim(model)) between 1 and 200),
 specification text not null default '' check(length(specification)<=200),
 quantity integer not null check(quantity between 1 and 1000000)
);
create index if not exists order_items_parent on public.order_items("orderId");
alter table public.shipments add column if not exists "orderItemId" uuid references public.order_items(id) on delete restrict;
create index if not exists shipments_order_item on public.shipments("orderItemId");
create table if not exists public.flow_order_counter(id integer primary key check(id=1),last_number numeric(100,0) not null check(last_number>=0));
insert into public.flow_order_counter values(1,0) on conflict do nothing;
alter table public.flow_order_counter enable row level security;
revoke all on public.flow_order_counter from public,anon,authenticated;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
drop policy if exists staff_read on public.orders;
create policy staff_read on public.orders for select to authenticated using((select public.flow_role()) in ('admin','employee'));
drop policy if exists staff_read on public.order_items;
create policy staff_read on public.order_items for select to authenticated using((select public.flow_role()) in ('admin','employee'));
revoke all on public.orders,public.order_items from anon,authenticated;
grant select on public.orders,public.order_items to authenticated;

create or replace function public.flow_save_order(p_record jsonb,p_expected_version integer default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare
 oid uuid; old_order public.orders; seq numeric(100,0); number_value text;
 item jsonb; iid uuid; ids uuid[]:='{}'; old_item public.order_items; item_pos integer:=0; shipped_count integer;
begin
 if public.flow_role() is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(83421671);
 oid:=(p_record->>'id')::uuid;
 if oid is null then raise exception 'INVALID_ID'; end if;
 if jsonb_typeof(p_record->'items') is distinct from 'array' then raise exception 'ORDER_ITEMS_REQUIRED'; end if;
 if jsonb_array_length(p_record->'items') not between 1 and 100 then raise exception 'ORDER_ITEMS_REQUIRED'; end if;
 select * into old_order from public.orders where id=oid for update;
 if (p_expected_version is null and old_order.id is not null) or (p_expected_version is not null and old_order.version is distinct from p_expected_version) then raise exception 'STALE_RECORD'; end if;
 if old_order.id is null then
  update public.flow_order_counter set last_number=last_number+1 where id=1 returning last_number into seq;
  number_value:='SO'||lpad(seq::text,greatest(4,length(seq::text)),'0');
 else
  number_value:=old_order.number;
  if (p_record->>'customerId')::uuid is distinct from old_order."customerId" and exists(select 1 from public.shipments s join public.order_items i on i.id=s."orderItemId" where i."orderId"=oid) then raise exception 'ORDER_CUSTOMER_LOCKED'; end if;
  if exists(select 1 from public.shipments s join public.order_items i on i.id=s."orderItemId" where i."orderId"=oid and s.date<(p_record->>'received')::date) then raise exception 'ORDER_SHIPMENT_DATE'; end if;
 end if;
 insert into public.orders(id,number,received,"customerId",due,stage,notes,version)
 values(oid,number_value,(p_record->>'received')::date,(p_record->>'customerId')::uuid,(p_record->>'due')::date,p_record->>'stage',coalesce(p_record->>'notes',''),coalesce(old_order.version,0)+1)
 on conflict(id) do update set received=excluded.received,"customerId"=excluded."customerId",due=excluded.due,stage=excluded.stage,notes=excluded.notes,version=excluded.version;
 for item in select value from jsonb_array_elements(p_record->'items') loop
  item_pos:=item_pos+1;
  iid:=(item->>'id')::uuid;
  if iid is null or iid=any(ids) then raise exception 'INVALID_ORDER_ITEM'; end if;
  ids:=array_append(ids,iid);
  select * into old_item from public.order_items where id=iid;
  if old_item.id is not null and old_item."orderId"<>oid then raise exception 'INVALID_ORDER_ITEM'; end if;
  select count(*) into shipped_count from public.shipments where "orderItemId"=iid;
  if shipped_count>coalesce((item->>'quantity')::integer,0) then raise exception 'ORDER_QUANTITY_BELOW_SHIPPED'; end if;
  if shipped_count>0 and (old_item.model is distinct from btrim(item->>'model') or old_item.specification is distinct from btrim(coalesce(item->>'specification',''))) then raise exception 'ORDER_ITEM_LOCKED'; end if;
  insert into public.order_items(id,"orderId",position,model,specification,quantity)
  values(iid,oid,item_pos,btrim(item->>'model'),btrim(coalesce(item->>'specification','')),(item->>'quantity')::integer)
  on conflict(id) do update set position=excluded.position,model=excluded.model,specification=excluded.specification,quantity=excluded.quantity;
 end loop;
 -- FK RESTRICT prevents deleting an item already used in shipments.
 delete from public.order_items where "orderId"=oid and not(id=any(ids));
 return public.flow_snapshot();
end $$;
revoke all on function public.flow_save_order(jsonb,integer) from public,anon;
grant execute on function public.flow_save_order(jsonb,integer) to authenticated;

create or replace function public.flow_order_shipment_check() returns trigger
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare item public.order_items; parent public.orders; prod public.products; shipped_count integer;
begin
 if new."orderItemId" is null then return new; end if;
 select * into item from public.order_items where id=new."orderItemId";
 if item.id is null then raise exception 'INVALID_ORDER_ITEM'; end if;
 select * into parent from public.orders where id=item."orderId";
 if parent.stage='취소' and (TG_OP='INSERT' or new."orderItemId" is distinct from old."orderItemId") then raise exception 'ORDER_CANCELLED'; end if;
 if parent."customerId"<>new."customerId" then raise exception 'ORDER_CUSTOMER_MISMATCH'; end if;
 if new.date<parent.received then raise exception 'ORDER_SHIPMENT_DATE'; end if;
 select * into prod from public.products where id=new."productId";
 if lower(btrim(prod.code))<>lower(btrim(item.model)) or lower(btrim(prod.rail))<>lower(btrim(item.specification)) then raise exception 'ORDER_PRODUCT_MISMATCH'; end if;
 select count(*) into shipped_count from public.shipments where "orderItemId"=item.id and id<>new.id;
 if shipped_count>=item.quantity then raise exception 'ORDER_OVERSHIP'; end if;
 new.name:=item.model;
 return new;
end $$;
revoke all on function public.flow_order_shipment_check() from public,anon,authenticated;
drop trigger if exists flow_order_shipment_guard on public.shipments;
create trigger flow_order_shipment_guard before insert or update on public.shipments for each row execute function public.flow_order_shipment_check();

create or replace function public.flow_order_shipment_version() returns trigger
language plpgsql security definer set search_path=pg_catalog,public
as $$
begin
 update public.orders set version=version+1 where id in(select "orderId" from public.order_items where id in(case when TG_OP<>'INSERT' then old."orderItemId" end,case when TG_OP<>'DELETE' then new."orderItemId" end));
 return null;
end $$;
revoke all on function public.flow_order_shipment_version() from public,anon,authenticated;
drop trigger if exists flow_order_version on public.shipments;
create trigger flow_order_version after insert or update or delete on public.shipments for each row execute function public.flow_order_shipment_version();

create or replace function public.flow_snapshot() returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare member_role text;
begin
 member_role:=public.flow_role();
 if member_role is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 return jsonb_build_object('serial_auto',true,'serial_manual',true,'customer_code_auto',true,'orders_enabled',true,'role',member_role,'data',jsonb_build_object(
  'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.serial) from public.products p),'[]'::jsonb),
  'customers',coalesce((select jsonb_agg(to_jsonb(c) order by c.name) from public.customers c),'[]'::jsonb),
  'shipments',coalesce((select jsonb_agg(to_jsonb(s) order by s.date desc,s.id) from public.shipments s),'[]'::jsonb),
  'orders',coalesce((select jsonb_agg(to_jsonb(o)||jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object('delivered',(select count(*) from public.shipments s where s."orderItemId"=i.id)) order by i.position) from public.order_items i where i."orderId"=o.id),'[]'::jsonb)) order by o.received desc,o.number desc) from public.orders o),'[]'::jsonb),
  'service',coalesce((select jsonb_agg(to_jsonb(s) order by s.received desc,s.id) from public.service s),'[]'::jsonb)
 ));
end $$;
revoke all on function public.flow_snapshot() from public,anon;
grant execute on function public.flow_snapshot() to authenticated;

create or replace function public.flow_save(p_table text,p_record jsonb,p_expected_version integer default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare
 record_id uuid; current_version integer; col_list text; assignments text; payload jsonb;
 existing_product uuid; prod public.products; cust public.customers;
begin
 if public.flow_role() is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 if p_table='orders' then return public.flow_save_order(p_record,p_expected_version); end if;
 if p_table not in ('products','customers','shipments','service') or p_table is null then raise exception 'INVALID_TABLE'; end if;
 -- All application writes share a transaction lock: stock checks and writes stay atomic.
 perform pg_advisory_xact_lock(83421671);
 record_id:=(p_record->>'id')::uuid;
 if record_id is null then raise exception 'INVALID_ID'; end if;
 execute format('select version from public.%I where id=$1 for update',p_table) into current_version using record_id;
 if (p_expected_version is null and current_version is not null) or
    (p_expected_version is not null and current_version is distinct from p_expected_version) then
  raise exception 'STALE_RECORD';
 end if;
 payload:=p_record||jsonb_build_object('version',coalesce(current_version,0)+1);
 if p_table='products' then
  if current_version is null then
   if coalesce(p_record->>'serial_mode','auto') not in ('auto','manual') then raise exception 'INVALID_SERIAL_MODE'; end if;
   payload:=payload||jsonb_build_object('serial',case when p_record->>'serial_mode'='manual' then btrim(coalesce(p_record->>'serial','')) else '' end,'serial_generated',coalesce(p_record->>'serial_mode','auto')<>'manual');
  else
   select * into prod from public.products where id=record_id;
   -- Preserve the immutable identifier even when older clients omit it.
   payload:=payload||jsonb_build_object('serial',prod.serial,'serial_generated',prod.serial_generated);
  end if;
  if payload->>'category'='' or not payload?'category' then payload:=payload||jsonb_build_object('category',case when current_version is null then null else prod.category end); end if;
 end if;
 if p_table='customers' then
  if current_version is null then
   if coalesce(p_record->>'customer_code_mode','manual') not in ('auto','manual') then raise exception 'INVALID_CUSTOMER_CODE_MODE'; end if;
   payload:=payload||jsonb_build_object('code',case when p_record->>'customer_code_mode'='auto' then '' else btrim(coalesce(p_record->>'code','')) end,'code_generated',p_record->>'customer_code_mode'='auto');
   -- SQL NULL must not leave the mode flag unset for older clients.
   payload:=payload||jsonb_build_object('code_generated',coalesce(p_record->>'customer_code_mode','manual')='auto');
  else
   select * into cust from public.customers where id=record_id;
   payload:=payload||jsonb_build_object('code',cust.code,'code_generated',cust.code_generated);
  end if;
 end if;
 if p_table='service' and payload->>'completed'='' then payload:=payload||'{"completed":null}'::jsonb; end if;
 if p_table='shipments' then
  if not payload?'orderItemId' and current_version is not null then
   payload:=payload||jsonb_build_object('orderItemId',(select "orderItemId" from public.shipments where id=record_id));
  end if;
  if payload->>'orderItemId'='' then payload:=payload||jsonb_build_object('orderItemId',null); end if;
  select * into prod from public.products where id=(payload->>'productId')::uuid for update;
  if prod.id is null then raise exception 'PRODUCT_MISSING' using errcode='23503'; end if;
  select "productId" into existing_product from public.shipments where id=record_id;
  if exists(select 1 from public.shipments where "productId"=prod.id and id<>record_id) or
     (prod.status<>'재고' and existing_product is distinct from prod.id) then raise exception 'ALREADY_SHIPPED'; end if;
  if (payload->>'date')::date < prod.production then raise exception 'SHIPMENT_DATE'; end if;
 end if;
 -- Column lists are read from allowlisted tables, never client-supplied SQL.
 select string_agg(format('%I',column_name),',' order by ordinal_position),
        string_agg(format('%I=excluded.%I',column_name,column_name),',' order by ordinal_position) filter(where column_name<>'id')
 into col_list,assignments
 from information_schema.columns where table_schema='public' and table_name=p_table;
 if current_version is null then
  execute format('insert into public.%1$I (%2$s) select %2$s from jsonb_populate_record(null::public.%1$I,$1)',p_table,col_list) using payload;
 else
  select string_agg(format('%I=r.%I',column_name,column_name),',' order by ordinal_position) into assignments
  from information_schema.columns where table_schema='public' and table_name=p_table and column_name<>'id';
  execute format('update public.%1$I t set %2$s from jsonb_populate_record(null::public.%1$I,$1) r where t.id=r.id',p_table,assignments) using payload;
 end if;
 if p_table='products' and exists(select 1 from public.shipments s join public.products p on p.id=s."productId" where p.id=record_id and s.date<p.production) then
  raise exception 'SHIPMENT_DATE';
 end if;
 if p_table='products' and exists(select 1 from public.shipments s join public.order_items i on i.id=s."orderItemId" join public.products p on p.id=s."productId" where p.id=record_id and (lower(btrim(p.code))<>lower(btrim(i.model)) or lower(btrim(p.rail))<>lower(btrim(i.specification)))) then raise exception 'ORDER_PRODUCT_MISMATCH'; end if;
 return public.flow_snapshot();
end $$;
revoke all on function public.flow_save(text,jsonb,integer) from public,anon;
grant execute on function public.flow_save(text,jsonb,integer) to authenticated;

create or replace function public.flow_delete(p_table text,p_id uuid,p_expected_version integer) returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare current_version integer;
begin
 if public.flow_role() is distinct from 'admin' then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
 if p_table not in ('products','customers','shipments','service','orders') or p_table is null then raise exception 'INVALID_TABLE'; end if;
 perform pg_advisory_xact_lock(83421671);
 execute format('select version from public.%I where id=$1 for update',p_table) into current_version using p_id;
 if current_version is null or current_version is distinct from p_expected_version then raise exception 'STALE_RECORD'; end if;
 execute format('delete from public.%I where id=$1',p_table) using p_id;
 return public.flow_snapshot();
end $$;
revoke all on function public.flow_delete(text,uuid,integer) from public,anon;
grant execute on function public.flow_delete(text,uuid,integer) to authenticated;


alter table public.order_items add column if not exists tracking_mode text not null default 'serial' check(tracking_mode in ('serial','quantity'));
alter table public.shipments add column if not exists quantity integer not null default 1 check(quantity between 1 and 1000000);
alter table public.shipments alter column "productId" drop not null;
create or replace function public.flow_save_order(p_record jsonb,p_expected_version integer default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare
 oid uuid; old_order public.orders; seq numeric(100,0); number_value text;
 item jsonb; iid uuid; ids uuid[]:='{}'; old_item public.order_items; item_pos integer:=0; shipped_count integer;
begin
 if public.flow_role() is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(83421671);
 oid:=(p_record->>'id')::uuid;
 if oid is null then raise exception 'INVALID_ID'; end if;
 if jsonb_typeof(p_record->'items') is distinct from 'array' then raise exception 'ORDER_ITEMS_REQUIRED'; end if;
 if jsonb_array_length(p_record->'items') not between 1 and 100 then raise exception 'ORDER_ITEMS_REQUIRED'; end if;
 select * into old_order from public.orders where id=oid for update;
 if (p_expected_version is null and old_order.id is not null) or (p_expected_version is not null and old_order.version is distinct from p_expected_version) then raise exception 'STALE_RECORD'; end if;
 if old_order.id is null then
  update public.flow_order_counter set last_number=last_number+1 where id=1 returning last_number into seq;
  number_value:='SO'||lpad(seq::text,greatest(4,length(seq::text)),'0');
 else
  number_value:=old_order.number;
  if (p_record->>'customerId')::uuid is distinct from old_order."customerId" and exists(select 1 from public.shipments s join public.order_items i on i.id=s."orderItemId" where i."orderId"=oid) then raise exception 'ORDER_CUSTOMER_LOCKED'; end if;
  if exists(select 1 from public.shipments s join public.order_items i on i.id=s."orderItemId" where i."orderId"=oid and s.date<(p_record->>'received')::date) then raise exception 'ORDER_SHIPMENT_DATE'; end if;
 end if;
 insert into public.orders(id,number,received,"customerId",due,stage,notes,version)
 values(oid,number_value,(p_record->>'received')::date,(p_record->>'customerId')::uuid,(p_record->>'due')::date,p_record->>'stage',coalesce(p_record->>'notes',''),coalesce(old_order.version,0)+1)
 on conflict(id) do update set received=excluded.received,"customerId"=excluded."customerId",due=excluded.due,stage=excluded.stage,notes=excluded.notes,version=excluded.version;
 for item in select value from jsonb_array_elements(p_record->'items') loop
  item_pos:=item_pos+1;
  iid:=(item->>'id')::uuid;
  if iid is null or iid=any(ids) then raise exception 'INVALID_ORDER_ITEM'; end if;
  ids:=array_append(ids,iid);
  select * into old_item from public.order_items where id=iid;
  if old_item.id is not null and old_item."orderId"<>oid then raise exception 'INVALID_ORDER_ITEM'; end if;
  select coalesce(sum(quantity),0) into shipped_count from public.shipments where "orderItemId"=iid;
  if shipped_count>coalesce((item->>'quantity')::integer,0) then raise exception 'ORDER_QUANTITY_BELOW_SHIPPED'; end if;
  if shipped_count>0 and old_item.tracking_mode is distinct from coalesce(item->>'tracking_mode',old_item.tracking_mode) then raise exception 'ORDER_TRACKING_LOCKED'; end if;
  if shipped_count>0 and (old_item.model is distinct from btrim(item->>'model') or old_item.specification is distinct from btrim(coalesce(item->>'specification',''))) then raise exception 'ORDER_ITEM_LOCKED'; end if;
  insert into public.order_items(id,"orderId",position,tracking_mode,model,specification,quantity)
  values(iid,oid,item_pos,coalesce(item->>'tracking_mode',old_item.tracking_mode,'serial'),btrim(item->>'model'),btrim(coalesce(item->>'specification','')),(item->>'quantity')::integer)
  on conflict(id) do update set position=excluded.position,tracking_mode=excluded.tracking_mode,model=excluded.model,specification=excluded.specification,quantity=excluded.quantity;
 end loop;
 -- FK RESTRICT prevents deleting an item already used in shipments.
 delete from public.order_items where "orderId"=oid and not(id=any(ids));
 return public.flow_snapshot();
end $$;
revoke all on function public.flow_save_order(jsonb,integer) from public,anon;
grant execute on function public.flow_save_order(jsonb,integer) to authenticated;

create or replace function public.flow_order_shipment_check() returns trigger
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare item public.order_items; parent public.orders; prod public.products; shipped_count integer;
begin
 if new.quantity is null or new.quantity<1 or new.quantity>1000000 then raise exception 'INVALID_SHIPMENT_QUANTITY'; end if;
 if new."orderItemId" is null then
  if new."productId" is null or new.quantity<>1 then raise exception 'SERIAL_SHIPMENT_REQUIRED'; end if;
  return new;
 end if;
 select * into item from public.order_items where id=new."orderItemId";
 if item.id is null then raise exception 'INVALID_ORDER_ITEM'; end if;
 select * into parent from public.orders where id=item."orderId";
 if parent.stage='취소' and (TG_OP='INSERT' or new."orderItemId" is distinct from old."orderItemId") then raise exception 'ORDER_CANCELLED'; end if;
 if parent."customerId"<>new."customerId" then raise exception 'ORDER_CUSTOMER_MISMATCH'; end if;
 if new.date<parent.received then raise exception 'ORDER_SHIPMENT_DATE'; end if;
 if item.tracking_mode='serial' then
  if new."productId" is null or new.quantity<>1 then raise exception 'SERIAL_SHIPMENT_REQUIRED'; end if;
 else
  if new."productId" is not null then raise exception 'QUANTITY_SHIPMENT_NO_SERIAL'; end if;
 end if;
 select * into prod from public.products where id=new."productId";
 if item.tracking_mode='serial' and (lower(btrim(prod.code))<>lower(btrim(item.model)) or lower(btrim(prod.rail))<>lower(btrim(item.specification))) then raise exception 'ORDER_PRODUCT_MISMATCH'; end if;
 select coalesce(sum(quantity),0) into shipped_count from public.shipments where "orderItemId"=item.id and id<>new.id;
 if shipped_count+new.quantity>item.quantity then raise exception 'ORDER_OVERSHIP'; end if;
 new.name:=item.model;
 return new;
end $$;
revoke all on function public.flow_order_shipment_check() from public,anon,authenticated;
drop trigger if exists flow_order_shipment_guard on public.shipments;
create trigger flow_order_shipment_guard before insert or update on public.shipments for each row execute function public.flow_order_shipment_check();

create or replace function public.flow_order_shipment_version() returns trigger
language plpgsql security definer set search_path=pg_catalog,public
as $$
begin
 update public.orders set version=version+1 where id in(select "orderId" from public.order_items where id in(case when TG_OP<>'INSERT' then old."orderItemId" end,case when TG_OP<>'DELETE' then new."orderItemId" end));
 return null;
end $$;
revoke all on function public.flow_order_shipment_version() from public,anon,authenticated;
drop trigger if exists flow_order_version on public.shipments;
create trigger flow_order_version after insert or update or delete on public.shipments for each row execute function public.flow_order_shipment_version();

create or replace function public.flow_snapshot() returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare member_role text;
begin
 member_role:=public.flow_role();
 if member_role is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 return jsonb_build_object('serial_auto',true,'serial_manual',true,'customer_code_auto',true,'orders_enabled',true,'quantity_management',true,'role',member_role,'data',jsonb_build_object(
  'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.serial) from public.products p),'[]'::jsonb),
  'customers',coalesce((select jsonb_agg(to_jsonb(c) order by c.name) from public.customers c),'[]'::jsonb),
  'shipments',coalesce((select jsonb_agg(to_jsonb(s) order by s.date desc,s.id) from public.shipments s),'[]'::jsonb),
  'orders',coalesce((select jsonb_agg(to_jsonb(o)||jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object('delivered',(select coalesce(sum(s.quantity),0) from public.shipments s where s."orderItemId"=i.id)) order by i.position) from public.order_items i where i."orderId"=o.id),'[]'::jsonb)) order by o.received desc,o.number desc) from public.orders o),'[]'::jsonb),
  'service',coalesce((select jsonb_agg(to_jsonb(s) order by s.received desc,s.id) from public.service s),'[]'::jsonb)
 ));
end $$;
revoke all on function public.flow_snapshot() from public,anon;
grant execute on function public.flow_snapshot() to authenticated;

create or replace function public.flow_save(p_table text,p_record jsonb,p_expected_version integer default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare
 record_id uuid; current_version integer; col_list text; assignments text; payload jsonb;
 existing_product uuid; prod public.products; cust public.customers;
begin
 if public.flow_role() is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 if p_table='orders' then return public.flow_save_order(p_record,p_expected_version); end if;
 if p_table not in ('products','customers','shipments','service') or p_table is null then raise exception 'INVALID_TABLE'; end if;
 -- All application writes share a transaction lock: stock checks and writes stay atomic.
 perform pg_advisory_xact_lock(83421671);
 record_id:=(p_record->>'id')::uuid;
 if record_id is null then raise exception 'INVALID_ID'; end if;
 execute format('select version from public.%I where id=$1 for update',p_table) into current_version using record_id;
 if (p_expected_version is null and current_version is not null) or
    (p_expected_version is not null and current_version is distinct from p_expected_version) then
  raise exception 'STALE_RECORD';
 end if;
 payload:=p_record||jsonb_build_object('version',coalesce(current_version,0)+1);
 if p_table='products' then
  if current_version is null then
   if coalesce(p_record->>'serial_mode','auto') not in ('auto','manual') then raise exception 'INVALID_SERIAL_MODE'; end if;
   payload:=payload||jsonb_build_object('serial',case when p_record->>'serial_mode'='manual' then btrim(coalesce(p_record->>'serial','')) else '' end,'serial_generated',coalesce(p_record->>'serial_mode','auto')<>'manual');
  else
   select * into prod from public.products where id=record_id;
   -- Preserve the immutable identifier even when older clients omit it.
   payload:=payload||jsonb_build_object('serial',prod.serial,'serial_generated',prod.serial_generated);
  end if;
  if payload->>'category'='' or not payload?'category' then payload:=payload||jsonb_build_object('category',case when current_version is null then null else prod.category end); end if;
 end if;
 if p_table='customers' then
  if current_version is null then
   if coalesce(p_record->>'customer_code_mode','manual') not in ('auto','manual') then raise exception 'INVALID_CUSTOMER_CODE_MODE'; end if;
   payload:=payload||jsonb_build_object('code',case when p_record->>'customer_code_mode'='auto' then '' else btrim(coalesce(p_record->>'code','')) end,'code_generated',p_record->>'customer_code_mode'='auto');
   -- SQL NULL must not leave the mode flag unset for older clients.
   payload:=payload||jsonb_build_object('code_generated',coalesce(p_record->>'customer_code_mode','manual')='auto');
  else
   select * into cust from public.customers where id=record_id;
   payload:=payload||jsonb_build_object('code',cust.code,'code_generated',cust.code_generated);
  end if;
 end if;
 if p_table='service' and payload->>'completed'='' then payload:=payload||'{"completed":null}'::jsonb; end if;
 if p_table='shipments' then
  if not payload?'orderItemId' and current_version is not null then
   payload:=payload||jsonb_build_object('orderItemId',(select "orderItemId" from public.shipments where id=record_id));
  end if;
  if payload->>'orderItemId'='' then payload:=payload||jsonb_build_object('orderItemId',null); end if;
  if payload->>'productId'='' then payload:=payload||jsonb_build_object('productId',null); end if;
  if not payload?'quantity' then payload:=payload||jsonb_build_object('quantity',coalesce((select quantity from public.shipments where id=record_id),1)); end if;
  if payload->>'productId' is not null then
  select * into prod from public.products where id=(payload->>'productId')::uuid for update;
  if prod.id is null then raise exception 'PRODUCT_MISSING' using errcode='23503'; end if;
  select "productId" into existing_product from public.shipments where id=record_id;
  if exists(select 1 from public.shipments where "productId"=prod.id and id<>record_id) or
     (prod.status<>'재고' and existing_product is distinct from prod.id) then raise exception 'ALREADY_SHIPPED'; end if;
  if (payload->>'date')::date < prod.production then raise exception 'SHIPMENT_DATE'; end if;
  end if;
 end if;
 -- Column lists are read from allowlisted tables, never client-supplied SQL.
 select string_agg(format('%I',column_name),',' order by ordinal_position),
        string_agg(format('%I=excluded.%I',column_name,column_name),',' order by ordinal_position) filter(where column_name<>'id')
 into col_list,assignments
 from information_schema.columns where table_schema='public' and table_name=p_table;
 if current_version is null then
  execute format('insert into public.%1$I (%2$s) select %2$s from jsonb_populate_record(null::public.%1$I,$1)',p_table,col_list) using payload;
 else
  select string_agg(format('%I=r.%I',column_name,column_name),',' order by ordinal_position) into assignments
  from information_schema.columns where table_schema='public' and table_name=p_table and column_name<>'id';
  execute format('update public.%1$I t set %2$s from jsonb_populate_record(null::public.%1$I,$1) r where t.id=r.id',p_table,assignments) using payload;
 end if;
 if p_table='products' and exists(select 1 from public.shipments s join public.products p on p.id=s."productId" where p.id=record_id and s.date<p.production) then
  raise exception 'SHIPMENT_DATE';
 end if;
 if p_table='products' and exists(select 1 from public.shipments s join public.order_items i on i.id=s."orderItemId" join public.products p on p.id=s."productId" where p.id=record_id and (lower(btrim(p.code))<>lower(btrim(i.model)) or lower(btrim(p.rail))<>lower(btrim(i.specification)))) then raise exception 'ORDER_PRODUCT_MISMATCH'; end if;
 return public.flow_snapshot();
end $$;
revoke all on function public.flow_save(text,jsonb,integer) from public,anon;
grant execute on function public.flow_save(text,jsonb,integer) to authenticated;

create or replace function public.flow_delete(p_table text,p_id uuid,p_expected_version integer) returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare current_version integer;
begin
 if public.flow_role() is distinct from 'admin' then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
 if p_table not in ('products','customers','shipments','service','orders') or p_table is null then raise exception 'INVALID_TABLE'; end if;
 perform pg_advisory_xact_lock(83421671);
 execute format('select version from public.%I where id=$1 for update',p_table) into current_version using p_id;
 if current_version is null or current_version is distinct from p_expected_version then raise exception 'STALE_RECORD'; end if;
 execute format('delete from public.%I where id=$1',p_table) using p_id;
 return public.flow_snapshot();
end $$;
revoke all on function public.flow_delete(text,uuid,integer) from public,anon;
grant execute on function public.flow_delete(text,uuid,integer) to authenticated;


alter table public.service add column if not exists "billingType" text not null default '미정';
alter table public.service add column if not exists "chargeAmount" bigint not null default 0;
alter table public.service add column if not exists "paidAmount" bigint not null default 0;
alter table public.service add column if not exists "paidDate" date;
alter table public.service drop constraint if exists service_billing_valid;
alter table public.service add constraint service_billing_valid check(
 "billingType" in ('미정','유상','무상') and "chargeAmount" between 0 and 1000000000000
 and "paidAmount">=0 and "paidAmount"<="chargeAmount"
 and ("billingType"='유상' or ("chargeAmount"=0 and "paidAmount"=0 and "paidDate" is null))
 and (("paidAmount"=0 and "paidDate" is null) or ("paidAmount">0 and "paidDate" is not null))
);
create or replace function public.flow_snapshot() returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare member_role text;
begin
 member_role:=public.flow_role();
 if member_role is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 return jsonb_build_object('serial_auto',true,'serial_manual',true,'customer_code_auto',true,'orders_enabled',true,'quantity_management',true,'service_billing',true,'role',member_role,'data',jsonb_build_object(
  'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.serial) from public.products p),'[]'::jsonb),
  'customers',coalesce((select jsonb_agg(to_jsonb(c) order by c.name) from public.customers c),'[]'::jsonb),
  'shipments',coalesce((select jsonb_agg(to_jsonb(s) order by s.date desc,s.id) from public.shipments s),'[]'::jsonb),
  'orders',coalesce((select jsonb_agg(to_jsonb(o)||jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object('delivered',(select coalesce(sum(s.quantity),0) from public.shipments s where s."orderItemId"=i.id)) order by i.position) from public.order_items i where i."orderId"=o.id),'[]'::jsonb)) order by o.received desc,o.number desc) from public.orders o),'[]'::jsonb),
  'service',coalesce((select jsonb_agg(to_jsonb(s) order by s.received desc,s.id) from public.service s),'[]'::jsonb)
 ));
end $$;
revoke all on function public.flow_snapshot() from public,anon;
grant execute on function public.flow_snapshot() to authenticated;

create or replace function public.flow_save(p_table text,p_record jsonb,p_expected_version integer default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare
 record_id uuid; current_version integer; col_list text; assignments text; payload jsonb;
 existing_product uuid; prod public.products; cust public.customers; svc public.service;
begin
 if public.flow_role() is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 if p_table='orders' then return public.flow_save_order(p_record,p_expected_version); end if;
 if p_table not in ('products','customers','shipments','service') or p_table is null then raise exception 'INVALID_TABLE'; end if;
 -- All application writes share a transaction lock: stock checks and writes stay atomic.
 perform pg_advisory_xact_lock(83421671);
 record_id:=(p_record->>'id')::uuid;
 if record_id is null then raise exception 'INVALID_ID'; end if;
 execute format('select version from public.%I where id=$1 for update',p_table) into current_version using record_id;
 if (p_expected_version is null and current_version is not null) or
    (p_expected_version is not null and current_version is distinct from p_expected_version) then
  raise exception 'STALE_RECORD';
 end if;
 payload:=p_record||jsonb_build_object('version',coalesce(current_version,0)+1);
 if p_table='products' then
  if current_version is null then
   if coalesce(p_record->>'serial_mode','auto') not in ('auto','manual') then raise exception 'INVALID_SERIAL_MODE'; end if;
   payload:=payload||jsonb_build_object('serial',case when p_record->>'serial_mode'='manual' then btrim(coalesce(p_record->>'serial','')) else '' end,'serial_generated',coalesce(p_record->>'serial_mode','auto')<>'manual');
  else
   select * into prod from public.products where id=record_id;
   -- Preserve the immutable identifier even when older clients omit it.
   payload:=payload||jsonb_build_object('serial',prod.serial,'serial_generated',prod.serial_generated);
  end if;
  if payload->>'category'='' or not payload?'category' then payload:=payload||jsonb_build_object('category',case when current_version is null then null else prod.category end); end if;
 end if;
 if p_table='customers' then
  if current_version is null then
   if coalesce(p_record->>'customer_code_mode','manual') not in ('auto','manual') then raise exception 'INVALID_CUSTOMER_CODE_MODE'; end if;
   payload:=payload||jsonb_build_object('code',case when p_record->>'customer_code_mode'='auto' then '' else btrim(coalesce(p_record->>'code','')) end,'code_generated',p_record->>'customer_code_mode'='auto');
   -- SQL NULL must not leave the mode flag unset for older clients.
   payload:=payload||jsonb_build_object('code_generated',coalesce(p_record->>'customer_code_mode','manual')='auto');
  else
   select * into cust from public.customers where id=record_id;
   payload:=payload||jsonb_build_object('code',cust.code,'code_generated',cust.code_generated);
  end if;
 end if;
 if p_table='service' then
  if current_version is not null then select * into svc from public.service where id=record_id; end if;
  payload:=payload||jsonb_build_object(
   'billingType',case when payload?'billingType' then payload->'billingType' else to_jsonb(coalesce(svc."billingType",'미정')) end,
   'chargeAmount',case when payload?'chargeAmount' then payload->'chargeAmount' else to_jsonb(coalesce(svc."chargeAmount",0)) end,
   'paidAmount',case when payload?'paidAmount' then payload->'paidAmount' else to_jsonb(coalesce(svc."paidAmount",0)) end,
   'paidDate',case when payload?'paidDate' then payload->'paidDate' else to_jsonb(svc."paidDate") end);
  if payload->>'paidDate'='' then payload:=payload||jsonb_build_object('paidDate',null); end if;
 end if;
 if p_table='service' and payload->>'completed'='' then payload:=payload||'{"completed":null}'::jsonb; end if;
 if p_table='shipments' then
  if not payload?'orderItemId' and current_version is not null then
   payload:=payload||jsonb_build_object('orderItemId',(select "orderItemId" from public.shipments where id=record_id));
  end if;
  if payload->>'orderItemId'='' then payload:=payload||jsonb_build_object('orderItemId',null); end if;
  if payload->>'productId'='' then payload:=payload||jsonb_build_object('productId',null); end if;
  if not payload?'quantity' then payload:=payload||jsonb_build_object('quantity',coalesce((select quantity from public.shipments where id=record_id),1)); end if;
  if payload->>'productId' is not null then
  select * into prod from public.products where id=(payload->>'productId')::uuid for update;
  if prod.id is null then raise exception 'PRODUCT_MISSING' using errcode='23503'; end if;
  select "productId" into existing_product from public.shipments where id=record_id;
  if exists(select 1 from public.shipments where "productId"=prod.id and id<>record_id) or
     (prod.status<>'재고' and existing_product is distinct from prod.id) then raise exception 'ALREADY_SHIPPED'; end if;
  if (payload->>'date')::date < prod.production then raise exception 'SHIPMENT_DATE'; end if;
  end if;
 end if;
 -- Column lists are read from allowlisted tables, never client-supplied SQL.
 select string_agg(format('%I',column_name),',' order by ordinal_position),
        string_agg(format('%I=excluded.%I',column_name,column_name),',' order by ordinal_position) filter(where column_name<>'id')
 into col_list,assignments
 from information_schema.columns where table_schema='public' and table_name=p_table;
 if current_version is null then
  execute format('insert into public.%1$I (%2$s) select %2$s from jsonb_populate_record(null::public.%1$I,$1)',p_table,col_list) using payload;
 else
  select string_agg(format('%I=r.%I',column_name,column_name),',' order by ordinal_position) into assignments
  from information_schema.columns where table_schema='public' and table_name=p_table and column_name<>'id';
  execute format('update public.%1$I t set %2$s from jsonb_populate_record(null::public.%1$I,$1) r where t.id=r.id',p_table,assignments) using payload;
 end if;
 if p_table='products' and exists(select 1 from public.shipments s join public.products p on p.id=s."productId" where p.id=record_id and s.date<p.production) then
  raise exception 'SHIPMENT_DATE';
 end if;
 if p_table='products' and exists(select 1 from public.shipments s join public.order_items i on i.id=s."orderItemId" join public.products p on p.id=s."productId" where p.id=record_id and (lower(btrim(p.code))<>lower(btrim(i.model)) or lower(btrim(p.rail))<>lower(btrim(i.specification)))) then raise exception 'ORDER_PRODUCT_MISMATCH'; end if;
 return public.flow_snapshot();
end $$;
revoke all on function public.flow_save(text,jsonb,integer) from public,anon;
grant execute on function public.flow_save(text,jsonb,integer) to authenticated;

create or replace function public.flow_delete(p_table text,p_id uuid,p_expected_version integer) returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare current_version integer;
begin
 if public.flow_role() is distinct from 'admin' then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
 if p_table not in ('products','customers','shipments','service','orders') or p_table is null then raise exception 'INVALID_TABLE'; end if;
 perform pg_advisory_xact_lock(83421671);
 execute format('select version from public.%I where id=$1 for update',p_table) into current_version using p_id;
 if current_version is null or current_version is distinct from p_expected_version then raise exception 'STALE_RECORD'; end if;
 execute format('delete from public.%I where id=$1',p_table) using p_id;
 return public.flow_snapshot();
end $$;
revoke all on function public.flow_delete(text,uuid,integer) from public,anon;
grant execute on function public.flow_delete(text,uuid,integer) to authenticated;


create table if not exists public.manufacturing_lots (
 id uuid primary key,
 code text not null check(length(btrim(code)) between 1 and 200),
 model text not null check(length(btrim(model)) between 1 and 200),
 specification text not null default '' check(length(specification)<=200),
 started date not null,
 ended date,
 inspection text not null check(inspection in ('검사대기','합격','불합격')),
 status text not null check(status in ('진행중','마감')),
 notes text not null default '' check(length(notes)<=2000),
 version integer not null default 1 check(version>0),
 check(ended is null or ended>=started)
);
create unique index if not exists manufacturing_lots_code_unique on public.manufacturing_lots(lower(btrim(code)));
alter table public.products add column if not exists "lotId" uuid references public.manufacturing_lots(id) on delete restrict;
create index if not exists products_lot on public.products("lotId");
alter table public.manufacturing_lots enable row level security;
drop policy if exists staff_read on public.manufacturing_lots;
create policy staff_read on public.manufacturing_lots for select to authenticated using((select public.flow_role()) in ('admin','employee'));
revoke all on public.manufacturing_lots from anon,authenticated;
grant select on public.manufacturing_lots to authenticated;

create or replace function public.flow_validate_lot_product() returns trigger
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare lot public.manufacturing_lots; prior_status text;
begin
 if TG_OP='UPDATE' and new."lotId" is distinct from old."lotId" and old."lotId" is not null then
  select status into prior_status from public.manufacturing_lots where id=old."lotId";
  if prior_status='마감' then raise exception 'LOT_CLOSED'; end if;
 end if;
 if new."lotId" is null then return new; end if;
 select * into lot from public.manufacturing_lots where id=new."lotId";
 if lot.id is null then raise exception 'LOT_MISSING' using errcode='23503'; end if;
 if lot.status='마감' and (TG_OP='INSERT' or new."lotId" is distinct from old."lotId") then raise exception 'LOT_CLOSED'; end if;
 if lower(btrim(new.code))<>lower(btrim(lot.model)) or lower(btrim(new.rail))<>lower(btrim(lot.specification)) then raise exception 'LOT_PRODUCT_MISMATCH'; end if;
 if new.production<lot.started or (lot.ended is not null and new.production>lot.ended) then raise exception 'LOT_PRODUCTION_DATE'; end if;
 return new;
end $$;
revoke all on function public.flow_validate_lot_product() from public,anon,authenticated;
drop trigger if exists flow_lot_product_guard on public.products;
create trigger flow_lot_product_guard before insert or update on public.products for each row execute function public.flow_validate_lot_product();

create or replace function public.flow_validate_lot_update() returns trigger
language plpgsql security definer set search_path=pg_catalog,public
as $$
begin
 if new.code is distinct from old.code and exists(select 1 from public.products where "lotId"=old.id) then raise exception 'LOT_CODE_LOCKED'; end if;
 if exists(select 1 from public.products p where p."lotId"=old.id and (lower(btrim(p.code))<>lower(btrim(new.model)) or lower(btrim(p.rail))<>lower(btrim(new.specification)) or p.production<new.started or (new.ended is not null and p.production>new.ended))) then raise exception 'LOT_LINKED_PRODUCTS'; end if;
 return new;
end $$;
revoke all on function public.flow_validate_lot_update() from public,anon,authenticated;
drop trigger if exists flow_lot_update_guard on public.manufacturing_lots;
create trigger flow_lot_update_guard before update on public.manufacturing_lots for each row execute function public.flow_validate_lot_update();

create or replace function public.flow_snapshot() returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare member_role text;
begin
 member_role:=public.flow_role();
 if member_role is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 return jsonb_build_object('serial_auto',true,'serial_manual',true,'customer_code_auto',true,'orders_enabled',true,'quantity_management',true,'service_billing',true,'manufacturing_lots',true,'role',member_role,'data',jsonb_build_object(
  'lots',coalesce((select jsonb_agg(to_jsonb(l) order by l.started desc,l.code) from public.manufacturing_lots l),'[]'::jsonb),
  'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.serial) from public.products p),'[]'::jsonb),
  'customers',coalesce((select jsonb_agg(to_jsonb(c) order by c.name) from public.customers c),'[]'::jsonb),
  'shipments',coalesce((select jsonb_agg(to_jsonb(s) order by s.date desc,s.id) from public.shipments s),'[]'::jsonb),
  'orders',coalesce((select jsonb_agg(to_jsonb(o)||jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object('delivered',(select coalesce(sum(s.quantity),0) from public.shipments s where s."orderItemId"=i.id)) order by i.position) from public.order_items i where i."orderId"=o.id),'[]'::jsonb)) order by o.received desc,o.number desc) from public.orders o),'[]'::jsonb),
  'service',coalesce((select jsonb_agg(to_jsonb(s) order by s.received desc,s.id) from public.service s),'[]'::jsonb)
 ));
end $$;
revoke all on function public.flow_snapshot() from public,anon;
grant execute on function public.flow_snapshot() to authenticated;

create or replace function public.flow_save(p_table text,p_record jsonb,p_expected_version integer default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare
 record_id uuid; current_version integer; col_list text; assignments text; payload jsonb;
 existing_product uuid; prod public.products; cust public.customers; svc public.service;
begin
 if public.flow_role() is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 if p_table='lots' then p_table:='manufacturing_lots'; end if;
 if p_table='orders' then return public.flow_save_order(p_record,p_expected_version); end if;
 if p_table not in ('products','customers','shipments','service','manufacturing_lots') or p_table is null then raise exception 'INVALID_TABLE'; end if;
 -- All application writes share a transaction lock: stock checks and writes stay atomic.
 perform pg_advisory_xact_lock(83421671);
 record_id:=(p_record->>'id')::uuid;
 if record_id is null then raise exception 'INVALID_ID'; end if;
 execute format('select version from public.%I where id=$1 for update',p_table) into current_version using record_id;
 if (p_expected_version is null and current_version is not null) or
    (p_expected_version is not null and current_version is distinct from p_expected_version) then
  raise exception 'STALE_RECORD';
 end if;
 payload:=p_record||jsonb_build_object('version',coalesce(current_version,0)+1);
 if p_table='manufacturing_lots' and payload->>'ended'='' then payload:=payload||jsonb_build_object('ended',null); end if;
 if p_table='products' then
  if not payload?'lotId' and current_version is not null then payload:=payload||jsonb_build_object('lotId',(select "lotId" from public.products where id=record_id)); end if;
  if payload->>'lotId'='' then payload:=payload||jsonb_build_object('lotId',null); end if;
  if current_version is null then
   if coalesce(p_record->>'serial_mode','auto') not in ('auto','manual') then raise exception 'INVALID_SERIAL_MODE'; end if;
   payload:=payload||jsonb_build_object('serial',case when p_record->>'serial_mode'='manual' then btrim(coalesce(p_record->>'serial','')) else '' end,'serial_generated',coalesce(p_record->>'serial_mode','auto')<>'manual');
  else
   select * into prod from public.products where id=record_id;
   -- Preserve the immutable identifier even when older clients omit it.
   payload:=payload||jsonb_build_object('serial',prod.serial,'serial_generated',prod.serial_generated);
  end if;
  if payload->>'category'='' or not payload?'category' then payload:=payload||jsonb_build_object('category',case when current_version is null then null else prod.category end); end if;
 end if;
 if p_table='customers' then
  if current_version is null then
   if coalesce(p_record->>'customer_code_mode','manual') not in ('auto','manual') then raise exception 'INVALID_CUSTOMER_CODE_MODE'; end if;
   payload:=payload||jsonb_build_object('code',case when p_record->>'customer_code_mode'='auto' then '' else btrim(coalesce(p_record->>'code','')) end,'code_generated',p_record->>'customer_code_mode'='auto');
   -- SQL NULL must not leave the mode flag unset for older clients.
   payload:=payload||jsonb_build_object('code_generated',coalesce(p_record->>'customer_code_mode','manual')='auto');
  else
   select * into cust from public.customers where id=record_id;
   payload:=payload||jsonb_build_object('code',cust.code,'code_generated',cust.code_generated);
  end if;
 end if;
 if p_table='service' then
  if current_version is not null then select * into svc from public.service where id=record_id; end if;
  payload:=payload||jsonb_build_object(
   'billingType',case when payload?'billingType' then payload->'billingType' else to_jsonb(coalesce(svc."billingType",'미정')) end,
   'chargeAmount',case when payload?'chargeAmount' then payload->'chargeAmount' else to_jsonb(coalesce(svc."chargeAmount",0)) end,
   'paidAmount',case when payload?'paidAmount' then payload->'paidAmount' else to_jsonb(coalesce(svc."paidAmount",0)) end,
   'paidDate',case when payload?'paidDate' then payload->'paidDate' else to_jsonb(svc."paidDate") end);
  if payload->>'paidDate'='' then payload:=payload||jsonb_build_object('paidDate',null); end if;
 end if;
 if p_table='service' and payload->>'completed'='' then payload:=payload||'{"completed":null}'::jsonb; end if;
 if p_table='shipments' then
  if not payload?'orderItemId' and current_version is not null then
   payload:=payload||jsonb_build_object('orderItemId',(select "orderItemId" from public.shipments where id=record_id));
  end if;
  if payload->>'orderItemId'='' then payload:=payload||jsonb_build_object('orderItemId',null); end if;
  if payload->>'productId'='' then payload:=payload||jsonb_build_object('productId',null); end if;
  if not payload?'quantity' then payload:=payload||jsonb_build_object('quantity',coalesce((select quantity from public.shipments where id=record_id),1)); end if;
  if payload->>'productId' is not null then
  select * into prod from public.products where id=(payload->>'productId')::uuid for update;
  if prod.id is null then raise exception 'PRODUCT_MISSING' using errcode='23503'; end if;
  select "productId" into existing_product from public.shipments where id=record_id;
  if exists(select 1 from public.shipments where "productId"=prod.id and id<>record_id) or
     (prod.status<>'재고' and existing_product is distinct from prod.id) then raise exception 'ALREADY_SHIPPED'; end if;
  if (payload->>'date')::date < prod.production then raise exception 'SHIPMENT_DATE'; end if;
  end if;
 end if;
 -- Column lists are read from allowlisted tables, never client-supplied SQL.
 select string_agg(format('%I',column_name),',' order by ordinal_position),
        string_agg(format('%I=excluded.%I',column_name,column_name),',' order by ordinal_position) filter(where column_name<>'id')
 into col_list,assignments
 from information_schema.columns where table_schema='public' and table_name=p_table;
 if current_version is null then
  execute format('insert into public.%1$I (%2$s) select %2$s from jsonb_populate_record(null::public.%1$I,$1)',p_table,col_list) using payload;
 else
  select string_agg(format('%I=r.%I',column_name,column_name),',' order by ordinal_position) into assignments
  from information_schema.columns where table_schema='public' and table_name=p_table and column_name<>'id';
  execute format('update public.%1$I t set %2$s from jsonb_populate_record(null::public.%1$I,$1) r where t.id=r.id',p_table,assignments) using payload;
 end if;
 if p_table='products' and exists(select 1 from public.shipments s join public.products p on p.id=s."productId" where p.id=record_id and s.date<p.production) then
  raise exception 'SHIPMENT_DATE';
 end if;
 if p_table='products' and exists(select 1 from public.shipments s join public.order_items i on i.id=s."orderItemId" join public.products p on p.id=s."productId" where p.id=record_id and (lower(btrim(p.code))<>lower(btrim(i.model)) or lower(btrim(p.rail))<>lower(btrim(i.specification)))) then raise exception 'ORDER_PRODUCT_MISMATCH'; end if;
 return public.flow_snapshot();
end $$;
revoke all on function public.flow_save(text,jsonb,integer) from public,anon;
grant execute on function public.flow_save(text,jsonb,integer) to authenticated;

create or replace function public.flow_delete(p_table text,p_id uuid,p_expected_version integer) returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare current_version integer;
begin
 if public.flow_role() is distinct from 'admin' then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
 if p_table='lots' then p_table:='manufacturing_lots'; end if;
 if p_table not in ('products','customers','shipments','service','orders','manufacturing_lots') or p_table is null then raise exception 'INVALID_TABLE'; end if;
 perform pg_advisory_xact_lock(83421671);
 execute format('select version from public.%I where id=$1 for update',p_table) into current_version using p_id;
 if current_version is null or current_version is distinct from p_expected_version then raise exception 'STALE_RECORD'; end if;
 execute format('delete from public.%I where id=$1',p_table) using p_id;
 return public.flow_snapshot();
end $$;
revoke all on function public.flow_delete(text,uuid,integer) from public,anon;
grant execute on function public.flow_delete(text,uuid,integer) to authenticated;


create or replace function public.flow_validate_lot_product() returns trigger
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare lot public.manufacturing_lots; prior_status text;
begin
 if TG_OP='UPDATE' and new."lotId" is distinct from old."lotId" and old."lotId" is not null then
  select status into prior_status from public.manufacturing_lots where id=old."lotId";
  if prior_status='마감' then raise exception 'LOT_CLOSED'; end if;
 end if;
 if new."lotId" is null then return new; end if;
 select * into lot from public.manufacturing_lots where id=new."lotId";
 if lot.id is null then raise exception 'LOT_MISSING' using errcode='23503'; end if;
 if lot.status='마감' and (TG_OP='INSERT' or new."lotId" is distinct from old."lotId") then raise exception 'LOT_CLOSED'; end if;
 if lower(btrim(new.code))<>lower(btrim(lot.model)) then raise exception 'LOT_PRODUCT_MISMATCH'; end if;
 return new;
end $$;
revoke all on function public.flow_validate_lot_product() from public,anon,authenticated;
drop trigger if exists flow_lot_product_guard on public.products;
create trigger flow_lot_product_guard before insert or update on public.products for each row execute function public.flow_validate_lot_product();

create or replace function public.flow_validate_lot_update() returns trigger
language plpgsql security definer set search_path=pg_catalog,public
as $$
begin
 if new.code is distinct from old.code and exists(select 1 from public.products where "lotId"=old.id) then raise exception 'LOT_CODE_LOCKED'; end if;
 if exists(select 1 from public.products p where p."lotId"=old.id and lower(btrim(p.code))<>lower(btrim(new.model))) then raise exception 'LOT_LINKED_PRODUCTS'; end if;
 return new;
end $$;
revoke all on function public.flow_validate_lot_update() from public,anon,authenticated;
drop trigger if exists flow_lot_update_guard on public.manufacturing_lots;
create trigger flow_lot_update_guard before update on public.manufacturing_lots for each row execute function public.flow_validate_lot_update();



alter table public.products alter column production drop not null;
alter table public.products drop constraint if exists products_auto_production_required;
alter table public.products add constraint products_auto_production_required check(not serial_generated or production is not null);
create or replace function public.flow_snapshot() returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare member_role text;
begin
 member_role:=public.flow_role();
 if member_role is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 return jsonb_build_object('serial_auto',true,'serial_manual',true,'customer_code_auto',true,'orders_enabled',true,'quantity_management',true,'service_billing',true,'manufacturing_lots',true,'production_unknown',true,'role',member_role,'data',jsonb_build_object(
  'lots',coalesce((select jsonb_agg(to_jsonb(l) order by l.started desc,l.code) from public.manufacturing_lots l),'[]'::jsonb),
  'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.serial) from public.products p),'[]'::jsonb),
  'customers',coalesce((select jsonb_agg(to_jsonb(c) order by c.name) from public.customers c),'[]'::jsonb),
  'shipments',coalesce((select jsonb_agg(to_jsonb(s) order by s.date desc,s.id) from public.shipments s),'[]'::jsonb),
  'orders',coalesce((select jsonb_agg(to_jsonb(o)||jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object('delivered',(select coalesce(sum(s.quantity),0) from public.shipments s where s."orderItemId"=i.id)) order by i.position) from public.order_items i where i."orderId"=o.id),'[]'::jsonb)) order by o.received desc,o.number desc) from public.orders o),'[]'::jsonb),
  'service',coalesce((select jsonb_agg(to_jsonb(s) order by s.received desc,s.id) from public.service s),'[]'::jsonb)
 ));
end $$;
revoke all on function public.flow_snapshot() from public,anon;
grant execute on function public.flow_snapshot() to authenticated;

create or replace function public.flow_save(p_table text,p_record jsonb,p_expected_version integer default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare
 record_id uuid; current_version integer; col_list text; assignments text; payload jsonb;
 existing_product uuid; prod public.products; cust public.customers; svc public.service;
begin
 if public.flow_role() is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 if p_table='lots' then p_table:='manufacturing_lots'; end if;
 if p_table='orders' then return public.flow_save_order(p_record,p_expected_version); end if;
 if p_table not in ('products','customers','shipments','service','manufacturing_lots') or p_table is null then raise exception 'INVALID_TABLE'; end if;
 -- All application writes share a transaction lock: stock checks and writes stay atomic.
 perform pg_advisory_xact_lock(83421671);
 record_id:=(p_record->>'id')::uuid;
 if record_id is null then raise exception 'INVALID_ID'; end if;
 execute format('select version from public.%I where id=$1 for update',p_table) into current_version using record_id;
 if (p_expected_version is null and current_version is not null) or
    (p_expected_version is not null and current_version is distinct from p_expected_version) then
  raise exception 'STALE_RECORD';
 end if;
 payload:=p_record||jsonb_build_object('version',coalesce(current_version,0)+1);
 if p_table='manufacturing_lots' and payload->>'ended'='' then payload:=payload||jsonb_build_object('ended',null); end if;
 if p_table='products' then
  if not payload?'production' and current_version is not null then payload:=payload||jsonb_build_object('production',(select production from public.products where id=record_id)); end if;
  if payload->>'production'='' then payload:=payload||jsonb_build_object('production',null); end if;
  if not payload?'lotId' and current_version is not null then payload:=payload||jsonb_build_object('lotId',(select "lotId" from public.products where id=record_id)); end if;
  if payload->>'lotId'='' then payload:=payload||jsonb_build_object('lotId',null); end if;
  if current_version is null then
   if coalesce(p_record->>'serial_mode','auto') not in ('auto','manual') then raise exception 'INVALID_SERIAL_MODE'; end if;
   payload:=payload||jsonb_build_object('serial',case when p_record->>'serial_mode'='manual' then btrim(coalesce(p_record->>'serial','')) else '' end,'serial_generated',coalesce(p_record->>'serial_mode','auto')<>'manual');
  else
   select * into prod from public.products where id=record_id;
   -- Preserve the immutable identifier even when older clients omit it.
   payload:=payload||jsonb_build_object('serial',prod.serial,'serial_generated',prod.serial_generated);
  end if;
  if payload->>'category'='' or not payload?'category' then payload:=payload||jsonb_build_object('category',case when current_version is null then null else prod.category end); end if;
 end if;
 if p_table='customers' then
  if current_version is null then
   if coalesce(p_record->>'customer_code_mode','manual') not in ('auto','manual') then raise exception 'INVALID_CUSTOMER_CODE_MODE'; end if;
   payload:=payload||jsonb_build_object('code',case when p_record->>'customer_code_mode'='auto' then '' else btrim(coalesce(p_record->>'code','')) end,'code_generated',p_record->>'customer_code_mode'='auto');
   -- SQL NULL must not leave the mode flag unset for older clients.
   payload:=payload||jsonb_build_object('code_generated',coalesce(p_record->>'customer_code_mode','manual')='auto');
  else
   select * into cust from public.customers where id=record_id;
   payload:=payload||jsonb_build_object('code',cust.code,'code_generated',cust.code_generated);
  end if;
 end if;
 if p_table='service' then
  if current_version is not null then select * into svc from public.service where id=record_id; end if;
  payload:=payload||jsonb_build_object(
   'billingType',case when payload?'billingType' then payload->'billingType' else to_jsonb(coalesce(svc."billingType",'미정')) end,
   'chargeAmount',case when payload?'chargeAmount' then payload->'chargeAmount' else to_jsonb(coalesce(svc."chargeAmount",0)) end,
   'paidAmount',case when payload?'paidAmount' then payload->'paidAmount' else to_jsonb(coalesce(svc."paidAmount",0)) end,
   'paidDate',case when payload?'paidDate' then payload->'paidDate' else to_jsonb(svc."paidDate") end);
  if payload->>'paidDate'='' then payload:=payload||jsonb_build_object('paidDate',null); end if;
 end if;
 if p_table='service' and payload->>'completed'='' then payload:=payload||'{"completed":null}'::jsonb; end if;
 if p_table='shipments' then
  if not payload?'orderItemId' and current_version is not null then
   payload:=payload||jsonb_build_object('orderItemId',(select "orderItemId" from public.shipments where id=record_id));
  end if;
  if payload->>'orderItemId'='' then payload:=payload||jsonb_build_object('orderItemId',null); end if;
  if payload->>'productId'='' then payload:=payload||jsonb_build_object('productId',null); end if;
  if not payload?'quantity' then payload:=payload||jsonb_build_object('quantity',coalesce((select quantity from public.shipments where id=record_id),1)); end if;
  if payload->>'productId' is not null then
  select * into prod from public.products where id=(payload->>'productId')::uuid for update;
  if prod.id is null then raise exception 'PRODUCT_MISSING' using errcode='23503'; end if;
  select "productId" into existing_product from public.shipments where id=record_id;
  if exists(select 1 from public.shipments where "productId"=prod.id and id<>record_id) or
     (prod.status<>'재고' and existing_product is distinct from prod.id) then raise exception 'ALREADY_SHIPPED'; end if;
  if (payload->>'date')::date < prod.production then raise exception 'SHIPMENT_DATE'; end if;
  end if;
 end if;
 -- Column lists are read from allowlisted tables, never client-supplied SQL.
 select string_agg(format('%I',column_name),',' order by ordinal_position),
        string_agg(format('%I=excluded.%I',column_name,column_name),',' order by ordinal_position) filter(where column_name<>'id')
 into col_list,assignments
 from information_schema.columns where table_schema='public' and table_name=p_table;
 if current_version is null then
  execute format('insert into public.%1$I (%2$s) select %2$s from jsonb_populate_record(null::public.%1$I,$1)',p_table,col_list) using payload;
 else
  select string_agg(format('%I=r.%I',column_name,column_name),',' order by ordinal_position) into assignments
  from information_schema.columns where table_schema='public' and table_name=p_table and column_name<>'id';
  execute format('update public.%1$I t set %2$s from jsonb_populate_record(null::public.%1$I,$1) r where t.id=r.id',p_table,assignments) using payload;
 end if;
 if p_table='products' and exists(select 1 from public.shipments s join public.products p on p.id=s."productId" where p.id=record_id and s.date<p.production) then
  raise exception 'SHIPMENT_DATE';
 end if;
 if p_table='products' and exists(select 1 from public.shipments s join public.order_items i on i.id=s."orderItemId" join public.products p on p.id=s."productId" where p.id=record_id and (lower(btrim(p.code))<>lower(btrim(i.model)) or lower(btrim(p.rail))<>lower(btrim(i.specification)))) then raise exception 'ORDER_PRODUCT_MISMATCH'; end if;
 return public.flow_snapshot();
end $$;
revoke all on function public.flow_save(text,jsonb,integer) from public,anon;
grant execute on function public.flow_save(text,jsonb,integer) to authenticated;

create or replace function public.flow_delete(p_table text,p_id uuid,p_expected_version integer) returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare current_version integer;
begin
 if public.flow_role() is distinct from 'admin' then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
 if p_table='lots' then p_table:='manufacturing_lots'; end if;
 if p_table not in ('products','customers','shipments','service','orders','manufacturing_lots') or p_table is null then raise exception 'INVALID_TABLE'; end if;
 perform pg_advisory_xact_lock(83421671);
 execute format('select version from public.%I where id=$1 for update',p_table) into current_version using p_id;
 if current_version is null or current_version is distinct from p_expected_version then raise exception 'STALE_RECORD'; end if;
 execute format('delete from public.%I where id=$1',p_table) using p_id;
 return public.flow_snapshot();
end $$;
revoke all on function public.flow_delete(text,uuid,integer) from public,anon;
grant execute on function public.flow_delete(text,uuid,integer) to authenticated;
create or replace function public.flow_product_serial() returns trigger
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare seq numeric(100,0); generated text;
begin
 if TG_OP='UPDATE' then
  if new.serial is distinct from old.serial then raise exception 'SERIAL_IMMUTABLE'; end if;
  if old.serial_generated and (new.category is distinct from old.category or new.production is distinct from old.production) then raise exception 'SERIAL_SOURCE_IMMUTABLE'; end if;
  new.serial_generated:=old.serial_generated;
  return new;
 end if;
 if new.category is null or new.category not in ('0','1','2') then raise exception 'PRODUCT_CATEGORY_REQUIRED'; end if;
 if not new.serial_generated then
  new.serial:=btrim(new.serial);
  if new.serial is null or new.serial='' then raise exception 'MANUAL_SERIAL_REQUIRED'; end if;
  if upper(new.serial) ~ '^SN[012][0-9]{10,}$' then
   if substring(upper(new.serial) from 3 for 1)<>new.category then raise exception 'SERIAL_CATEGORY_MISMATCH'; end if;
   update public.flow_serial_counters set last_number=greatest(last_number,substring(new.serial from 10)::numeric) where category=new.category;
  end if;
  return new;
 end if;
 if new.production is null then raise exception 'PRODUCTION_REQUIRED'; end if;
 loop
  update public.flow_serial_counters set last_number=last_number+1 where category=new.category returning last_number into seq;
  if seq is null then raise exception 'SERIAL_COUNTER_MISSING'; end if;
  generated:='SN'||new.category||to_char(new.production,'YYMMDD')||lpad(seq::text,greatest(4,length(seq::text)),'0');
  exit when not exists(select 1 from public.products where lower(serial)=lower(generated));
 end loop;
 new.serial:=generated;
 new.serial_generated:=true;
 return new;
end $$;
revoke all on function public.flow_product_serial() from public,anon,authenticated;
drop trigger if exists flow_product_serial_trigger on public.products;
create trigger flow_product_serial_trigger before insert or update on public.products for each row execute function public.flow_product_serial();



alter table public.shipments alter column date drop not null;
create or replace function public.flow_order_shipment_check() returns trigger
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare item public.order_items; parent public.orders; prod public.products; shipped_count integer;
begin
 if new.quantity is null or new.quantity<1 or new.quantity>1000000 then raise exception 'INVALID_SHIPMENT_QUANTITY'; end if;
 if new."orderItemId" is null then
  if new."productId" is null or new.quantity<>1 then raise exception 'SERIAL_SHIPMENT_REQUIRED'; end if;
  return new;
 end if;
 select * into item from public.order_items where id=new."orderItemId";
 if item.id is null then raise exception 'INVALID_ORDER_ITEM'; end if;
 select * into parent from public.orders where id=item."orderId";
 if parent.stage='취소' and (TG_OP='INSERT' or new."orderItemId" is distinct from old."orderItemId") then raise exception 'ORDER_CANCELLED'; end if;
 if parent."customerId"<>new."customerId" then raise exception 'ORDER_CUSTOMER_MISMATCH'; end if;
 if new.date is not null and new.date<parent.received then raise exception 'ORDER_SHIPMENT_DATE'; end if;
 if item.tracking_mode='serial' then
  if new."productId" is null or new.quantity<>1 then raise exception 'SERIAL_SHIPMENT_REQUIRED'; end if;
 else
  if new."productId" is not null then raise exception 'QUANTITY_SHIPMENT_NO_SERIAL'; end if;
 end if;
 select * into prod from public.products where id=new."productId";
 if item.tracking_mode='serial' and (lower(btrim(prod.code))<>lower(btrim(item.model)) or lower(btrim(prod.rail))<>lower(btrim(item.specification))) then raise exception 'ORDER_PRODUCT_MISMATCH'; end if;
 select coalesce(sum(quantity),0) into shipped_count from public.shipments where "orderItemId"=item.id and id<>new.id;
 if shipped_count+new.quantity>item.quantity then raise exception 'ORDER_OVERSHIP'; end if;
 new.name:=item.model;
 return new;
end $$;
revoke all on function public.flow_order_shipment_check() from public,anon,authenticated;
drop trigger if exists flow_order_shipment_guard on public.shipments;
create trigger flow_order_shipment_guard before insert or update on public.shipments for each row execute function public.flow_order_shipment_check();

create or replace function public.flow_order_shipment_version() returns trigger
language plpgsql security definer set search_path=pg_catalog,public
as $$
begin
 update public.orders set version=version+1 where id in(select "orderId" from public.order_items where id in(case when TG_OP<>'INSERT' then old."orderItemId" end,case when TG_OP<>'DELETE' then new."orderItemId" end));
 return null;
end $$;
revoke all on function public.flow_order_shipment_version() from public,anon,authenticated;
drop trigger if exists flow_order_version on public.shipments;
create trigger flow_order_version after insert or update or delete on public.shipments for each row execute function public.flow_order_shipment_version();

create table if not exists public.manufacturing_lots (
 id uuid primary key,
 code text not null check(length(btrim(code)) between 1 and 200),
 model text not null check(length(btrim(model)) between 1 and 200),
 specification text not null default '' check(length(specification)<=200),
 started date not null,
 ended date,
 inspection text not null check(inspection in ('검사대기','합격','불합격')),
 status text not null check(status in ('진행중','마감')),
 notes text not null default '' check(length(notes)<=2000),
 version integer not null default 1 check(version>0),
 check(ended is null or ended>=started)
);
create unique index if not exists manufacturing_lots_code_unique on public.manufacturing_lots(lower(btrim(code)));
alter table public.products add column if not exists "lotId" uuid references public.manufacturing_lots(id) on delete restrict;
create index if not exists products_lot on public.products("lotId");
alter table public.manufacturing_lots enable row level security;
drop policy if exists staff_read on public.manufacturing_lots;
create policy staff_read on public.manufacturing_lots for select to authenticated using((select public.flow_role()) in ('admin','employee'));
revoke all on public.manufacturing_lots from anon,authenticated;
grant select on public.manufacturing_lots to authenticated;

create or replace function public.flow_validate_lot_product() returns trigger
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare lot public.manufacturing_lots; prior_status text;
begin
 if TG_OP='UPDATE' and new."lotId" is distinct from old."lotId" and old."lotId" is not null then
  select status into prior_status from public.manufacturing_lots where id=old."lotId";
  if prior_status='마감' then raise exception 'LOT_CLOSED'; end if;
 end if;
 if new."lotId" is null then return new; end if;
 select * into lot from public.manufacturing_lots where id=new."lotId";
 if lot.id is null then raise exception 'LOT_MISSING' using errcode='23503'; end if;
 if lot.status='마감' and (TG_OP='INSERT' or new."lotId" is distinct from old."lotId") then raise exception 'LOT_CLOSED'; end if;
 if lower(btrim(new.code))<>lower(btrim(lot.model)) then raise exception 'LOT_PRODUCT_MISMATCH'; end if;
 return new;
end $$;
revoke all on function public.flow_validate_lot_product() from public,anon,authenticated;
drop trigger if exists flow_lot_product_guard on public.products;
create trigger flow_lot_product_guard before insert or update on public.products for each row execute function public.flow_validate_lot_product();

create or replace function public.flow_validate_lot_update() returns trigger
language plpgsql security definer set search_path=pg_catalog,public
as $$
begin
 if new.code is distinct from old.code and exists(select 1 from public.products where "lotId"=old.id) then raise exception 'LOT_CODE_LOCKED'; end if;
 if exists(select 1 from public.products p where p."lotId"=old.id and lower(btrim(p.code))<>lower(btrim(new.model))) then raise exception 'LOT_LINKED_PRODUCTS'; end if;
 return new;
end $$;
revoke all on function public.flow_validate_lot_update() from public,anon,authenticated;
drop trigger if exists flow_lot_update_guard on public.manufacturing_lots;
create trigger flow_lot_update_guard before update on public.manufacturing_lots for each row execute function public.flow_validate_lot_update();

create or replace function public.flow_snapshot() returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare member_role text;
begin
 member_role:=public.flow_role();
 if member_role is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 return jsonb_build_object('serial_auto',true,'serial_manual',true,'customer_code_auto',true,'orders_enabled',true,'quantity_management',true,'service_billing',true,'manufacturing_lots',true,'production_unknown',true,'shipment_date_unknown',true,'role',member_role,'data',jsonb_build_object(
  'lots',coalesce((select jsonb_agg(to_jsonb(l) order by l.started desc,l.code) from public.manufacturing_lots l),'[]'::jsonb),
  'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.serial) from public.products p),'[]'::jsonb),
  'customers',coalesce((select jsonb_agg(to_jsonb(c) order by c.name) from public.customers c),'[]'::jsonb),
  'shipments',coalesce((select jsonb_agg(to_jsonb(s) order by s.date desc nulls last,s.id) from public.shipments s),'[]'::jsonb),
  'orders',coalesce((select jsonb_agg(to_jsonb(o)||jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object('delivered',(select coalesce(sum(s.quantity),0) from public.shipments s where s."orderItemId"=i.id)) order by i.position) from public.order_items i where i."orderId"=o.id),'[]'::jsonb)) order by o.received desc,o.number desc) from public.orders o),'[]'::jsonb),
  'service',coalesce((select jsonb_agg(to_jsonb(s) order by s.received desc,s.id) from public.service s),'[]'::jsonb)
 ));
end $$;
revoke all on function public.flow_snapshot() from public,anon;
grant execute on function public.flow_snapshot() to authenticated;

create or replace function public.flow_save(p_table text,p_record jsonb,p_expected_version integer default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare
 record_id uuid; current_version integer; col_list text; assignments text; payload jsonb;
 existing_product uuid; prod public.products; cust public.customers; svc public.service;
begin
 if public.flow_role() is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 if p_table='lots' then p_table:='manufacturing_lots'; end if;
 if p_table='orders' then return public.flow_save_order(p_record,p_expected_version); end if;
 if p_table not in ('products','customers','shipments','service','manufacturing_lots') or p_table is null then raise exception 'INVALID_TABLE'; end if;
 -- All application writes share a transaction lock: stock checks and writes stay atomic.
 perform pg_advisory_xact_lock(83421671);
 record_id:=(p_record->>'id')::uuid;
 if record_id is null then raise exception 'INVALID_ID'; end if;
 execute format('select version from public.%I where id=$1 for update',p_table) into current_version using record_id;
 if (p_expected_version is null and current_version is not null) or
    (p_expected_version is not null and current_version is distinct from p_expected_version) then
  raise exception 'STALE_RECORD';
 end if;
 payload:=p_record||jsonb_build_object('version',coalesce(current_version,0)+1);
 if p_table='manufacturing_lots' and payload->>'ended'='' then payload:=payload||jsonb_build_object('ended',null); end if;
 if p_table='products' then
  if not payload?'production' and current_version is not null then payload:=payload||jsonb_build_object('production',(select production from public.products where id=record_id)); end if;
  if payload->>'production'='' then payload:=payload||jsonb_build_object('production',null); end if;
  if not payload?'lotId' and current_version is not null then payload:=payload||jsonb_build_object('lotId',(select "lotId" from public.products where id=record_id)); end if;
  if payload->>'lotId'='' then payload:=payload||jsonb_build_object('lotId',null); end if;
  if current_version is null then
   if coalesce(p_record->>'serial_mode','auto') not in ('auto','manual') then raise exception 'INVALID_SERIAL_MODE'; end if;
   payload:=payload||jsonb_build_object('serial',case when p_record->>'serial_mode'='manual' then btrim(coalesce(p_record->>'serial','')) else '' end,'serial_generated',coalesce(p_record->>'serial_mode','auto')<>'manual');
  else
   select * into prod from public.products where id=record_id;
   -- Preserve the immutable identifier even when older clients omit it.
   payload:=payload||jsonb_build_object('serial',prod.serial,'serial_generated',prod.serial_generated);
  end if;
  if payload->>'category'='' or not payload?'category' then payload:=payload||jsonb_build_object('category',case when current_version is null then null else prod.category end); end if;
 end if;
 if p_table='customers' then
  if current_version is null then
   if coalesce(p_record->>'customer_code_mode','manual') not in ('auto','manual') then raise exception 'INVALID_CUSTOMER_CODE_MODE'; end if;
   payload:=payload||jsonb_build_object('code',case when p_record->>'customer_code_mode'='auto' then '' else btrim(coalesce(p_record->>'code','')) end,'code_generated',p_record->>'customer_code_mode'='auto');
   -- SQL NULL must not leave the mode flag unset for older clients.
   payload:=payload||jsonb_build_object('code_generated',coalesce(p_record->>'customer_code_mode','manual')='auto');
  else
   select * into cust from public.customers where id=record_id;
   payload:=payload||jsonb_build_object('code',cust.code,'code_generated',cust.code_generated);
  end if;
 end if;
 if p_table='service' then
  if current_version is not null then select * into svc from public.service where id=record_id; end if;
  payload:=payload||jsonb_build_object(
   'billingType',case when payload?'billingType' then payload->'billingType' else to_jsonb(coalesce(svc."billingType",'미정')) end,
   'chargeAmount',case when payload?'chargeAmount' then payload->'chargeAmount' else to_jsonb(coalesce(svc."chargeAmount",0)) end,
   'paidAmount',case when payload?'paidAmount' then payload->'paidAmount' else to_jsonb(coalesce(svc."paidAmount",0)) end,
   'paidDate',case when payload?'paidDate' then payload->'paidDate' else to_jsonb(svc."paidDate") end);
  if payload->>'paidDate'='' then payload:=payload||jsonb_build_object('paidDate',null); end if;
 end if;
 if p_table='service' and payload->>'completed'='' then payload:=payload||'{"completed":null}'::jsonb; end if;
 if p_table='shipments' then
  if not payload?'date' and current_version is not null then payload:=payload||jsonb_build_object('date',(select date from public.shipments where id=record_id)); end if;
  if payload->>'date'='' then payload:=payload||jsonb_build_object('date',null); end if;
  if not payload?'orderItemId' and current_version is not null then
   payload:=payload||jsonb_build_object('orderItemId',(select "orderItemId" from public.shipments where id=record_id));
  end if;
  if payload->>'orderItemId'='' then payload:=payload||jsonb_build_object('orderItemId',null); end if;
  if payload->>'productId'='' then payload:=payload||jsonb_build_object('productId',null); end if;
  if not payload?'quantity' then payload:=payload||jsonb_build_object('quantity',coalesce((select quantity from public.shipments where id=record_id),1)); end if;
  if payload->>'productId' is not null then
  select * into prod from public.products where id=(payload->>'productId')::uuid for update;
  if prod.id is null then raise exception 'PRODUCT_MISSING' using errcode='23503'; end if;
  select "productId" into existing_product from public.shipments where id=record_id;
  if exists(select 1 from public.shipments where "productId"=prod.id and id<>record_id) or
     (prod.status<>'재고' and existing_product is distinct from prod.id) then raise exception 'ALREADY_SHIPPED'; end if;
  if payload->>'date' is not null and prod.production is not null and (payload->>'date')::date < prod.production then raise exception 'SHIPMENT_DATE'; end if;
  end if;
 end if;
 -- Column lists are read from allowlisted tables, never client-supplied SQL.
 select string_agg(format('%I',column_name),',' order by ordinal_position),
        string_agg(format('%I=excluded.%I',column_name,column_name),',' order by ordinal_position) filter(where column_name<>'id')
 into col_list,assignments
 from information_schema.columns where table_schema='public' and table_name=p_table;
 if current_version is null then
  execute format('insert into public.%1$I (%2$s) select %2$s from jsonb_populate_record(null::public.%1$I,$1)',p_table,col_list) using payload;
 else
  select string_agg(format('%I=r.%I',column_name,column_name),',' order by ordinal_position) into assignments
  from information_schema.columns where table_schema='public' and table_name=p_table and column_name<>'id';
  execute format('update public.%1$I t set %2$s from jsonb_populate_record(null::public.%1$I,$1) r where t.id=r.id',p_table,assignments) using payload;
 end if;
 if p_table='products' and exists(select 1 from public.shipments s join public.products p on p.id=s."productId" where p.id=record_id and s.date<p.production) then
  raise exception 'SHIPMENT_DATE';
 end if;
 if p_table='products' and exists(select 1 from public.shipments s join public.order_items i on i.id=s."orderItemId" join public.products p on p.id=s."productId" where p.id=record_id and (lower(btrim(p.code))<>lower(btrim(i.model)) or lower(btrim(p.rail))<>lower(btrim(i.specification)))) then raise exception 'ORDER_PRODUCT_MISMATCH'; end if;
 return public.flow_snapshot();
end $$;
revoke all on function public.flow_save(text,jsonb,integer) from public,anon;
grant execute on function public.flow_save(text,jsonb,integer) to authenticated;

create or replace function public.flow_delete(p_table text,p_id uuid,p_expected_version integer) returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare current_version integer;
begin
 if public.flow_role() is distinct from 'admin' then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
 if p_table='lots' then p_table:='manufacturing_lots'; end if;
 if p_table not in ('products','customers','shipments','service','orders','manufacturing_lots') or p_table is null then raise exception 'INVALID_TABLE'; end if;
 perform pg_advisory_xact_lock(83421671);
 execute format('select version from public.%I where id=$1 for update',p_table) into current_version using p_id;
 if current_version is null or current_version is distinct from p_expected_version then raise exception 'STALE_RECORD'; end if;
 execute format('delete from public.%I where id=$1',p_table) using p_id;
 return public.flow_snapshot();
end $$;
revoke all on function public.flow_delete(text,uuid,integer) from public,anon;
grant execute on function public.flow_delete(text,uuid,integer) to authenticated;


create or replace function public.flow_order_shipment_check() returns trigger
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare item public.order_items; parent public.orders; prod public.products; shipped_count integer;
begin
 if new.quantity is null or new.quantity<1 or new.quantity>1000000 then raise exception 'INVALID_SHIPMENT_QUANTITY'; end if;
 if new."orderItemId" is null then
  if new."productId" is null or new.quantity<>1 then raise exception 'SERIAL_SHIPMENT_REQUIRED'; end if;
  return new;
 end if;
 select * into item from public.order_items where id=new."orderItemId";
 if item.id is null then raise exception 'INVALID_ORDER_ITEM'; end if;
 select * into parent from public.orders where id=item."orderId";
 if parent.stage='취소' and (TG_OP='INSERT' or new."orderItemId" is distinct from old."orderItemId") then raise exception 'ORDER_CANCELLED'; end if;
 if parent."customerId"<>new."customerId" then raise exception 'ORDER_CUSTOMER_MISMATCH'; end if;
 if new.date is not null and new.date<parent.received then raise exception 'ORDER_SHIPMENT_DATE'; end if;
 if item.tracking_mode='serial' then
  if new."productId" is null or new.quantity<>1 then raise exception 'SERIAL_SHIPMENT_REQUIRED'; end if;
 else
  if new."productId" is not null then raise exception 'QUANTITY_SHIPMENT_NO_SERIAL'; end if;
 end if;
 select * into prod from public.products where id=new."productId";
 if item.tracking_mode='serial' and (lower(btrim(prod.code))<>lower(btrim(item.model)) or lower(btrim(prod.rail))<>lower(btrim(item.specification))) then raise exception 'ORDER_PRODUCT_MISMATCH'; end if;
 select coalesce(sum(quantity),0) into shipped_count from public.shipments where "orderItemId"=item.id and id<>new.id;
 if shipped_count+new.quantity>item.quantity then raise exception 'ORDER_OVERSHIP'; end if;
 return new;
end $$;
revoke all on function public.flow_order_shipment_check() from public,anon,authenticated;
drop trigger if exists flow_order_shipment_guard on public.shipments;
create trigger flow_order_shipment_guard before insert or update on public.shipments for each row execute function public.flow_order_shipment_check();


create or replace function public.flow_snapshot() returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare member_role text;
begin
 member_role:=public.flow_role();
 if member_role is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 if current_setting('flow.compact',true)='true' then return '{}'::jsonb; end if;
 return jsonb_build_object('serial_auto',true,'serial_manual',true,'customer_code_auto',true,'orders_enabled',true,'quantity_management',true,'service_billing',true,'manufacturing_lots',true,'production_unknown',true,'shipment_date_unknown',true,'role',member_role,'data',jsonb_build_object(
  'lots',coalesce((select jsonb_agg(to_jsonb(l) order by l.started desc,l.code) from public.manufacturing_lots l),'[]'::jsonb),
  'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.serial) from public.products p),'[]'::jsonb),
  'customers',coalesce((select jsonb_agg(to_jsonb(c) order by c.name) from public.customers c),'[]'::jsonb),
  'shipments',coalesce((select jsonb_agg(to_jsonb(s) order by s.date desc nulls last,s.id) from public.shipments s),'[]'::jsonb),
  'orders',coalesce((select jsonb_agg(to_jsonb(o)||jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object('delivered',(select coalesce(sum(s.quantity),0) from public.shipments s where s."orderItemId"=i.id)) order by i.position) from public.order_items i where i."orderId"=o.id),'[]'::jsonb)) order by o.received desc,o.number desc) from public.orders o),'[]'::jsonb),
  'service',coalesce((select jsonb_agg(to_jsonb(s) order by s.received desc,s.id) from public.service s),'[]'::jsonb)
 ));
end $$;


-- Server-side paging. Internal views are accessible only through staff-checked RPCs.
create or replace view public.flow_orders_read as
select o.*, coalesce(i.items,'[]'::jsonb) items, coalesce(i.total,0) total,
 coalesce(i.delivered,0) delivered, coalesce(i.total-i.delivered,0) remaining,
 case when o.stage='취소' then '취소' when i.total>0 and i.total=i.delivered then '완료' else o.stage end as effective_stage,
 c.name as customer_name
from public.orders o join public.customers c on c.id=o."customerId"
left join lateral (
 select jsonb_agg(to_jsonb(x) order by x.position,x.id) items,sum(x.quantity) total,sum(x.delivered) delivered
 from (select i.*,(select coalesce(sum(s.quantity),0) from public.shipments s where s."orderItemId"=i.id) delivered
 from public.order_items i where i."orderId"=o.id) x
) i on true;
create or replace view public.flow_products_read as
select p.*,exists(select 1 from public.shipments s where s."productId"=p.id) as _shipped,
 case when exists(select 1 from public.shipments s where s."productId"=p.id) then '출고' else p.status end effective_status,
 l.code lot_code, concat_ws(' · ',p.code,p.rail,
 case when p.status='출고' or s.id is not null then '출고' else '재고' end,c.name,l.code) as _description
from public.products p left join public.manufacturing_lots l on l.id=p."lotId"
left join public.shipments s on s."productId"=p.id left join public.customers c on c.id=s."customerId";
create or replace view public.flow_lots_read as
select l.*, (select count(*) from public.products p where p."lotId"=l.id) as "productCount",
 (select count(*) from public.shipments s join public.products p on p.id=s."productId" where p."lotId"=l.id) as "shipmentCount",
 (select count(*) from public.service s join public.products p on p.id=s."productId" where p."lotId"=l.id) as "serviceCount"
from public.manufacturing_lots l;
create or replace view public.flow_shipments_read as
select s.*,c.name customer_name,p.serial product_serial,p."lotId" lot_id,o.number order_number,i.model order_model
from public.shipments s join public.customers c on c.id=s."customerId"
left join public.products p on p.id=s."productId" left join public.order_items i on i.id=s."orderItemId"
left join public.orders o on o.id=i."orderId";
create or replace view public.flow_service_read as
select s.*,p.serial product_serial,p."lotId" lot_id,
 case when s."billingType"='무상' then '해당 없음' when s."billingType"<>'유상' then '확인 필요'
 when s."chargeAmount"=0 then '청구예정' when s."paidAmount"=0 then '미입금'
 when s."paidAmount"<s."chargeAmount" then '부분입금' else '입금완료' end as payment_status
from public.service s join public.products p on p.id=s."productId";
revoke all on public.flow_orders_read,public.flow_products_read,public.flow_lots_read,public.flow_shipments_read,public.flow_service_read from public,anon,authenticated;

-- Normalized rows keep display/search behavior in one place; never exposed as a direct RPC.
create or replace function public.flow_read_rows(p_table text)
returns table(id uuid,record jsonb,search_text text,stage text,sort_key text)
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
 case p_table
 when 'customers' then return query select c.id,to_jsonb(c),concat_ws(' ',c.code,c.name,c.address,c.phone,regexp_replace(c.phone,'[^0-9]','','g'),c.notes),''::text,c.name from public.customers c;
 when 'products' then return query select p.id,to_jsonb(p)||jsonb_build_object('_display',jsonb_build_object('lotId',coalesce(p.lot_code,'미지정'),'status',p.effective_status,'production',coalesce(p.production::text,'미상'))),concat_ws(' ',p.serial,p.code,p.production,p.rail,p._description,p.lot_code,p.inspection,p.effective_status,p.notes,case p.category when '0' then '레일방제기' when '1' then '레일리프트' when '2' then '미스트' end,case when p.production is null then '미상' end),p.effective_status,p.serial from public.flow_products_read p;
 when 'orders' then return query select o.id,to_jsonb(o)||jsonb_build_object('_display',jsonb_build_object('customerId',o.customer_name,'items_summary',(select string_agg((j->>'model')||case when btrim(j->>'specification')<>'' then ' / '||(j->>'specification') else '' end||' × '||(j->>'quantity'),'; ' order by (j->>'position')::integer) from jsonb_array_elements(o.items) j))),concat_ws(' ',o.number,o.received,o.due,o.customer_name,o.effective_stage,o.notes,o.total,o.delivered,o.remaining,(select string_agg(concat_ws(' ',j->>'model',j->>'specification',j->>'quantity'),' ') from jsonb_array_elements(o.items) j)),o.effective_stage, lpad((99999999-(o.received-to_date('1900-01-01','YYYY-MM-DD')))::text,8,'0')||o.number from public.flow_orders_read o;
 when 'lots' then return query select l.id,to_jsonb(l),concat_ws(' ',l.code,l.model,l.specification,l.started,l.ended,l.inspection,l.status,l.notes,l."productCount",l."shipmentCount",l."serviceCount"),l.status,lpad((99999999-(l.started-to_date('1900-01-01','YYYY-MM-DD')))::text,8,'0')||l.code from public.flow_lots_read l;
 when 'shipments' then return query select s.id,to_jsonb(s)||jsonb_build_object('_display',jsonb_build_object('customerId',s.customer_name,'productId',coalesce(s.product_serial,'시리얼 없음'),'orderItemId',case when s.order_number is null then '—' else s.order_number||' · '||s.order_model end,'date',coalesce(s.date::text,'미상'))),concat_ws(' ',coalesce(s.date::text,'미상'),s.customer_name,s.name,s.product_serial,s.order_number,s.order_model,s.quantity,s.notes),''::text,case when s.date is null then '99999999' else lpad((99999999-(s.date-to_date('1900-01-01','YYYY-MM-DD')))::text,8,'0') end from public.flow_shipments_read s;
 when 'service' then return query select s.id,to_jsonb(s)||jsonb_build_object('_display',jsonb_build_object('productId',s.product_serial)),concat_ws(' ',s.product_serial,s.model,s.received,s.symptom,s.action,s.owner,s.completed,s."billingType",s."chargeAmount",s."paidAmount",s."paidDate",s.payment_status),case when s.completed is null then '진행중' else '완료' end,lpad((99999999-(s.received-to_date('1900-01-01','YYYY-MM-DD')))::text,8,'0') from public.flow_service_read s;
 else raise exception 'INVALID_TABLE';
 end case;
end $$;
revoke all on function public.flow_read_rows(text) from public,anon,authenticated;

create or replace function public.flow_query(p_table text,p_search text default '',p_filter text default '전체',p_page integer default 1,p_mode text default 'list',p_id uuid default null,p_link uuid default null,p_current uuid default null,p_lot uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb; total bigint; actual integer; size integer; selected jsonb; bundle jsonb;
begin
 if public.flow_role() is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 if p_mode not in ('list','lookup','options','detail','history') then raise exception 'INVALID_MODE'; end if;
 size:=case when p_mode='lookup' then 20 else 50 end;
 -- Materialization avoids evaluating the enriched rows twice per page request.
 with matches as materialized (
 select r.* from public.flow_read_rows(p_table) r
 where (p_mode<>'detail' or r.id=p_id)
 and (coalesce(p_search,'')='' or strpos(lower(r.search_text),lower(left(p_search,200)))>0)
 and (coalesce(p_filter,'전체')='전체' or r.stage=p_filter
  or (p_table='products' and p_filter='검사대기' and r.record->>'inspection'=p_filter)
  or (p_table='service' and (r.record->>'billingType'=p_filter or r.record->>'payment_status'=p_filter)))
 and (p_lot is null or coalesce(r.record->>'lotId',r.record->>'lot_id')=p_lot::text)
 and (p_mode<>'options' or case p_table
  when 'lots' then r.record->>'status'='진행중' or r.id=p_current
  when 'orders' then exists(select 1 from jsonb_array_elements(r.record->'items') j where ((r.stage<>'취소' and (j->>'delivered')::bigint<(j->>'quantity')::bigint) or j->>'id'=p_current::text))
  when 'products' then ((r.stage='재고' or r.id=p_current) and (p_link is null or exists(select 1 from public.order_items i where i.id=p_link and lower(btrim(i.model))=lower(btrim(r.record->>'code')) and lower(btrim(i.specification))=lower(btrim(r.record->>'rail')))))
  else true end)
 ), count_rows as (select count(*) n from matches), bounds as (
 select n,least(greatest(coalesce(p_page,1),1),greatest(1,ceil(n::numeric/size)::integer)) pg from count_rows
 ), page_rows as (
 select case when p_table='orders' and p_mode='list' then r.record-'items' else r.record end record from matches r order by case when p_mode='lookup' and p_table='products' then case when r.record->>'effective_status'='출고' then 0 else 1 end else 0 end,r.sort_key,r.id
 limit size offset (select (pg-1)*size from bounds)
 ) select (select coalesce(jsonb_agg(record),'[]'::jsonb) from page_rows),n,pg into selected,total,actual from bounds;
 bundle:=jsonb_build_object('products','[]'::jsonb,'customers','[]'::jsonb,'orders','[]'::jsonb,'lots','[]'::jsonb,'shipments','[]'::jsonb,'service','[]'::jsonb)||jsonb_build_object(p_table,selected);
 -- Only the foreign rows needed to edit this bounded page travel with it.
 if p_table in ('shipments','service') and p_mode='detail' then
  bundle:=jsonb_set(bundle,'{products}',coalesce((select jsonb_agg(r.record) from public.flow_read_rows('products') r where r.id in(select (j->>'productId')::uuid from jsonb_array_elements(selected) j where j->>'productId' is not null)),'[]'::jsonb));
 end if;
 if p_table='shipments' and p_mode='detail' then
  bundle:=jsonb_set(bundle,'{orders}',coalesce((select jsonb_agg(r.record) from public.flow_read_rows('orders') r where exists(select 1 from public.order_items i where i."orderId"=r.id and i.id in(select (j->>'orderItemId')::uuid from jsonb_array_elements(selected) j where j->>'orderItemId' is not null))),'[]'::jsonb));
 end if;
 if (p_table in ('shipments','orders') and p_mode='detail') or (p_table='orders' and p_mode='options') then
  bundle:=jsonb_set(bundle,'{customers}',coalesce((select jsonb_agg(to_jsonb(c)) from public.customers c where c.id in(select (j->>'customerId')::uuid from jsonb_array_elements(selected) j)),'[]'::jsonb));
 end if;
 if p_table in ('products','shipments','service') and p_mode='detail' then
  bundle:=jsonb_set(bundle,'{lots}',coalesce((select jsonb_agg(r.record) from public.flow_read_rows('lots') r where r.id in(select (j->>'lotId')::uuid from jsonb_array_elements(bundle->'products') j where j->>'lotId' is not null)),'[]'::jsonb));
 end if;
 return jsonb_build_object('data',bundle,'rows',selected,'total',total,'page',actual,'pageSize',size);
end $$;
revoke all on function public.flow_query(text,text,text,integer,text,uuid,uuid,uuid,uuid) from public,anon;
grant execute on function public.flow_query(text,text,text,integer,text,uuid,uuid,uuid,uuid) to authenticated;

create or replace function public.flow_summary() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare counts jsonb; metrics jsonb; month_start date:=(date_trunc('month',timezone('Asia/Seoul',now())))::date;
begin
 if public.flow_role() is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 counts:=jsonb_build_object('products',(select count(*) from products),'customers',(select count(*) from customers),'orders',(select count(*) from orders),'shipments',(select count(*) from shipments),'service',(select count(*) from service),'lots',(select count(*) from manufacturing_lots));
 metrics:=jsonb_build_object(
 'products',jsonb_build_array(counts->'products',(select count(*) from flow_products_read where effective_status='재고'),(select count(*) from flow_products_read where effective_status='출고'),(select count(*) from products where inspection='검사대기')),
 'customers',jsonb_build_array(counts->'customers',(select count(distinct "customerId") from shipments),counts->'shipments',(select count(*) from customers where phone<>'')),
 'shipments',jsonb_build_array(counts->'shipments',(select count(*) from shipments where date>=month_start and date<month_start+interval '1 month'),(select count(distinct "customerId") from shipments),(select count(*) from shipments where date is null)),
 'service',jsonb_build_array(counts->'service',(select count(*) from service where completed is null),(select count(*) from service where completed is not null),(select count(*) from service where received>=month_start and received<month_start+interval '1 month')),
 'orders',jsonb_build_array(counts->'orders',(select count(*) from flow_orders_read where effective_stage not in ('완료','취소')),(select count(*) from flow_orders_read where effective_stage='완료'),(select coalesce(sum(remaining),0) from flow_orders_read where stage<>'취소')),
 'lots',jsonb_build_array(counts->'lots',(select count(*) from manufacturing_lots where status='진행중'),(select count(*) from manufacturing_lots where status='마감'),(select count(*) from products where "lotId" is null)));
 return jsonb_build_object('server_paging',true,'counts',counts,'metrics',metrics,'role',public.flow_role(),'serial_auto',true,'serial_manual',true,'customer_code_auto',true,'orders_enabled',true,'quantity_management',true,'service_billing',true,'manufacturing_lots',true,'production_unknown',true,'shipment_date_unknown',true,'data',jsonb_build_object('products','[]'::jsonb,'customers','[]'::jsonb,'orders','[]'::jsonb,'lots','[]'::jsonb,'shipments','[]'::jsonb,'service','[]'::jsonb));
end $$;
revoke all on function public.flow_summary() from public,anon;
grant execute on function public.flow_summary() to authenticated;

create or replace function public.flow_write(p_table text,p_record jsonb default null,p_expected_version integer default null,p_delete boolean default false,p_id uuid default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if public.flow_role() is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 perform set_config('flow.compact','true',true);
 if p_delete then perform public.flow_delete(p_table,p_id,p_expected_version);
 else perform public.flow_save(p_table,p_record,p_expected_version); end if;
 perform set_config('flow.compact','false',true);
 if p_delete then return '{}'::jsonb; end if;
 return public.flow_query(p_table,p_mode=>'detail',p_id=>(p_record->>'id')::uuid);
end $$;
revoke all on function public.flow_write(text,jsonb,integer,boolean,uuid) from public,anon;
grant execute on function public.flow_write(text,jsonb,integer,boolean,uuid) to authenticated;
create index if not exists flow_products_serial_page on public.products(serial,id);
create index if not exists flow_customers_name_page on public.customers(name,id);
create index if not exists flow_shipments_date_page on public.shipments(date desc nulls last,id);
create index if not exists flow_service_received_page on public.service(received desc,id);

notify pgrst, 'reload schema';
commit;
