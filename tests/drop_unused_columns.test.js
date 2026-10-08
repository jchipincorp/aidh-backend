// tests/drop_unused_columns.test.js
//
// Migration 010 removes subscriber_profiles.date_of_birth and gp_name, which nothing
// reads or writes. This confirms the migrated schema no longer has them and that the
// subscriber flows that use the table are unaffected. The migration's own safety check
// (refuse to drop if any value exists) needs real PostgreSQL's PL/pgSQL and is verified
// by scripts/verify-drop-pii-columns.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTestDb } = require('./setup');

test('subscriber_profiles no longer has date_of_birth or gp_name', async () => {
  const pool = buildTestDb();
  await assert.rejects(() => pool.query('SELECT date_of_birth FROM subscriber_profiles'), 'date_of_birth must be gone');
  await assert.rejects(() => pool.query('SELECT gp_name FROM subscriber_profiles'), 'gp_name must be gone');
});

test('the columns the platform actually uses are still there', async () => {
  const pool = buildTestDb();
  const r = await pool.query('SELECT id, user_id, plan, trial_ends_at FROM subscriber_profiles');
  assert.ok(Array.isArray(r.rows));
});
