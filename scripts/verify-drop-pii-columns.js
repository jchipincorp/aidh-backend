// scripts/verify-drop-pii-columns.js
//
// Verifies migration 010 against REAL PostgreSQL (the test suite's in-memory engine has no
// PL/pgSQL, so it cannot exercise the safety check). In a throwaway database it:
//   1. applies migrations 001-009 and plants a real value in date_of_birth,
//   2. runs 010 and confirms it REFUSES, with its own message, and the columns still exist,
//   3. clears the value, runs 010 again, and confirms the columns are gone.
// Usage: DATABASE_URL=postgres://user:pass@host:5432/anydb node scripts/verify-drop-pii-columns.js
const fs = require('fs'); const path = require('path'); const { Client } = require('pg');
let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name); };
(async () => {
  const base = new URL(process.env.DATABASE_URL);
  const tmpName = 'aidh_drop_pii_check';
  const admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${tmpName}`); await admin.query(`CREATE DATABASE ${tmpName}`); await admin.end();
  const u = new URL(base); u.pathname = '/' + tmpName;
  const db = new Client({ connectionString: u.toString() }); await db.connect();
  const dir = path.join(__dirname, '..', 'src', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const m010 = files.find((f) => f.startsWith('010_'));
  for (const f of files.filter((f) => f < '010')) await db.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  const cols = async () => (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='subscriber_profiles' AND column_name IN ('date_of_birth','gp_name') ORDER BY 1`)).rows.map((r) => r.column_name);
  check('before 010: both columns exist', JSON.stringify(await cols()) === '["date_of_birth","gp_name"]');
  const u1 = await db.query(`INSERT INTO users (email, password_hash, role) VALUES ('guard@test.com','x','subscriber') RETURNING id`);
  await db.query(`INSERT INTO subscriber_profiles (user_id, date_of_birth) VALUES ($1,'1990-01-01')`, [u1.rows[0].id]);
  let refused = null;
  try { await db.query(fs.readFileSync(path.join(dir, m010), 'utf8')); } catch (e) { refused = e; }
  check('010 REFUSES to run while a value exists, with its own message', !!refused && /Refusing to drop subscriber_profiles/.test(refused.message));
  check('after the refusal: both columns still exist and the value is intact', JSON.stringify(await cols()) === '["date_of_birth","gp_name"]'
    && (await db.query('SELECT date_of_birth FROM subscriber_profiles')).rows.length === 1);
  await db.query(`UPDATE subscriber_profiles SET date_of_birth = NULL`);
  let ok = true; try { await db.query(fs.readFileSync(path.join(dir, m010), 'utf8')); } catch (e) { ok = false; console.log(e.message); }
  check('010 runs once the values are cleared', ok);
  check('after 010: both columns are gone', (await cols()).length === 0);
  check('the subscriber row and its other columns are untouched', (await db.query('SELECT plan FROM subscriber_profiles')).rows.length === 1);
  await db.end();
  const admin2 = new Client({ connectionString: process.env.DATABASE_URL }); await admin2.connect();
  await admin2.query(`DROP DATABASE IF EXISTS ${tmpName}`); await admin2.end();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('CRASHED:', e.message); process.exit(1); });
