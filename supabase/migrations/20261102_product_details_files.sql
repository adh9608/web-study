-- Incremental update: apply 20261024_server_pagination.sql first on older databases.
-- Supabase Storage must be installed (standard hosted Supabase projects include it).
begin;
-- Product detail fetches one product and its real relationships, not the whole database.
create or replace function public.flow_product_detail(p_id uuid,p_service_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare p jsonb; s jsonb; o jsonb; c jsonb; l jsonb; repairs jsonb; n bigint; pg integer;
begin
 if public.flow_role() is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 select record into p from public.flow_read_rows('products') where id=p_id;
 if p is null then raise exception 'PRODUCT_NOT_FOUND'; end if;
 select to_jsonb(x) into s from public.flow_shipments_read x where x."productId"=p_id;
 if s is not null then
  select to_jsonb(x) into c from public.customers x where x.id=(s->>'customerId')::uuid;
  select to_jsonb(x) into o from public.flow_orders_read x join public.order_items i on i."orderId"=x.id where i.id=(s->>'orderItemId')::uuid;
 end if;
 select to_jsonb(x) into l from public.flow_lots_read x where x.id=(p->>'lotId')::uuid;
 select count(*) into n from public.service where "productId"=p_id;
 pg:=least(greatest(coalesce(p_service_page,1),1),greatest(1,ceil(n::numeric/20)::integer));
 select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into repairs from (
  select * from public.flow_service_read where "productId"=p_id order by received desc,id limit 20 offset (pg-1)*20
 ) x;
 return jsonb_build_object('product',p,'customer',c,'shipment',s,'order',o,'lot',l,'service',repairs,'service_total',n,'service_page',pg,'role',public.flow_role(),'files_enabled',to_regprocedure('public.flow_product_files(uuid,integer)') is not null);
end $$;
revoke all on function public.flow_product_detail(uuid,integer) from public,anon;
grant execute on function public.flow_product_detail(uuid,integer) to authenticated;
-- Private Storage bucket: images and PDFs, up to 10 MiB per file.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('product-files','product-files',false,10485760,array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create or replace function public.flow_file_product(p_name text) returns uuid
language plpgsql immutable set search_path=pg_catalog,public as $$
begin
 if p_name !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[^/]+$' or p_name !~* '\.(pdf|jpe?g|png|webp)$' then return null; end if;
 return split_part(p_name,'/',1)::uuid;
exception when invalid_text_representation then return null;
end $$;
revoke all on function public.flow_file_product(text) from public,anon;
grant execute on function public.flow_file_product(text) to authenticated;

drop policy if exists flow_files_read on storage.objects;
create policy flow_files_read on storage.objects for select to authenticated
using(bucket_id='product-files' and public.flow_role() is not null and exists(select 1 from public.products where id=public.flow_file_product(name)));
drop policy if exists flow_files_insert on storage.objects;
create policy flow_files_insert on storage.objects for insert to authenticated
with check(bucket_id='product-files' and public.flow_role() is not null and exists(select 1 from public.products where id=public.flow_file_product(name)));
drop policy if exists flow_files_delete on storage.objects;
create policy flow_files_delete on storage.objects for delete to authenticated
using(bucket_id='product-files' and public.flow_role()='admin');
-- No UPDATE policy: files cannot be overwritten; replacement uses a new unique path.

create or replace function public.flow_file_insert_guard() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare pid uuid;
begin
 if new.bucket_id<>'product-files' then return new; end if;
 pid:=public.flow_file_product(new.name);
 if pid is null then raise exception 'INVALID_FILE_PATH'; end if;
 perform pg_advisory_xact_lock(hashtextextended('flow-product-files:'||pid::text,0));
 if not exists(select 1 from public.products where id=pid) then raise exception 'PRODUCT_NOT_FOUND'; end if;
 return new;
end $$;
revoke all on function public.flow_file_insert_guard() from public,anon,authenticated;
drop trigger if exists flow_file_insert_guard on storage.objects;
create trigger flow_file_insert_guard before insert on storage.objects for each row execute function public.flow_file_insert_guard();

create or replace function public.flow_product_file_delete_guard() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('flow-product-files:'||old.id::text,0));
 if exists(select 1 from storage.objects where bucket_id='product-files' and name like old.id::text||'/%') then raise exception 'PRODUCT_HAS_FILES'; end if;
 return old;
end $$;
revoke all on function public.flow_product_file_delete_guard() from public,anon,authenticated;
drop trigger if exists flow_product_file_delete_guard on public.products;
create trigger flow_product_file_delete_guard before delete on public.products for each row execute function public.flow_product_file_delete_guard();

create or replace function public.flow_product_files(p_id uuid,p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare n bigint; pg integer; files jsonb;
begin
 if public.flow_role() is null then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 if not exists(select 1 from public.products where id=p_id) then raise exception 'PRODUCT_NOT_FOUND'; end if;
 select count(*) into n from storage.objects where bucket_id='product-files' and name like p_id::text||'/%';
 pg:=least(greatest(coalesce(p_page,1),1),greatest(1,ceil(n::numeric/20)::integer));
 select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into files from (
 select name as path,coalesce(nullif(user_metadata->>'originalName',''),split_part(name,'/',3)) as name,created_at,metadata->>'size' as size,metadata->>'mimetype' as mime
 from storage.objects where bucket_id='product-files' and name like p_id::text||'/%' order by created_at desc,id limit 20 offset (pg-1)*20
 ) x;
 return jsonb_build_object('files',files,'total',n,'page',pg,'page_size',20);
end $$;
revoke all on function public.flow_product_files(uuid,integer) from public,anon;
grant execute on function public.flow_product_files(uuid,integer) to authenticated;

notify pgrst, 'reload schema';
commit;
