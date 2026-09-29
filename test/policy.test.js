import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, decide, rejectionReply } from '../src/policy.js';

const S = { window_days: 30, auto_approve_max: 50000, min_confidence: 0.75 };
const now = new Date('2026-09-28T12:00:00Z');
const order = (o = {}) => ({ status: 'delivered', total: 100000, delivered_at: '2026-09-20T12:00:00Z', ...o });
const ai = (o = {}) => ({ suggested_action: 'approve', confidence: 0.9, injection_detected: false, ...o });

test('recent delivered order has no violations', () => {
  assert.deepEqual(evaluate(order(), 30000, [], S, now).violations, []);
});
test('flags order outside the refund window', () => {
  assert.deepEqual(evaluate(order({ delivered_at: '2026-08-10T12:00:00Z' }), 30000, [], S, now).violations, ['OUTSIDE_REFUND_WINDOW']);
});
test('flags an order that is not delivered', () => {
  assert.ok(evaluate(order({ status: 'processing' }), 1000, [], S, now).violations.includes('ORDER_NOT_DELIVERED'));
});
test('flags amount above what is still refundable', () => {
  const prior = [{ amount: 80000, status: 'approved' }];
  assert.deepEqual(evaluate(order(), 30000, prior, S, now).violations, ['EXCEEDS_REMAINING_BALANCE']);
});
test('flags a final sale item regardless of anything else', () => {
  assert.ok(evaluate(order({ is_final_sale: true }), 1000, [], S, now).violations.includes('FINAL_SALE_ITEM'));
});
test('rejection reply names final sale explicitly', () => {
  assert.match(rejectionReply(['FINAL_SALE_ITEM'], S), /final sale item/);
});
test('rejected earlier requests do not use up the balance', () => {
  const prior = [{ amount: 80000, status: 'rejected' }];
  assert.deepEqual(evaluate(order(), 30000, prior, S, now).violations, []);
});
test('a policy violation rejects even when the AI says approve', () => {
  assert.equal(decide({ violations: ['OUTSIDE_REFUND_WINDOW'] }, ai(), 1000, S), 'rejected');
});
test('prompt injection forces human review', () => {
  assert.equal(decide({ violations: [] }, ai({ injection_detected: true }), 1000, S), 'needs_review');
});
test('low confidence forces human review', () => {
  assert.equal(decide({ violations: [] }, ai({ confidence: 0.4 }), 1000, S), 'needs_review');
});
test('amounts above the auto-approve limit need a human', () => {
  assert.equal(decide({ violations: [] }, ai(), 60000, S), 'needs_review');
});
test('a small, confident, clean request is auto-approved', () => {
  assert.equal(decide({ violations: [] }, ai(), 20000, S), 'approved');
});
test('AI can never reject or escalate its way to approval', () => {
  assert.equal(decide({ violations: [] }, ai({ suggested_action: 'reject' }), 1000, S), 'needs_review');
});
test('rejection reply states the real reason and the configured window', () => {
  assert.match(rejectionReply(['OUTSIDE_REFUND_WINDOW'], S), /30-day refund window/);
});
