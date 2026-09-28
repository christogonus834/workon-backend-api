# Workon API (Express + Supabase + Gemini)

## 1. Create a Supabase project
Go to supabase.com > New project. Once ready, open **Settings > API** and copy the **Project URL** and the **service_role** key (not anon).
Open the **SQL Editor**, paste the contents of `schema.sql`, and run it — this also creates the `refund-evidence` storage bucket used for photo uploads.
Go to **Authentication > Providers > Email** and turn off "Confirm email" so local sign-ups don't need a real inbox.

> Already ran `schema.sql` before this update? Run `migration_002_images.sql` and `migration_003_realtime.sql` once each instead of the whole schema again.

## 2. Get AI provider keys
- **Gemini (primary):** aistudio.google.com/apikey — create a key.
- **Groq (backup, optional but recommended):** console.groq.com/keys — free key. Used only if every Gemini model fails.

Both keys go in the backend only — never the frontend.

## 3. Configure and run
```
cp .env.example .env
```
Fill in `.env`:
- `SUPABASE_URL` — the Project URL from step 1
- `SUPABASE_SERVICE_KEY` — the service_role key from step 1
- `GEMINI_API_KEY` — from step 2
- `GEMINI_MODEL` — optional; leave blank to let the app try its built-in list automatically
- `GROQ_API_KEY` — optional backup provider from step 2
- `GROQ_MODEL` — optional override; leave blank to use the built-in list
- `CLIENT_ORIGIN` — leave as http://localhost:5173 for local dev

```
npm i
npm run dev
```
You should see `Workon API ready` on port 4000.

## 4. Create test accounts
Once the frontend (see its own README) is running, sign up with any email/password (8+ chars) — this becomes a customer account with 3 demo orders auto-created. Sign up a second email for the admin account.
Back in Supabase's SQL editor, run:
```sql
update profiles set role = 'admin' where email = 'your-second-email@example.com';
```
Sign in as that account to see the support dashboard.

## Deploy on Render
New Web Service > connect repo. Build: `npm install`. Start: `npm start`. Health check path: `/health`.
Add the same env vars as above; set `CLIENT_ORIGIN` to your deployed Vercel URL (no trailing slash) once the frontend is live.

## Flow and security
Validate (zod) > ownership check > policy engine (`policy.js`) > AI triage (`ai.js`) > `decide()`.
AI can only approve what policy already allows; injection flags, low confidence, or amounts over ₦50,000 go to human review.
Also: JWT verification via Supabase, DB-backed roles (never trusted from the client), 404 on foreign IDs (IDOR prevention), idempotency keys, rate limits, helmet, append-only audit log.
Never expose the service key or either AI key to the frontend.

## AI provider fallback chain
A single hardcoded model name is a single point of failure — providers rename or retire models over time. `ai.js` instead tries a list, in order, and only gives up if every option fails:
1. Gemini models: `gemini-2.5-flash` → `gemini-2.5-flash-lite` → `gemini-2.0-flash` → `gemini-1.5-flash` → `gemini-1.5-flash-8b` (or `GEMINI_MODEL` first, if set).
2. If every Gemini model fails: Groq models: `llama-3.3-70b-versatile` → `llama-3.1-8b-instant` → `gemma2-9b-it` (or `GROQ_MODEL` first, if set).
3. If every model on both providers fails: a safe fallback response (`needs_review`, 0% confidence) — the refund is never lost, it just always lands in front of a human.

Render logs show exactly which model/provider succeeded (`AI triage OK — Gemini/gemini-2.5-flash`) or why each one failed, so a bad key or dead model name is visible immediately instead of hiding behind a generic error.

## Admin dashboard extras
- **Live queue:** the admin dashboard subscribes to Postgres changes on `refund_requests` directly (Supabase Realtime), so a new or updated request appears without refreshing. Scoped to admins only via its own RLS policy (`migration_003_realtime.sql`) — customers cannot subscribe to other people's rows.
- **CSV export:** the currently filtered tab (In review / Everything) exports to a `.csv` file client-side — no extra backend endpoint needed.
- **Partial refunds:** admin can lower the approved amount before confirming (never raise it above what was requested).
- **Photo evidence:** customers can attach a photo to a refund request, stored in the `refund-evidence` Supabase Storage bucket and shown to the admin during review.
