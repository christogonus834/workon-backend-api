// Deterministic business rules. The AI can never override these.
// Thresholds come from the admin-editable settings row (see settings.js).
const ACTIVE = ['pending', 'approved', 'needs_review'];

export function evaluate(order, amount, priorRefunds, s, now = new Date()) {
  const violations = [];
  const ageDays = (now - new Date(order.delivered_at)) / 864e5;
  const committed = priorRefunds.filter(r => ACTIVE.includes(r.status)).reduce((sum, r) => sum + Number(r.amount), 0);
  if (order.status !== 'delivered') violations.push('ORDER_NOT_DELIVERED');
  if (!(ageDays <= s.window_days)) violations.push('OUTSIDE_REFUND_WINDOW');
  if (amount > Number(order.total) - committed) violations.push('EXCEEDS_REMAINING_BALANCE');
  return { violations, ageDays: Math.floor(ageDays) };
}

// Final say lives here: AI may only approve what policy already allows.
export function decide({ violations }, ai, amount, s) {
  if (violations.length) return 'rejected';
  if (ai.injection_detected || ai.suggested_action !== 'approve') return 'needs_review';
  if (ai.confidence < Number(s.min_confidence) || amount > Number(s.auto_approve_max)) return 'needs_review';
  return 'approved';
}

// Customer-facing text for policy rejections comes from code, never from the AI,
// so a rejected request can never be described as "under review".
const MESSAGES = {
  ORDER_NOT_DELIVERED: () => 'this order has not been delivered yet',
  OUTSIDE_REFUND_WINDOW: (s) => `it is outside our ${s.window_days}-day refund window`,
  EXCEEDS_REMAINING_BALANCE: () => 'the amount is more than what is still refundable on this order',
};
export function rejectionReply(violations, s) {
  const reasons = violations.map(v => MESSAGES[v]?.(s)).filter(Boolean);
  return `We're sorry, we can't refund this request because ${reasons.join(' and ') || 'it does not meet our refund policy'}.`;
}
