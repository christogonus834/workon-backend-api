// Deterministic business rules. The AI can never override these.
export const POLICY = { windowDays: 30, autoApproveMax: 50_000, minConfidence: 0.75 };
const ACTIVE = ['pending', 'approved', 'needs_review'];

export function evaluate(order, amount, priorRefunds, now = new Date()) {
  const violations = [];
  const ageDays = (now - new Date(order.delivered_at)) / 864e5;
  const committed = priorRefunds.filter(r => ACTIVE.includes(r.status)).reduce((s, r) => s + Number(r.amount), 0);
  if (order.status !== 'delivered') violations.push('ORDER_NOT_DELIVERED');
  if (ageDays > POLICY.windowDays) violations.push('OUTSIDE_REFUND_WINDOW');
  if (amount > Number(order.total) - committed) violations.push('EXCEEDS_REMAINING_BALANCE');
  return { violations, ageDays: Math.floor(ageDays) };
}

// Final say lives here: AI may only approve what policy already allows.
export function decide({ violations }, ai, amount) {
  if (violations.length) return 'rejected';
  if (ai.injection_detected || ai.suggested_action !== 'approve') return 'needs_review';
  if (ai.confidence < POLICY.minConfidence || amount > POLICY.autoApproveMax) return 'needs_review';
  return 'approved';
}
