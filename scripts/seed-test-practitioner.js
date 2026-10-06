// scripts/seed-test-practitioner.js
//
// Makes a VERIFIED test practitioner on a LOCAL or TEST database, so the Stripe run does not need the long
// profile questionnaire or an admin to verify them. The server must be running (it registers the account through
// the real sign-up endpoint). It refuses to run against anything that is not clearly local or test.
//   node scripts/seed-test-practitioner.js --email prac@test.local --password 'Choose-A-Password-9' [--base-url http://localhost:4001]
require('dotenv').config();
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const email = arg('email'), password = arg('password'), base = arg('base-url', 'http://localhost:4001');
const dbUrl = process.env.DATABASE_URL || '';
if (!email || !password) { console.error('Usage: --email <email> --password <password>'); process.exit(2); }
if (process.env.NODE_ENV === 'production' || !/localhost|127\.0\.0\.1|test|dev/i.test(dbUrl) || /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY || '')) {
  console.error('Refusing: this script is for a local or test database and a TEST Stripe key only.'); process.exit(2);
}
const db = require('../src/config/db');
(async () => {
  const r = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, role: 'practitioner' }) });
  if (r.status !== 201 && r.status !== 409) throw new Error('Sign-up failed: HTTP ' + r.status + ' ' + (await r.text()));
  const u = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  if (!u.rows[0]) throw new Error('The account was not found after sign-up.');
  await db.query(`UPDATE practitioner_profiles SET verification_status = 'verified', first_name = 'Test', last_name = 'Practitioner', city = 'Fairfield', country = 'United States', qualifications = 'Test practitioner (not a real person)' WHERE user_id = $1`, [u.rows[0].id]);
  console.log(`${r.status === 409 ? 'Already existed; updated' : 'Created'}: ${email}, verified, named "Test Practitioner", United States.`);
  console.log('Next: sign in on the website with this email and password, then open aidh_practitioner_console.html.');
  if (db.end) await db.end();
})().catch(async (e) => { console.error('FAILED:', e.message); if (db.end) await db.end(); process.exit(1); });
