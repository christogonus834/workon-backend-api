import { db } from './db.js';
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

export async function requireAuth(req, _res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) throw fail(401, 'Sign in to continue');
    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user) throw fail(401, 'Session expired. Sign in again');
    const { data: profile } = await db.from('profiles').select('id,email,role').eq('id', data.user.id).single();
    if (!profile) throw fail(401, 'Account not found');
    req.user = profile;
    next();
  } catch (e) { next(e); }
}
// Role always comes from the database, never from the client or token claims.
export const requireRole = (role) => (req, _res, next) =>
  req.user.role === role ? next() : next(fail(404, 'Not found'));
export { fail };
