import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db, audit } from './db.js';
import { requireAuth, requireRole, fail } from './auth.js';
import { evaluate, decide } from './policy.js';
import { triage } from './ai.js';

const r = Router();
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const submitLimit = rateLimit({ windowMs: 60_000, limit: 5, keyGenerator: (req) => req.user.id, message: { error: 'Too many requests. Wait a minute.' } });
const uuid = z.string().uuid();

const RefundBody = z.object({
  orderId: z.string().uuid(),
  amount: z.number().positive().max(10_000_000),
  reason: z.string().trim().min(10, 'Tell us a bit more (10+ characters)').max(1000),
  idempotencyKey: z.string().uuid(),
  // Uploaded client-side to Supabase Storage first; only the resulting public URL reaches the API.
  imageUrl: z.string().url().max(500).optional().nullable(),
}).strict();

r.use(requireAuth);
r.get('/me', (req, res) => res.json(req.user));

r.get('/orders', wrap(async (req, res) => {
  const { data } = await db.from('orders').select('id,reference,item,total,status,delivered_at').eq('user_id', req.user.id).order('reference');
  res.json(data);
}));

r.get('/refunds', wrap(async (req, res) => {
  const { data } = await db.from('refund_requests').select('id,amount,status,draft_reply,image_url,created_at,order:orders(reference,item)').eq('user_id', req.user.id).order('created_at', { ascending: false });
  // Unreviewed AI drafts are never shown to customers.
  res.json(data.map(x => ({ ...x, draft_reply: x.status === 'needs_review' ? null : x.draft_reply })));
}));

r.post('/refunds', submitLimit, wrap(async (req, res) => {
  const p = RefundBody.safeParse(req.body);
  if (!p.success) throw fail(400, p.error.issues[0].message);
  const { orderId, amount, reason, idempotencyKey, imageUrl } = p.data;

  const { data: dup } = await db.from('refund_requests').select('id,status,draft_reply').eq('user_id', req.user.id).eq('idempotency_key', idempotencyKey).maybeSingle();
  if (dup) return res.json(dup);

  // Ownership check in the query itself; a foreign ID returns 404 (IDOR).
  const { data: order } = await db.from('orders').select('*').eq('id', orderId).eq('user_id', req.user.id).maybeSingle();
  if (!order) throw fail(404, 'Order not found');

  const { data: prior } = await db.from('refund_requests').select('amount,status').eq('order_id', orderId);
  const policy = evaluate(order, amount, prior);
  const ai = await triage({ reason, item: order.item, amount, violations: policy.violations });
  const status = decide(policy, ai, amount);

  const { data: row, error } = await db.from('refund_requests').insert({
    user_id: req.user.id, order_id: orderId, amount, reason, status, idempotency_key: idempotencyKey, image_url: imageUrl || null,
    category: ai.category, ai_summary: ai.summary, confidence: ai.confidence,
    injection_detected: ai.injection_detected, violations: policy.violations, draft_reply: ai.draft_reply,
  }).select('id,status,draft_reply').single();
  if (error) throw error;
  await audit(req.user.id, 'refund.submitted', row.id, { status, violations: policy.violations, ai });
  res.status(201).json({ ...row, draft_reply: status === 'needs_review' ? null : row.draft_reply });
}));

// Customers may only cancel a request that has not yet been decided — this is a genuine
// self-service action, distinct from editing/reversing a *settled* payment record, which
// stays admin-only and audited (see the Payment Adjustment design in section 6).
r.delete('/refunds/:id', wrap(async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) throw fail(400, 'Invalid request id');
  const { data, error } = await db.from('refund_requests').delete()
    .eq('id', req.params.id).eq('user_id', req.user.id).in('status', ['pending', 'needs_review'])
    .select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw fail(404, 'Request not found or already decided');
  await audit(req.user.id, 'refund.cancelled', data.id, {});
  res.json({ ok: true });
}));

const admin = Router();
admin.use(requireRole('admin'));
admin.get('/refunds', wrap(async (_req, res) => {
  const { data } = await db.from('refund_requests').select('*, order:orders(reference,item,total), customer:profiles!refund_requests_user_id_fkey(email)').order('created_at', { ascending: false }).limit(200);
  res.json(data);
}));

const DecisionBody = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(500).optional(),
  // Optional partial-refund override: admin may approve for less than requested, never more.
  amount: z.number().positive().max(10_000_000).optional(),
}).strict();

admin.post('/refunds/:id/decision', wrap(async (req, res) => {
  const p = DecisionBody.safeParse(req.body);
  if (!p.success || !uuid.safeParse(req.params.id).success) throw fail(400, 'Invalid decision');
  const { decision, note, amount } = p.data;

  const { data: current } = await db.from('refund_requests').select('id,amount,status').eq('id', req.params.id).eq('status', 'needs_review').maybeSingle();
  if (!current) throw fail(409, 'This request is no longer awaiting review');

  const patch = { status: decision, admin_note: note, decided_by: req.user.id };
  if (decision === 'approved' && amount !== undefined) {
    if (amount > Number(current.amount)) throw fail(400, 'Adjusted amount cannot exceed the requested amount');
    patch.amount = amount;
  }
  const { data, error } = await db.from('refund_requests').update(patch).eq('id', req.params.id).eq('status', 'needs_review').select('id,status,amount').maybeSingle();
  if (error) throw error;
  if (!data) throw fail(409, 'This request is no longer awaiting review');
  await audit(req.user.id, `refund.${decision}`, data.id, { note, original_amount: current.amount, final_amount: patch.amount ?? current.amount });
  res.json(data);
}));
r.use('/admin', admin);
export default r;
