# Workon API (Express + Supabase + Gemini)

## Local
`cp .env.example .env` (fill values) then `npm i && npm run dev`. Run `schema.sql` in the Supabase SQL editor first.
Env: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL` (optional), `CLIENT_ORIGIN` (comma-separated allowed origins).

## Deploy on Render
New Web Service > connect repo. Build: `npm install`. Start: `npm start`. Health check path: `/health`.
Add the env vars above; set `CLIENT_ORIGIN` to your Vercel URL (no trailing slash).

## Flow and security
Validate (zod) > ownership check > policy engine (`policy.js`) > Gemini triage (`ai.js`) > `decide()`.
AI can only approve what policy already allows; injection flags, low confidence or amounts over ₦50,000 go to human review.
Also: JWT verification via Supabase, DB-backed roles, 404 on foreign IDs, idempotency keys, rate limits, helmet, append-only audit log.
Never expose the service key or Gemini key to the frontend.
