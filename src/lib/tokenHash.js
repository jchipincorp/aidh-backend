// src/lib/tokenHash.js
//
// The raw JWT is never stored anywhere -- only its SHA-256 hash, in
// sessions.token_hash (migration 001). Same pattern already used for
// consents.token_hash (consent.controller.js) and password hashing:
// never persist a secret credential in a form that's directly usable if
// the row leaks. A single shared function here keeps issueToken() (which
// writes the hash) and requireAuth()/logout() (which look it up) from
// silently drifting into two different hashing schemes.
const crypto = require('crypto');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { hashToken };
