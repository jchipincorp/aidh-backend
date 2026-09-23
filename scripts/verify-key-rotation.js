// One-off verification of scripts/rotate-encryption-key.js against real
// Postgres: encrypts real rows under an OLD key, rotates to a NEW key,
// confirms the app can read them correctly under the new key, then
// re-runs rotation a second time to prove the idempotent/safe-re-run
// behavior (already-rotated rows are detected, not double-encrypted or
// corrupted).
const { Pool } = require('pg');
const crypto = require('crypto');

const OLD_KEY = crypto.randomBytes(32).toString('hex');
const NEW_KEY = crypto.randomBytes(32).toString('hex');
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/aidh_test';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log('PASS -', label); }
  else { fail++; console.log('FAIL -', label); }
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { encryptField, decryptField } = require('../src/lib/fieldEncryption');
  const { rotateTable } = require('./rotate-encryption-key');

  // Seed a real practitioner + case entries directly (bypassing the API,
  // this is a targeted encryption test, not an endpoint test).
  const userId = crypto.randomUUID();
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'practitioner')`, [userId, `rotate-${Date.now()}@t.com`]);
  const pracResult = await pool.query(`INSERT INTO practitioner_profiles (user_id, practitioner_code) VALUES ($1, $2) RETURNING id`, [userId, 'PRACT-ROTATE']);
  const practitionerId = pracResult.rows[0].id;
  const discResult = await pool.query(`SELECT id FROM disciplines LIMIT 1`);
  const disciplineId = discResult.rows[0].id;

  const plaintexts = ['First real case narrative for rotation test.', 'Second one, different text entirely.'];
  const caseIds = [];
  for (const text of plaintexts) {
    const encrypted = encryptField(text, OLD_KEY);
    const result = await pool.query(
      `INSERT INTO case_entries (practitioner_id, discipline_id, subscriber_case_code, aidh_pillar, wellness_category, organ_system_focus, change_summary, client_consent_confirmed, physician_involvement_confirmed, outcome_disclaimer_ack)
       VALUES ($1, $2, $3, 'Pillar 1', 'General Wellness', 'Mental & Emotional', $4, true, true, true) RETURNING id`,
      [practitionerId, disciplineId, 'CASE-ROTATE-' + caseIds.length, encrypted]
    );
    caseIds.push(result.rows[0].id);
  }

  const encryptedUnderOld = await (async () => {
    const row = await pool.query('SELECT change_summary FROM case_entries WHERE id = $1', [caseIds[0]]);
    try { decryptField(row.rows[0].change_summary, OLD_KEY); return true; } catch (e) { return false; }
  })();
  check('rows are actually encrypted under the OLD key before rotation', encryptedUnderOld);

  console.log('\n--- Running rotation (old -> new) ---');
  const { failed } = await rotateTable(pool, OLD_KEY, NEW_KEY, 'case_entries', 'change_summary');
  check('rotation reports zero failures', failed === 0);

  for (let i = 0; i < caseIds.length; i++) {
    const row = await pool.query('SELECT change_summary FROM case_entries WHERE id = $1', [caseIds[i]]);
    let decryptedUnderNew = null;
    try { decryptedUnderNew = decryptField(row.rows[0].change_summary, NEW_KEY); } catch (e) {}
    check(`row ${i} decrypts correctly under the NEW key after rotation`, decryptedUnderNew === plaintexts[i]);

    let stillDecryptsUnderOld = true;
    try { decryptField(row.rows[0].change_summary, OLD_KEY); } catch (e) { stillDecryptsUnderOld = false; }
    check(`row ${i} no longer decrypts under the OLD key (actually re-encrypted, not left alone)`, !stillDecryptsUnderOld);
  }

  console.log('\n--- Re-running rotation a second time (idempotent re-run safety) ---');
  const { rotated, alreadyDone, failed: failed2 } = await rotateTable(pool, OLD_KEY, NEW_KEY, 'case_entries', 'change_summary');
  check('second run finds nothing left to rotate for these rows', alreadyDone >= caseIds.length);
  check('second run reports zero failures', failed2 === 0);

  for (let i = 0; i < caseIds.length; i++) {
    const row = await pool.query('SELECT change_summary FROM case_entries WHERE id = $1', [caseIds[i]]);
    let decryptedUnderNew = null;
    try { decryptedUnderNew = decryptField(row.rows[0].change_summary, NEW_KEY); } catch (e) {}
    check(`row ${i} still decrypts correctly after the redundant second rotation run`, decryptedUnderNew === plaintexts[i]);
  }

  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('CRASHED:', e); process.exit(1); });
