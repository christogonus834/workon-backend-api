-- Run this once in Supabase SQL Editor to enable live updates on the admin queue.
-- (New setups: this is already included in schema.sql — no need to run it separately.)

-- Realtime only sends change events for tables added to this publication.
alter publication supabase_realtime add table refund_requests;

-- The admin dashboard subscribes directly from the browser (anon key + user's JWT),
-- bypassing the backend, so it needs its own RLS policy — scoped to admins only,
-- consistent with the rest of the access model (see 1.4 Access Control).
drop policy if exists "Admins can read refund_requests for realtime" on refund_requests;
create policy "Admins can read refund_requests for realtime" on refund_requests
for select to authenticated
using (exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'));
