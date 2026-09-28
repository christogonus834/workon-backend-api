-- Run this once in Supabase SQL Editor if your database already exists.
-- (New setups: this is already included in schema.sql — no need to run it separately.)

alter table refund_requests add column if not exists image_url text;

insert into storage.buckets (id, name, public) values ('refund-evidence', 'refund-evidence', true)
on conflict (id) do nothing;

drop policy if exists "Authenticated users can upload evidence" on storage.objects;
create policy "Authenticated users can upload evidence" on storage.objects
for insert to authenticated with check (bucket_id = 'refund-evidence');

drop policy if exists "Public can view evidence" on storage.objects;
create policy "Public can view evidence" on storage.objects
for select to public using (bucket_id = 'refund-evidence');
