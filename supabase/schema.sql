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
 rail text not null default '' check(length(rail)<=200),
 inspection text not null check (inspection in ('검사대기','합격','불합격')),
 status text not null check (status in ('재고','출고')),
 notes text not null default '' check(length(notes)<=2000),
 version integer not null default 1 check(version>0)
);
create unique index products_serial_unique on public.products (lower(btrim(serial)));
create table public.customers (
 id uuid primary key,
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
 "productId" uuid not null unique references public.products(id) on delete restrict,
 notes text not null default '' check(length(notes)<=2000),
 version integer not null default 1 check(version>0)
);
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

create function public.flow_snapshot() returns jsonb
language plpgsql security definer set search_path = pg_catalog,public
as $$
declare member_role text;
begin
 member_role:=public.flow_role();
 if member_role is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 return jsonb_build_object('role',member_role,'data',jsonb_build_object(
  'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.serial) from public.products p),'[]'::jsonb),
  'customers',coalesce((select jsonb_agg(to_jsonb(c) order by c.name) from public.customers c),'[]'::jsonb),
  'shipments',coalesce((select jsonb_agg(to_jsonb(s) order by s.date desc,s.id) from public.shipments s),'[]'::jsonb),
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
 execute format('insert into public.%1$I (%2$s) select %2$s from jsonb_populate_record(null::public.%1$I,$1) on conflict(id) do update set %3$s',p_table,col_list,assignments) using payload;
 if p_table='products' and exists(select 1 from public.shipments s join public.products p on p.id=s."productId" where p.id=record_id and s.date<p.production) then
  raise exception 'SHIPMENT_DATE';
 end if;
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
 if p_table not in ('products','customers','shipments','service') or p_table is null then raise exception 'INVALID_TABLE'; end if;
 perform pg_advisory_xact_lock(83421671);
 execute format('select version from public.%I where id=$1 for update',p_table) into current_version using p_id;
 if current_version is null or current_version is distinct from p_expected_version then raise exception 'STALE_RECORD'; end if;
 execute format('delete from public.%I where id=$1',p_table) using p_id;
 return public.flow_snapshot();
end $$;
revoke all on function public.flow_delete(text,uuid,integer) from public,anon;
grant execute on function public.flow_delete(text,uuid,integer) to authenticated;
commit;
