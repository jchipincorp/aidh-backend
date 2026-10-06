// src/db/migrate.js
//
// Applies the SQL files in src/db/migrations, in name order, to a real PostgreSQL database -- and REMEMBERS which it
// has applied, so running it again (every deployment) only applies what is new.
//
//   npm run migrate                      apply everything that is pending
//   npm run migrate:status               show applied / pending / altered, change nothing
//   npm run migrate -- --baseline=<file> adopt a database created by the EARLIER version of this tool (which did not
//                                        keep a history): record every migration up to and including <file> as
//                                        already applied WITHOUT running it, then apply the rest
//
// Guarantees:
//  - each migration runs in its own transaction: if it fails, nothing from it is left behind and it is not recorded;
//  - an applied migration that has been EDITED afterwards is refused (its checksum no longer matches): never edit an
//    applied migration, add a new one;
//  - two deploys running at once cannot interleave (a database advisory lock makes the second wait);
//  - a database that already has AIDH tables but no history is refused rather than guessed at (see --baseline).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DIR = path.join(__dirname, 'migrations');
const LOCK_KEY = 7428193;               // arbitrary constant: "the AIDH migration lock"
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const listFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

async function ensureHistoryTable(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT PRIMARY KEY,
    checksum   TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

async function readHistory(client) {
  const r = await client.query('SELECT filename, checksum FROM schema_migrations');
  return new Map(r.rows.map((x) => [x.filename, x.checksum]));
}

/** Read-only report: which migrations are applied, pending, or were altered after being applied. */
async function status(pool, opts = {}) {
  const dir = opts.dir || DEFAULT_DIR;
  const files = listFiles(dir);
  const client = await pool.connect();
  try {
    const has = await client.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ok");
    const history = has.rows[0].ok ? await readHistory(client) : new Map();
    const legacy = !has.rows[0].ok || history.size === 0
      ? (await client.query("SELECT to_regclass('public.users') IS NOT NULL AS ok")).rows[0].ok : false;
    const applied = [], pending = [], altered = [];
    for (const f of files) {
      if (!history.has(f)) { pending.push(f); continue; }
      applied.push(f);
      if (history.get(f) !== sha(fs.readFileSync(path.join(dir, f), 'utf8'))) altered.push(f);
    }
    return { applied, pending, altered, legacyWithoutHistory: legacy && history.size === 0 };
  } finally { client.release(); }
}

async function migrate(pool, opts = {}) {
  const dir = opts.dir || DEFAULT_DIR;
  const log = opts.log || console.log;
  const files = listFiles(dir);
  const client = await pool.connect();
  const result = { applied: [], alreadyApplied: 0, baselined: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureHistoryTable(client);
    const history = await readHistory(client);

    // A database built by the earlier tool has the tables but no history. Applying everything again would fail on the
    // first CREATE TYPE, so refuse with instructions instead of guessing which files it already ran.
    if (history.size === 0) {
      const legacy = await client.query("SELECT to_regclass('public.users') IS NOT NULL AS ok");
      if (legacy.rows[0].ok) {
        if (!opts.baseline) {
          throw new Error('This database already has AIDH tables but no migration history (it was created by the earlier '
            + 'migration tool). Tell this tool which migration was the LAST one already applied, e.g.\n'
            + '    npm run migrate -- --baseline=' + files[Math.max(0, files.length - 1)] + '\n'
            + 'It will record everything up to and including that file as applied WITHOUT running it, then apply the rest. '
            + 'Back the database up first, and check the file you name really was the last one applied.');
        }
        if (!files.includes(opts.baseline)) throw new Error(`--baseline=${opts.baseline} is not a migration file in ${dir}`);
        for (const f of files.filter((x) => x <= opts.baseline)) {
          const checksum = sha(fs.readFileSync(path.join(dir, f), 'utf8'));
          await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1,$2)', [f, checksum]);
          history.set(f, checksum); result.baselined.push(f);
        }
        log(`Baselined ${result.baselined.length} migration(s) as already applied (through ${opts.baseline}).`);
      }
    }

    for (const f of files) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      const checksum = sha(sql);
      if (history.has(f)) {
        if (history.get(f) !== checksum) {
          throw new Error(`Migration ${f} was changed after it was applied (its checksum no longer matches what was recorded). `
            + 'Never edit an applied migration: put the change in a NEW migration file.');
        }
        result.alreadyApplied += 1; continue;
      }
      log(`Applying ${f}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1,$2)', [f, checksum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${f} failed and was rolled back (nothing from it was kept): ${e.message}`);
      }
      result.applied.push(f);
    }
    log(result.applied.length ? 'All migrations applied.' : 'All migrations applied (nothing new to apply).');
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
  // Real-world note: after migrations run, the application's own database role should have its privileges revoked and
  // re-granted deliberately -- in particular REVOKE UPDATE, DELETE ON audit_log FROM the app role, so the insert-only
  // guarantee in AIDH_Database_Design.docx Section 7 is enforced by the database itself, not only by application code.
}

if (require.main === module) {
  require('dotenv').config();
  const args = process.argv.slice(2);
  const baseline = (args.find((a) => a.startsWith('--baseline=')) || '').split('=')[1];
  const pool = require('../config/db');   // same connection settings as the app (DATABASE_URL, DATABASE_SSL)
  const run = args.includes('--status')
    ? status(pool).then((s) => {
        console.log(`Applied (${s.applied.length}): ${s.applied.join(', ') || '(none)'}`);
        console.log(`Pending (${s.pending.length}): ${s.pending.join(', ') || '(none)'}`);
        if (s.altered.length) console.log(`ALTERED after being applied (${s.altered.length}): ${s.altered.join(', ')}  <-- do not deploy until this is resolved`);
        if (s.legacyWithoutHistory) console.log('NOTE: this database has AIDH tables but no migration history; use --baseline=<last applied file> (see the README).');
        if (s.altered.length) process.exitCode = 1;
      })
    : migrate(pool, { baseline });
  run.then(() => pool.end()).catch((err) => { console.error(err.message || err); pool.end().finally(() => process.exit(1)); });
}

module.exports = { migrate, status };
