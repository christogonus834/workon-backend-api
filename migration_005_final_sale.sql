-- Run once in Supabase SQL Editor if your database already exists.
-- (New setups: already included in schema.sql.)
alter table orders add column if not exists is_final_sale boolean not null default false;
