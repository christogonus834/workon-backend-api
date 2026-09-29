create table profiles (id uuid primary key references auth.users on delete cascade, email text not null, role text not null default 'customer' check (role in ('customer','admin')));
create table orders (id uuid primary key default gen_random_uuid(), user_id uuid not null references profiles(id), reference text not null, item text not null, total numeric(12,2) not null, status text not null default 'delivered', is_final_sale boolean not null default false, delivered_at timestamptz);
create table refund_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id), order_id uuid not null references orders(id),
  amount numeric(12,2) not null check (amount > 0), reason text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','needs_review')),
  category text, ai_summary text, confidence numeric, injection_detected boolean default false,
  violations text[] default '{}', draft_reply text, admin_note text, decided_by uuid references profiles(id),
  idempotency_key uuid not null, image_url text, created_at timestamptz default now(), unique (user_id, idempotency_key));
create table audit_logs (id bigserial primary key, actor uuid, action text not null, entity_id uuid, detail jsonb, created_at timestamptz default now());
-- Backend uses the service key; RLS with no policies blocks direct client access.
alter table profiles enable row level security; alter table orders enable row level security;
alter table refund_requests enable row level security; alter table audit_logs enable row level security;
-- Audit log is append-only
create rule audit_no_update as on update to audit_logs do instead nothing;
create rule audit_no_delete as on delete to audit_logs do instead nothing;
-- On signup: create profile + 3 demo orders
create function handle_new_user() returns trigger language plpgsql security definer as $$
begin
  insert into profiles(id,email) values (new.id,new.email);
  insert into orders(user_id,reference,item,total,delivered_at) values
   (new.id,'WK-1001','Ergonomic desk chair',85000,now()-interval '5 days'),
   (new.id,'WK-1002','Mechanical keyboard',32000,now()-interval '12 days'),
   (new.id,'WK-1003','27" monitor',140000,now()-interval '48 days');
  return new; end $$;
create trigger on_signup after insert on auth.users for each row execute function handle_new_user();

-- Storage bucket for refund evidence photos
insert into storage.buckets (id, name, public) values ('refund-evidence', 'refund-evidence', true)
on conflict (id) do nothing;
drop policy if exists "Authenticated users can upload evidence" on storage.objects;
create policy "Authenticated users can upload evidence" on storage.objects
for insert to authenticated with check (bucket_id = 'refund-evidence');
drop policy if exists "Public can view evidence" on storage.objects;
create policy "Public can view evidence" on storage.objects
for select to public using (bucket_id = 'refund-evidence');

-- Realtime for the admin dashboard's live refund queue
alter publication supabase_realtime add table refund_requests;
drop policy if exists "Admins can read refund_requests for realtime" on refund_requests;
create policy "Admins can read refund_requests for realtime" on refund_requests
for select to authenticated
using (exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'));

-- Admin-editable store settings (single row) that drive both the policy engine and the AI's system prompt
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
