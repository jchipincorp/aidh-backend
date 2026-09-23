// src/config/db.js
// Real pg Pool for production. Tests substitute this with a pg-mem
// adapter that implements the same interface -- see tests/setup.js.
const { Pool } = require('pg');

// DATABASE_SSL=true used to set { rejectUnauthorized: false }, which
// accepts ANY certificate -- including a forged one -- and isn't real
// transport security for a connection carrying health data. Found
// during HIPAA/GDPR review (see README "Compliance hardening").
// Default now verifies the cert chain properly. DATABASE_SSL_INSECURE
// is an explicit, separate opt-out for local dev against a self-signed
// cert only -- it must never be set in any real deployment.
function sslConfig() {
  if (process.env.DATABASE_SSL !== 'true') return false;
  if (process.env.DATABASE_SSL_INSECURE === 'true') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig(),
});

pool.on('error', (err) => {
  // A crashed idle client should not crash the whole process.
  console.error('Unexpected error on idle database client', err);
});

module.exports = pool;
