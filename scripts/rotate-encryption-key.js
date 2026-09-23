// scripts/rotate-encryption-key.js
//
// Re-encrypts every row in every FIELD_ENCRYPTION_KEY-encrypted column
// (case_entries.change_summary, lab_results.value -- see migration 006 /
// src/lib/fieldEncryption.js) under a NEW key, decrypting with the OLD
// one first. Was flagged as an open gap with no actual tooling to close
// it -- "losing the key makes existing rows permanently unreadable" and
// "rotating requires manually re-encrypting old rows first" were true
// statements with no script behind them until this one.
//
// This does NOT change which key the running application uses -- that
// is still FIELD_ENCRYPTION_KEY in the app's own environment, a separate
// deployment step. Run this FIRST, confirm it reports success, THEN
// update FIELD_ENCRYPTION_KEY in the environment and restart the app.
// Running the app against the new key before this script finishes will
// make every row this script hasn't reached yet fail to decrypt (see the
// per-row error isolation already added to listPublishedCases for what
// that looks like in production -- rows excluded, not a crash, but still
// not what you want mid-rotation).
//
// Usage:
//   OLD_FIELD_ENCRYPTION_KEY=... NEW_FIELD_ENCRYPTION_KEY=... \
//     DATABASE_URL=postgres://... node scripts/rotate-encryption-key.js
//
// Safe to re-run: any row already re-encrypted under the new key will
// fail to decrypt under the OLD key on a second pass and is reported as
// a skip, not silently double-encrypted or corrupted. This also means a
// partially-completed rotation (e.g. the process was killed midway) can
// simply be re-run with the same old/new keys to finish the remaining
// rows -- already-rotated rows are detected and left alone.

const { Pool } = require('pg');
const { encryptField, decryptField } = require('../src/lib/fieldEncryption');

const TABLES = [
  { table: 'case_entries', column: 'change_summary' },
  { table: 'lab_results', column: 'value' },
];

async function rotateTable(pool, oldKey, newKey, table, column) {
  const result = await pool.query(`SELECT id, ${column} FROM ${table} WHERE ${column} IS NOT NULL`);
  let rotated = 0, alreadyDone = 0, failed = 0;

  for (const row of result.rows) {
    let plaintext;
    try {
      plaintext = decryptField(row[column], oldKey);
    } catch (errOld) {
      // Could already be encrypted under the NEW key (a re-run after a
      // partial/interrupted rotation) -- check before treating this as
      // a real failure.
      try {
        decryptField(row[column], newKey);
        alreadyDone++;
        continue;
      } catch (errNew) {
        failed++;
        console.error(`  FAILED  ${table}.${column} id=${row.id}: decrypts under neither the old nor the new key. Left untouched -- investigate before re-running.`);
        continue;
      }
    }

    const reEncrypted = encryptField(plaintext, newKey);
    await pool.query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [reEncrypted, row.id]);
    rotated++;
  }

  console.log(`${table}.${column}: ${rotated} rotated, ${alreadyDone} already on new key, ${failed} failed`);
  return { rotated, alreadyDone, failed };
}

async function main() {
  const oldKey = process.env.OLD_FIELD_ENCRYPTION_KEY;
  const newKey = process.env.NEW_FIELD_ENCRYPTION_KEY;
  if (!oldKey || !newKey) {
    console.error('Both OLD_FIELD_ENCRYPTION_KEY and NEW_FIELD_ENCRYPTION_KEY must be set.');
    console.error(`Generate a new key with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);
    process.exit(1);
  }
  if (oldKey === newKey) {
    console.error('OLD_FIELD_ENCRYPTION_KEY and NEW_FIELD_ENCRYPTION_KEY are identical -- nothing to rotate.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let totalFailed = 0;

  for (const { table, column } of TABLES) {
    const { failed } = await rotateTable(pool, oldKey, newKey, table, column);
    totalFailed += failed;
  }

  await pool.end();

  if (totalFailed > 0) {
    console.error(`\n${totalFailed} row(s) could not be rotated -- DO NOT switch the running app to the new key yet. Investigate the FAILED rows above first.`);
    process.exit(1);
  }
  console.log('\nAll rows rotated successfully. You can now update FIELD_ENCRYPTION_KEY in the app\'s environment to the new key and restart it.');
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { rotateTable };
