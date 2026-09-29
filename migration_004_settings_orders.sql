-- Run once in Supabase SQL Editor if your database already exists.
-- (New setups: already included in schema.sql.)

create table if not exists settings (
  id int primary key default 1,
  window_days int not null default 30,
  auto_approve_max numeric(12,2) not null default 50000,
  min_confidence numeric(3,2) not null default 0.75,
  policy_text text not null default 'Refunds are available within 30 days of delivery for items that arrive damaged, defective, or not as described. Change-of-mind returns are reviewed case by case. Requests over the auto-approval limit are always reviewed by a support agent.',
  constraint settings_singleton check (id = 1)
);
insert into settings (id) values (1) on conflict (id) do nothing;
alter table settings enable row level security;
-- No policies: the frontend never talks to this table directly, only the backend (service key)
-- reads/writes it, exactly like every other admin-only table in this schema.
