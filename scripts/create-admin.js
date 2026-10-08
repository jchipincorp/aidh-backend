// scripts/create-admin.js
//
// Creates the FIRST (or an additional) real admin account. Deliberately
// NOT exposed as an API endpoint: there is no public "become an admin"
// route anywhere in this backend, and there should never be one --
// admin accounts are provisioned out-of-band, by whoever controls this
// server, not self-service. This is the one place a real admin account
// actually gets created.
//
// Reuses BCRYPT_ROUNDS from auth.controller.js (not a separately chosen
// value here) so an admin's password is hashed at exactly the same cost
// as every subscriber's and practitioner's -- two different rounds
// values for the same column would be a silent inconsistency, not a
// security improduction.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/create-admin.js <email> <password> [admin_role]
//   admin_role defaults to 'super_admin' -- the only other real values
//   are 'support' and 'case_reviewer' (see migration 001's admin_role
//   enum), for a narrower account if that's ever wanted instead.
//
// Refuses to run against an email that already has ANY account (any
// role) -- use a different email, or handle a role change by hand in
// psql; this script only ever creates, never promotes an existing user.

const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const { BCRYPT_ROUNDS } = require('../src/controllers/auth.controller');

const VALID_ADMIN_ROLES = ['super_admin', 'support', 'case_reviewer'];

async function createAdmin(pool, email, password, adminRole = 'super_admin') {
  if (!email || !password) {
    throw new Error('Usage: node scripts/create-admin.js <email> <password> [admin_role]');
  }
  if (password.length < 12) {
    throw new Error('Password must be at least 12 characters -- this account can create, edit and delete real published content and review real practitioner/case submissions.');
  }
  if (!VALID_ADMIN_ROLES.includes(adminRole)) {
    throw new Error(`admin_role must be one of: ${VALID_ADMIN_ROLES.join(', ')}`);
  }

  const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  if (existing.rows.length > 0) {
    throw new Error(`An account already exists for ${email}. This script only creates new accounts.`);
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin') RETURNING id, email`,
      [email, passwordHash]
    );
    await client.query(
      `INSERT INTO admin_users (user_id, admin_role) VALUES ($1, $2)`,
      [user.rows[0].id, adminRole]
    );
    await client.query('COMMIT');
    return { id: user.rows[0].id, email: user.rows[0].email, adminRole };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  const [, , email, password, adminRole] = process.argv;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  createAdmin(pool, email, password, adminRole)
    .then((admin) => {
      console.log(`Admin account created: ${admin.email} (${admin.adminRole}).`);
      console.log('Sign in through aidh_website.html\'s normal sign-in form, then open aidh_admin.html -- no separate admin login exists.');
      return pool.end();
    })
    .catch((err) => { console.error(err.message); process.exitCode = 1; return pool.end(); });
}

module.exports = { createAdmin };
