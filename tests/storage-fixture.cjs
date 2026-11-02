// Minimal Storage schema for PostgreSQL policy tests; actual object transport is tested separately.
module.exports = async function storageFixture(db) {
  await db.exec(`create schema storage;
    create table storage.buckets(id text primary key,name text not null,public boolean default false,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,metadata jsonb,user_metadata jsonb,created_at timestamptz default now(),unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated,anon;
    grant select,insert,update,delete on storage.objects to authenticated,anon;
    grant select on storage.buckets to authenticated;`);
};
