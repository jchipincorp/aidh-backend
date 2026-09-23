// src/controllers/auth.controller.js
//
// Implements: POST /api/auth/register, /api/auth/signin, /api/auth/verify,
// /api/auth/reset-password, /api/auth/resend-verification -- the exact
// endpoints already named in aidh_website.html's TODO comments.
//
// Critical fix over the current client-side stub: the current build
// validates password strength on the form but never actually stores or
// checks it (see AIDH_Full_Platform_QA_Report.docx, "known open item").
// Here, the password is always hashed before storage and always
// verified with bcrypt.compare on sign-in -- sign-in cannot succeed on
// email existence alone.

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../config/db');
const { logAudit } = require('../lib/audit');
const { hashToken } = require('../lib/tokenHash');

const BCRYPT_ROUNDS = 12;
const JWT_EXPIRES_IN = '7d';
const JWT_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

/** Signs a JWT AND records it in `sessions` (migration 001), so it can
 * later be revoked server-side -- see logout()/logoutAll() below and
 * requireAuth() in middleware/auth.js, which now checks this table on
 * every authenticated request. Previously issueToken only signed the
 * JWT; the sessions table existed in the schema with exactly this
 * purpose but nothing ever wrote to or read from it, so a stolen or
 * leaked token was valid for its full 7-day life with no way to cut it
 * short. req is optional (some internal/test call sites don't have a
 * real request) -- ip/user-agent are just diagnostic context, not part
 * of the revocation check itself. */
async function issueToken(user, req) {
  const token = jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  const expiresAt = new Date(Date.now() + JWT_EXPIRES_IN_SECONDS * 1000);
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [user.id, hashToken(token), req?.ip || null, req?.headers?.['user-agent'] || null, expiresAt]
  );
  return token;
}

async function register(req, res) {
  const { email, password, role = 'subscriber' } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  // Server-side must enforce exactly what aidh_website.html's create-
  // account form already promises the user (8+ chars, a number, a
  // symbol) -- the frontend's checks run before its own fetch call, but
  // never trust client-side-only enforcement for a security-relevant
  // policy: this endpoint is reachable directly (curl, a modified
  // client, anything), and previously accepted any 8-character password
  // with no number or symbol at all, silently weaker than what the UI
  // told the user it required.
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!/[0-9]/.test(password)) return res.status(400).json({ error: 'Password must include at least one number' });
  if (!/[^a-zA-Z0-9]/.test(password)) return res.status(400).json({ error: 'Password must include at least one symbol (e.g. ! @ # $)' });
  if (!['subscriber', 'practitioner'].includes(role)) {
    return res.status(400).json({ error: 'role must be subscriber or practitioner' });
  }

  const existing = await db.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  if (existing.rows.length > 0) return res.status(409).json({ error: 'An account with this email already exists' });

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const userResult = await db.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role`,
    [email, passwordHash, role]
  );
  const user = userResult.rows[0];

  if (role === 'subscriber') {
    await db.query(`INSERT INTO subscriber_profiles (user_id, plan, trial_ends_at) VALUES ($1, 'trial', now() + interval '14 days')`, [user.id]);
  } else {
    const code = 'PRACT-' + crypto.randomInt(1000, 9999);
    await db.query(`INSERT INTO practitioner_profiles (user_id, practitioner_code) VALUES ($1, $2)`, [user.id, code]);
  }

  await logAudit(db, { actorUserId: user.id, actorType: role, actionCategory: 'AUTH', action: 'REGISTERED' });

  // TODO production: send a real verification email (see resendVerification below)
  // rather than auto-issuing a token for an unverified account.
  const token = await issueToken(user, req);
  return res.status(201).json({ token, user: { id: user.id, email: user.email, role: user.role } });
}

async function signin(req, res) {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const result = await db.query('SELECT id, email, password_hash, role FROM users WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL', [email]);
  const user = result.rows[0];

  // Deliberately identical error for "no such user" and "wrong password" --
  // never reveal which one failed, that's a user-enumeration leak.
  const genericError = { error: 'Invalid email or password' };
  if (!user) return res.status(401).json(genericError);

  const passwordMatches = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatches) {
    await logAudit(db, { actorUserId: user.id, actorType: user.role, actionCategory: 'AUTH', action: 'SIGNIN_FAILED', sensitivity: 'sensitive' });
    return res.status(401).json(genericError);
  }

  await logAudit(db, { actorUserId: user.id, actorType: user.role, actionCategory: 'AUTH', action: 'SIGNIN_SUCCESS' });
  const token = await issueToken(user, req);
  return res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
}

async function verifyEmail(req, res) {
  // TODO production: still needs a real, single-use, expiring token sent
  // by email -- verifying an account currently proves nothing about
  // actually controlling that email address, only that the caller is
  // signed in as that user. That's the one gap real email delivery
  // infrastructure closes (see the roadmap: HIPAA/GDPR review ->
  // integration -> real payment/email -> deploy), and it's explicitly
  // still open.
  //
  // What IS fixed here: this used to take a bare userId from the request
  // body with NO authentication at all, so anyone could mark ANY
  // account verified -- ids aren't secret (register()/signin() return
  // them directly to the client). Now derived from the caller's own
  // token, matching the pattern every other authenticated endpoint in
  // this codebase already follows (never trust a client-supplied id for
  // "which account am I acting on" -- see subscriber.controller.js).
  await db.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [req.user.sub]);
  await logAudit(db, { actorUserId: req.user.sub, actorType: req.user.role, actionCategory: 'AUTH', action: 'EMAIL_VERIFIED' });
  res.json({ verified: true });
}

/** Revokes the CALLING request's own session -- the real, server-side
 * counterpart to a client just deleting its local token. Deleting the
 * matching sessions row means requireAuth() (middleware/auth.js) will
 * reject this exact token on its very next use, even though the JWT
 * itself remains cryptographically valid until its 7-day expiry. This
 * is what makes revocation possible at all now; previously there was no
 * way to invalidate a token short of rotating JWT_SECRET globally (which
 * signs everyone out, not just one session). */
async function logout(req, res) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
  }
  await logAudit(db, { actorUserId: req.user.sub, actorType: req.user.role, actionCategory: 'AUTH', action: 'LOGOUT' });
  res.json({ loggedOut: true });
}

/** Revokes EVERY session for the calling user -- "log out everywhere".
 * The natural response to a suspected compromise (e.g. right after a
 * password change, though changing a password isn't implemented yet
 * either -- see the roadmap) or simply wanting to end every other
 * signed-in device at once. */
async function logoutAll(req, res) {
  const result = await db.query('DELETE FROM sessions WHERE user_id = $1 RETURNING id', [req.user.sub]);
  await logAudit(db, { actorUserId: req.user.sub, actorType: req.user.role, actionCategory: 'AUTH', action: 'LOGOUT_ALL' });
  res.json({ loggedOut: true, sessionsRevoked: result.rows.length });
}

module.exports = { register, signin, verifyEmail, logout, logoutAll, issueToken, BCRYPT_ROUNDS };
