import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db, audit } from './db.js';
import { requireAuth, requireRole, fail } from './auth.js';
import { evaluate, decide, rejectionReply } from './policy.js';
import { triage, probe } from './ai.js';
import { getSettings, bustSettings, DEFAULTS } from './settings.js';

const r = Router();
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const submitLimit = rateLimit({ windowMs: 60_000, limit: 5, keyGenerator: (req) => req.user.id, message: { error: 'Too many requests. Wait a minute.' } });
const uuid = z.string().uuid();

const RefundBody = z.object({
  orderId: z.string().uuid(),
  amount: z.number().positive().max(10_000_000),
  reason: z.string().trim().min(10, 'Tell us a bit more (10+ characters)').max(1000),
  idempotencyKey: z.string().uuid(),
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
  res.json(data.map(x => ({ ...x, draft_reply: x.status === 'needs_review' ? null : x.draft_reply })));
}));

r.post('/refunds', submitLimit, wrap(async (req, res) => {
  const p = RefundBody.safeParse(req.body);
  if (!p.success) throw fail(400, p.error.issues[0].message);
  const { orderId, amount, reason, idempotencyKey, imageUrl } = p.data;

  const { data: dup } = await db.from('refund_requests').select('id,status,draft_reply').eq('user_id', req.user.id).eq('idempotency_key', idempotencyKey).maybeSingle();
  if (dup) return res.json(dup);

  const { data: order } = await db.from('orders').select('*').eq('id', orderId).eq('user_id', req.user.id).maybeSingle();
  if (!order) throw fail(404, 'Order not found');

  const s = await getSettings();
  const { data: prior } = await db.from('refund_requests').select('amount,status').eq('order_id', orderId);
  const policy = evaluate(order, amount, prior, s);

  // Ask the AI first (it also classifies rejected requests, useful for the admin's "by reason" chart),
  // but for a policy violation the customer-facing reply always comes from code, never the model —
  // this is what stops a rejected request ever being told "under review" (see policy.js rejectionReply).
  const ai = await triage({ reason, item: order.item, amount, violations: policy.violations, policyText: s.policy_text });
  const status = decide(policy, ai, amount, s);
  const draft_reply = status === 'rejected' ? rejectionReply(policy.violations, s) : ai.draft_reply;

  const { data: row, error } = await db.from('refund_requests').insert({
    user_id: req.user.id, order_id: orderId, amount, reason, status, idempotency_key: idempotencyKey, image_url: imageUrl || null,
    category: ai.category, ai_summary: ai.summary, confidence: ai.confidence,
    injection_detected: ai.injection_detected, violations: policy.violations, draft_reply,
  }).select('id,status,draft_reply').single();
  if (error) throw error;
  await audit(req.user.id, 'refund.submitted', row.id, { status, violations: policy.violations, ai });
  res.status(201).json({ ...row, draft_reply: status === 'needs_review' ? null : row.draft_reply });
}));

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

const DecisionBody = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(500).optional(), amount: z.number().positive().max(10_000_000).optional() }).strict();
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

// ---- Orders CRUD (admin) ----
const OrderBody = z.object({
  userId: z.string().uuid(),
  reference: z.string().trim().min(1).max(40),
  item: z.string().trim().min(1).max(200),
  total: z.number().positive().max(10_000_000),
  status: z.enum(['delivered', 'processing', 'cancelled']).default('delivered'),
  deliveredAt: z.string().datetime().optional(),
}).strict();

admin.get('/customers', wrap(async (_req, res) => {
  const { data } = await db.from('profiles').select('id,email').eq('role', 'customer').order('email');
  res.json(data);
}));

admin.get('/orders', wrap(async (_req, res) => {
  const { data } = await db.from('orders').select('*, customer:profiles!orders_user_id_fkey(email)').order('reference');
  res.json(data);
}));

admin.post('/orders', wrap(async (req, res) => {
  const p = OrderBody.safeParse(req.body);
  if (!p.success) throw fail(400, p.error.issues[0].message);
  const { userId, reference, item, total, status, deliveredAt } = p.data;
  const { data, error } = await db.from('orders').insert({ user_id: userId, reference, item, total, status, delivered_at: deliveredAt || new Date().toISOString() }).select().single();
  if (error) throw error;
  await audit(req.user.id, 'order.created', data.id, { reference, item, total });
  res.status(201).json(data);
}));

admin.put('/orders/:id', wrap(async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) throw fail(400, 'Invalid order id');
  const p = OrderBody.partial().safeParse(req.body);
  if (!p.success) throw fail(400, p.error.issues[0].message);
  const patch = {};
  if (p.data.reference !== undefined) patch.reference = p.data.reference;
  if (p.data.item !== undefined) patch.item = p.data.item;
  if (p.data.total !== undefined) patch.total = p.data.total;
  if (p.data.status !== undefined) patch.status = p.data.status;
  if (p.data.deliveredAt !== undefined) patch.delivered_at = p.data.deliveredAt;
  const { data, error } = await db.from('orders').update(patch).eq('id', req.params.id).select().maybeSingle();
  if (error) throw error;
  if (!data) throw fail(404, 'Order not found');
  await audit(req.user.id, 'order.updated', data.id, patch);
  res.json(data);
}));

admin.delete('/orders/:id', wrap(async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) throw fail(400, 'Invalid order id');
  // Financial history is never deleted once a refund exists against it (insert-only ledger principle) —
  // only an order with no refund requests at all may be removed.
  const { count } = await db.from('refund_requests').select('id', { count: 'exact', head: true }).eq('order_id', req.params.id);
  if (count > 0) throw fail(409, 'Cannot delete an order that has refund requests. Its history must stay intact.');
  const { data, error } = await db.from('orders').delete().eq('id', req.params.id).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw fail(404, 'Order not found');
  await audit(req.user.id, 'order.deleted', data.id, {});
  res.json({ ok: true });
}));

// ---- Store settings (admin) ----
const SettingsBody = z.object({
  window_days: z.number().int().min(1).max(365),
  auto_approve_max: z.number().min(0).max(10_000_000),
  min_confidence: z.number().min(0).max(1),
  policy_text: z.string().trim().min(10).max(4000),
}).strict();

admin.get('/settings', wrap(async (_req, res) => res.json(await getSettings(true))));
admin.put('/settings', wrap(async (req, res) => {
  const p = SettingsBody.safeParse(req.body);
  if (!p.success) throw fail(400, p.error.issues[0].message);
  const { data, error } = await db.from('settings').upsert({ id: 1, ...p.data }).select().single();
  if (error) throw error;
  bustSettings();
  await audit(req.user.id, 'settings.updated', null, p.data);
  res.json(data);
}));
admin.post('/settings/reset', wrap(async (req, res) => {
  const { data, error } = await db.from('settings').upsert({ id: 1, ...DEFAULTS }).select().single();
  if (error) throw error;
  bustSettings();
  await audit(req.user.id, 'settings.reset', null, DEFAULTS);
  res.json(data);
}));

// ---- AI health probe (admin) ----
admin.get('/ai/probe', wrap(async (_req, res) => res.json(await probe())));

r.use('/admin', admin);
export default r;
