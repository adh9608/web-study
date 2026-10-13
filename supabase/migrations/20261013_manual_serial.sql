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


notify pgrst, 'reload schema';
commit;
