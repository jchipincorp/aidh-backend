// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { hashToken } = require('../lib/tokenHash');

/** Verifies a real, server-issued JWT AND that it hasn't been revoked.
 * This is the direct replacement for the current client-side
 * sessionStorage flag, which any user can set manually via browser dev
 * tools -- see AIDH_Full_Platform_QA_Report.docx Section 6, "known open
 * item".
 *
 * The sessions-table check is new: a syntactically valid, signature-
 * verified JWT used to be accepted unconditionally for its full 7-day
 * life, with no way to cut a specific session short (a stolen token was
 * valid until it simply expired). Every authenticated request now also
 * confirms a matching, unexpired row still exists in `sessions`
 * (migration 001) -- deleted by logout()/logoutAll() (auth.controller.js)
 * or GDPR account deletion (which cascades via ON DELETE CASCADE on
 * user_id, already covered by existing tests). This adds one indexed
 * lookup per authenticated request -- a deliberate, standard trade-off
 * for real revocation capability. */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  try {
    const session = await db.query(
      'SELECT 1 FROM sessions WHERE token_hash = $1 AND expires_at > now()',
      [hashToken(token)]
    );
    if (session.rows.length === 0) {
      return res.status(401).json({ error: 'Session has been revoked or has expired. Please sign in again.' });
    }
  } catch (err) {
    return next(err); // let errorHandler.js handle a real DB failure -- never silently skip the revocation check
  }

  req.user = payload; // { sub: userId, role }
  next();
}

/** Restricts a route to one or more roles. Use after requireAuth. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
