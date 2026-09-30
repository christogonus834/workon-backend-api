import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const PASSWORD = 'Workon2026!';
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

async function main() {
  const { data: profiles, error } = await db.from('profiles').select('id,email').eq('role', 'customer').ilike('email', '%@workon.test');
  if (error) { console.error(error.message); return; }
  for (const p of profiles) {
    const { error: e } = await db.auth.admin.updateUserById(p.id, { password: PASSWORD });
    console.log(e ? ('FAILED ' + p.email + ': ' + e.message) : ('OK ' + p.email));
  }
  console.log('Done. Password for every seeded customer: ' + PASSWORD);
}
main();
