// Seeds ~15 synthetic customers with realistic, varied order histories.
// Run once, locally, against your Supabase project: node seed.js
// Requires .env filled in (SUPABASE_URL, SUPABASE_SERVICE_KEY) — never run this against
// a database you care about keeping clean; it creates real auth users.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

const ITEMS = ['Ergonomic desk chair', 'Mechanical keyboard', '27" monitor', 'Wireless mouse', 'Noise-cancelling headphones', 'Standing desk', 'Laptop stand', 'USB-C dock', 'Webcam 1080p', 'Office desk lamp', 'External SSD 1TB', 'Bluetooth speaker'];

const CUSTOMERS = [
  'amaka.eze', 'tunde.balogun', 'chiamaka.okoro', 'segun.adewale', 'ifeoma.nwosu',
  'kelechi.uche', 'aisha.mohammed', 'emeka.obi', 'funmilayo.ade', 'chinedu.okafor',
  'bola.johnson', 'ngozi.chukwu', 'yusuf.ibrahim', 'temitope.oni', 'grace.udo',
].map((n) => `${n}@workon.test`);

// Deliberately varied so every policy rule has at least one live example to demo:
// mix of recent/old deliveries, small/large amounts, final-sale items, one not-yet-delivered.
function ordersFor(i) {
  const n = 1 + (i % 3); // 1-3 orders per customer
  return Array.from({ length: n }).map((_, j) => {
    const item = rand(ITEMS);
    const total = [8500, 15000, 32000, 65000, 85000, 120000, 180000][Math.floor(Math.random() * 7)];
    const age = [3, 8, 15, 22, 45, 60, 90][Math.floor(Math.random() * 7)]; // some inside, some outside a 30-day window
    return {
      reference: `WK-${2000 + i * 10 + j}`,
      item, total,
      is_final_sale: Math.random() < 0.15, // ~15% final sale, enough to demo the rule
      status: j === 0 && i === 4 ? 'processing' : 'delivered', // one deliberately undelivered order
      delivered_at: daysAgo(age),
    };
  });
}

async function main() {
  console.log(`Seeding ${CUSTOMERS.length} customers...`);
  for (const [i, email] of CUSTOMERS.entries()) {
    const { data: existing } = await db.from('profiles').select('id').eq('email', email).maybeSingle();
    let userId = existing?.id;
    if (!userId) {
      const { data, error } = await db.auth.admin.createUser({ email, password: crypto.randomUUID(), email_confirm: true });
      if (error) { console.warn(`Skip ${email}: ${error.message}`); continue; }
      userId = data.user.id;
      // The signup trigger auto-creates 3 generic demo orders; replace them with our varied set below.
      await db.from('orders').delete().eq('user_id', userId);
    } else {
      console.log(`${email} already exists, refreshing their orders`);
      await db.from('orders').delete().eq('user_id', userId);
    }
    const rows = ordersFor(i).map((o) => ({ ...o, user_id: userId }));
    const { error: insErr } = await db.from('orders').insert(rows);
    if (insErr) console.warn(`Orders for ${email} failed: ${insErr.message}`);
    else console.log(`✓ ${email} — ${rows.length} order(s)`);
  }
  console.log('Done. Every seeded customer can sign in with "Forgot password" from the login screen, or you can reset a password directly in Supabase → Authentication → Users.');
}
main();
