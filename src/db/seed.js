// src/db/seed.js
//
// Applies the SQL files in src/db/seed, in name order, and REMEMBERS which it has applied.
//
//   npm run seed                      apply the seed files not yet applied
//   npm run seed -- --baseline        adopt a database that was seeded by the EARLIER version of this tool (no
//                                     history): record the existing seed files as applied WITHOUT running them
//
// Two kinds of seed file:
//  - CONTENT seeds (the Research Feed items and videos): run ONCE. After launch the admin owns that content, so a
//    deleted item must never come back just because someone ran `npm run seed` again. Tracked by name and checksum.
//  - REFERENCE-DATA seeds (the marketplace disciplines): marked `-- @rerunnable` on one of their first lines. They are
//    idempotent and are applied every time, so a new discipline added to the file reaches an existing database.
// A content seed that was edited after being applied is NOT re-run (its edits would never reach a live database
// anyway): a warning says so. Change live content through the admin console or an explicit UPDATE.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DIR = path.join(__dirname, 'seed');
const LOCK_KEY = 7428194;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isRerunnable = (sql) => sql.split('\n').slice(0, 6).some((l) => /^--\s*@rerunnable\b/.test(l));

async function seed(pool, opts = {}) {
  const dir = opts.dir || DEFAULT_DIR;
  const log = opts.log || console.log;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  const result = { applied: [], skipped: [], warned: [], baselined: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_seeds (
      filename TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const history = new Map((await client.query('SELECT filename, checksum FROM schema_seeds')).rows.map((r) => [r.filename, r.checksum]));

    // A database seeded by the earlier tool has data but no seed history. Running the content seeds again would
    // duplicate or resurrect rows, so refuse unless the operator says it was already seeded.
    if (history.size === 0) {
      const had = await client.query("SELECT to_regclass('public.disciplines') IS NOT NULL AND EXISTS (SELECT 1 FROM disciplines) AS seeded");
      if (had.rows[0].seeded) {
        if (!opts.baseline) {
          throw new Error('This database already holds seed data but no seed history (it was seeded by the earlier tool). '
            + 'Running the content seeds again could duplicate or resurrect rows. If it really was seeded, run\n'
            + '    npm run seed -- --baseline\n'
            + 'which records the existing seed files as applied without running them.');
        }
        for (const f of files) {
          const sql = fs.readFileSync(path.join(dir, f), 'utf8');
          await client.query('INSERT INTO schema_seeds (filename, checksum) VALUES ($1,$2)', [f, sha(sql)]);
          history.set(f, sha(sql)); result.baselined.push(f);
        }
        log(`Baselined ${result.baselined.length} seed file(s) as already applied.`);
      }
    }

    for (const f of files) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      const checksum = sha(sql);
      const rerun = isRerunnable(sql);
      if (history.has(f) && !rerun) {
        if (history.get(f) !== checksum) { log(`WARNING: ${f} was edited after it was applied; it is NOT re-run. Change live content through the admin console or an explicit UPDATE.`); result.warned.push(f); }
        result.skipped.push(f); continue;
      }
      log(`Seeding ${f}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_seeds (filename, checksum) VALUES ($1,$2)
                            ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`, [f, checksum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Seed ${f} failed and was rolled back: ${e.message}`);
      }
      result.applied.push(f);
    }
    log(result.applied.length ? 'All seed data applied.' : 'All seed data applied (nothing new to apply).');
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

if (require.main === module) {
  require('dotenv').config();
  const pool = require('../config/db');
  seed(pool, { baseline: process.argv.includes('--baseline') })
    .then(() => pool.end())
    .catch((err) => { console.error(err.message || err); pool.end().finally(() => process.exit(1)); });
}

module.exports = { seed };
