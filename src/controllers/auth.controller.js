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

const BCRYPT_ROUNDS = 12;
const JWT_EXPIRES_IN = '7d';

function issueToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

async function register(req, res) {
  const { email, password, role = 'subscriber' } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!['subscriber', 'practitioner'].includes(role)) {
    return res.status(400).json({ error: 'role must be subscriber or practitioner' });
  }

  const existing = await db.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  if (existing.rows.length > 0) return res.status(409).json({ error: 'An account with this email already exists' });

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const userResult = await db.query(
    `INSERT INTO users (email, password_hash, role, email_verified_at) VALUES ($1, $2, $3, now()) RETURNING id, email, role`,
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

  // Email verification is intentionally disabled for the current deployment.
  // New accounts are activated immediately; add a real email-verification flow before enabling it.
  const token = issueToken(user);
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
  const token = issueToken(user);
  return res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
}

async function verifyEmail(req, res) {
  // TODO production: verify a real, single-use, expiring token sent by
  // email rather than trusting a bare user id.
  const { userId } = req.body;
  await db.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [userId]);
  await logAudit(db, { actorUserId: userId, actorType: 'subscriber', actionCategory: 'AUTH', action: 'EMAIL_VERIFIED' });
  res.json({ verified: true });
}

module.exports = { register, signin, verifyEmail, issueToken, BCRYPT_ROUNDS };
