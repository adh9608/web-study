-- Run once in a NEW Supabase project's SQL Editor.
-- Never use a service_role key in the browser.
begin;
create table public.flow_members (
 user_id uuid primary key references auth.users(id) on delete cascade,
 role text not null check (role in ('admin','employee')),
 created_at timestamptz not null default now()
);
create table public.products (
 id uuid primary key,
 serial text not null check (length(btrim(serial)) between 1 and 200),
 code text not null check (length(btrim(code)) between 1 and 200),
 production date not null,
 category text check(category in ('0','1','2')),
 serial_generated boolean not null default false,
 rail text not null default '' check(length(rail)<=200),
 inspection text not null check (inspection in ('검사대기','합격','불합격')),
 status text not null check (status in ('재고','출고')),
 notes text not null default '' check(length(notes)<=2000),
 version integer not null default 1 check(version>0)
);
create unique index products_serial_unique on public.products (lower(btrim(serial)));
create table public.customers (
 id uuid primary key,
 code_generated boolean not null default false,
 code text not null check (length(btrim(code)) between 1 and 200),
 name text not null check (length(btrim(name)) between 1 and 200),
 address text not null default '' check(length(address)<=200),
 phone text not null default '' check(length(phone)<=200),
 notes text not null default '' check(length(notes)<=2000),
 version integer not null default 1 check(version>0)
);
create unique index customers_code_unique on public.customers (lower(btrim(code)));
create table public.shipments (
 id uuid primary key,
 date date not null,
 "customerId" uuid not null references public.customers(id) on delete restrict,
 name text not null check(length(btrim(name)) between 1 and 200),
 "productId" uuid unique references public.products(id) on delete restrict,
 notes text not null default '' check(length(notes)<=2000),
 version integer not null default 1 check(version>0)
);
alter table public.shipments add column quantity integer not null default 1 check(quantity between 1 and 1000000);
create index shipments_customer on public.shipments("customerId");
create table public.service (
 id uuid primary key,
 "productId" uuid not null references public.products(id) on delete restrict,
 model text not null check(length(btrim(model)) between 1 and 200),
 received date not null,
 symptom text not null check(length(btrim(symptom)) between 1 and 2000),
 action text not null default '' check(length(action)<=2000),
 owner text not null default '' check(length(owner)<=200),
 completed date,
 "billingType" text not null default '미정' check("billingType" in ('미정','유상','무상')),
 "chargeAmount" bigint not null default 0 check("chargeAmount" between 0 and 1000000000000),
 "paidAmount" bigint not null default 0 check("paidAmount">=0 and "paidAmount"<="chargeAmount"),
 "paidDate" date,
 check("billingType"='유상' or ("chargeAmount"=0 and "paidAmount"=0 and "paidDate" is null)),
 check(("paidAmount"=0 and "paidDate" is null) or ("paidAmount">0 and "paidDate" is not null)),
 version integer not null default 1 check(version>0),
 check(completed is null or completed >= received)
);
create index service_product on public.service("productId");

-- Members can only read their own role; all role provisioning stays in the dashboard.
alter table public.flow_members enable row level security;
create policy own_membership on public.flow_members for select to authenticated using(user_id=(select auth.uid()));
grant select on public.flow_members to authenticated;
revoke all on public.flow_members from anon;

create function public.flow_role() returns text
language sql stable security definer set search_path = pg_catalog,public
as $$ select role from public.flow_members where user_id=auth.uid() $$;
revoke all on function public.flow_role() from public,anon;
grant execute on function public.flow_role() to authenticated;

alter table public.products enable row level security;
alter table public.customers enable row level security;
alter table public.shipments enable row level security;
alter table public.service enable row level security;
create policy staff_read on public.products for select to authenticated using ((select public.flow_role()) in ('admin','employee'));
create policy staff_read on public.customers for select to authenticated using ((select public.flow_role()) in ('admin','employee'));
create policy staff_read on public.shipments for select to authenticated using ((select public.flow_role()) in ('admin','employee'));
create policy staff_read on public.service for select to authenticated using ((select public.flow_role()) in ('admin','employee'));
revoke all on public.products,public.customers,public.shipments,public.service from anon,authenticated;
grant select on public.products,public.customers,public.shipments,public.service to authenticated;
-- No direct INSERT/UPDATE/DELETE privileges. Mutations use verified RPCs below.

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
 tracking_mode text not null default 'serial' check(tracking_mode in ('serial','quantity')),
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

create function public.flow_snapshot() returns jsonb
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

create function public.flow_save(p_table text,p_record jsonb,p_expected_version integer default null) returns jsonb
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

create function public.flow_delete(p_table text,p_id uuid,p_expected_version integer) returns jsonb
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

commit;
