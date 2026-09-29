import { db } from './db.js';

export const DEFAULTS = {
  window_days: 30,
  auto_approve_max: 50000,
  min_confidence: 0.75,
  policy_text: 'Refunds are available within 30 days of delivery for items that arrive damaged, defective, or not as described. Change-of-mind returns are reviewed case by case. Requests over the auto-approval limit are always reviewed by a support agent.',
};

let cache = { at: 0, value: DEFAULTS };

// Admin-editable rules live in the DB. Falls back to defaults if the table is missing,
// so a forgotten migration degrades to the old behaviour instead of breaking refunds.
export async function getSettings(force = false) {
  if (!force && Date.now() - cache.at < 15_000) return cache.value;
  const { data, error } = await db.from('settings').select('*').eq('id', 1).maybeSingle();
  const value = error || !data ? DEFAULTS : {
    ...DEFAULTS, ...data,
    window_days: Number(data.window_days), auto_approve_max: Number(data.auto_approve_max), min_confidence: Number(data.min_confidence),
  };
  cache = { at: Date.now(), value };
  return value;
}
export const bustSettings = () => { cache.at = 0; };
