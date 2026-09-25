import { createClient } from '@supabase/supabase-js';
export const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
export const audit = (actor, action, entity_id, detail = {}) => db.from('audit_logs').insert({ actor, action, entity_id, detail });
