#!/usr/bin/env node
// scripts/verify-ops-real-postgres.js
//
// Real-PostgreSQL, real-process verification of the operations layer, none of which an in-memory test can prove:
//   MIGRATIONS  tracked history; re-running is a no-op; a new file applies alone; an edited applied file is refused; a
//               failing migration leaves nothing behind; upgrading a database built by the earlier tool (--baseline);
//               two deploys at once.
//   SEEDS       run once; a deleted item is NOT resurrected; reference data re-applies; legacy-seeded databases refused
//               until baselined.
//   PROCESS     the server refuses unsafe production settings; /api/health and /api/ready; the payout job's heartbeat
//               (ok / stale / failing); readiness is not rate-limited; SIGTERM shuts down cleanly; a database outage
//               turns readiness to 503 while liveness stays 200.
// Usage: DATABASE_URL=postgres://user:pass@host:5432/anydb node scripts/verify-ops-real-postgres.js
// The user needs permission to CREATE and DROP databases; it creates throwaway databases named aidh_ops_<random>.
require('dotenv').config();
const { Pool } = require('pg');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { migrate, status } = require('../src/db/migrate');
const { seed } = require('../src/db/seed');

const BASE = process.env.DATABASE_URL;
if (!BASE) { console.error('DATABASE_URL is required'); process.exit(2); }
const ROOT = path.join(__dirname, '..'), MIG = path.join(ROOT, 'src/db/migrations'), SEED = path.join(ROOT, 'src/db/seed');
const quiet = { log: () => {} };
let pass = 0, fail = 0;
const check = (label, cond, extra) => { if (cond) { pass++; console.log('PASS -', label); } else { fail++; console.log('FAIL -', label, extra ? '[' + extra + ']' : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const urlFor = (name) => { const u = new URL(BASE); u.pathname = '/' + name; return u.toString(); };
const sqlFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aidh-ops-'));
const copyDir = (src) => { const d = tmp(); sqlFiles(src).forEach((f) => fs.copyFileSync(path.join(src, f), path.join(d, f))); return d; };
let admin; const made = [];
async function newDb() { const name = 'aidh_ops_' + crypto.randomBytes(4).toString('hex'); await admin.query(`CREATE DATABASE ${name}`); const pool = new Pool({ connectionString: urlFor(name) });
  // Dropping a database with FORCE terminates its connections; an idle client then emits 'error'. The app's own pool
  // (src/config/db.js) already has this guard; without one here, that expected event would crash the script.
  pool.on('error', () => {}); made.push([name, pool]); return { name, pool }; }
const count = async (pool, t, where = '') => (await pool.query(`SELECT count(*)::int AS c FROM ${t} ${where}`)).rows[0].c;
const exists = async (pool, t) => (await pool.query('SELECT to_regclass($1) IS NOT NULL AS ok', ['public.' + t])).rows[0].ok;
async function rejects(p) { try { await p; return null; } catch (e) { return e.message || String(e); } }
const N = sqlFiles(MIG).length;

async function migrations() {
  console.log('\n=== MIGRATIONS ===');
  const { pool } = await newDb();
  const r1 = await migrate(pool, quiet);
  check(`a fresh database gets all ${N} migrations and records each in its history`, r1.applied.length === N && (await count(pool, 'schema_migrations')) === N, JSON.stringify(r1.applied.length));
  const r2 = await migrate(pool, quiet);
  check('running migrate again is a harmless no-op (the earlier tool failed here with "type already exists")', r2.applied.length === 0 && r2.alreadyApplied === N);
  const st = await status(pool);
  check('status reports nothing pending and nothing altered', st.pending.length === 0 && st.altered.length === 0 && st.applied.length === N);

  const d1 = copyDir(MIG); fs.writeFileSync(path.join(d1, '900_probe.sql'), 'CREATE TABLE ops_probe (id int);');
  const r3 = await migrate(pool, { ...quiet, dir: d1 });
  check('a NEW migration file applies on its own, on top of the existing database', r3.applied.join() === '900_probe.sql' && await exists(pool, 'ops_probe'));

  const d2 = copyDir(MIG); fs.appendFileSync(path.join(d2, '001_users_and_identity.sql'), '\n-- tampered\n');
  const e2 = await rejects(migrate(pool, { ...quiet, dir: d2 }));
  check('an applied migration that was EDITED afterwards is refused, with a message saying to add a new one', /changed after it was applied/.test(e2 || '') && /NEW migration/.test(e2 || ''), e2);
  check('and status flags the altered file', (await status(pool, { dir: d2 })).altered.join() === '001_users_and_identity.sql');

  const { pool: p2 } = await newDb();
  const d3 = copyDir(MIG); fs.writeFileSync(path.join(d3, '901_bad.sql'), 'CREATE TABLE ops_half (id int);\nSELECT * FROM a_table_that_does_not_exist;');
  const e3 = await rejects(migrate(p2, { ...quiet, dir: d3 }));
  check('a failing migration is rolled back completely: nothing from it remains and it is not recorded', /rolled back/.test(e3 || '') && !(await exists(p2, 'ops_half')) && (await count(p2, 'schema_migrations', "WHERE filename = '901_bad.sql'")) === 0, e3);
  fs.unlinkSync(path.join(d3, '901_bad.sql'));
  check('and after the bad file is removed, the database carries on from where it stopped', (await migrate(p2, { ...quiet, dir: d3 })).alreadyApplied === N);

  const { pool: p3 } = await newDb();
  // An existing deployment from BEFORE migration 015, built the EARLIER tool's way (the SQL run directly, no history):
  const oldFiles = sqlFiles(MIG).filter((f) => f < '015');
  for (const f of oldFiles) await p3.query(fs.readFileSync(path.join(MIG, f), 'utf8'));
  const e4 = await rejects(migrate(p3, quiet));
  check('a database built by the earlier tool (tables, no history) is REFUSED with instructions, not guessed at', /no migration history/.test(e4 || '') && /--baseline=/.test(e4 || ''), e4);
  check('status says so too', (await status(p3)).legacyWithoutHistory === true);
  check('a --baseline naming a file that does not exist is refused', /not a migration file/.test((await rejects(migrate(p3, { ...quiet, baseline: 'nope.sql' }))) || ''));
  const last = oldFiles[oldFiles.length - 1];
  const r5 = await migrate(p3, { ...quiet, baseline: last });
  check(`UPGRADING an existing deployment: --baseline=${last} adopts it without re-running anything, then applies only what is newer`, r5.baselined.length === oldFiles.length && r5.applied.join() === '015_job_heartbeats.sql' && await exists(p3, 'job_heartbeats'), JSON.stringify(r5));
  check('and the next run is a no-op', (await migrate(p3, quiet)).applied.length === 0);

  const { pool: p4 } = await newDb();
  const [a, b] = await Promise.all([migrate(p4, quiet), migrate(p4, quiet)]);
  check('two deploys at the same moment: both finish without error and every migration is applied exactly once', a.applied.length + b.applied.length === N && (await count(p4, 'schema_migrations')) === N, `${a.applied.length}+${b.applied.length}`);
}

async function seeds() {
  console.log('\n=== SEEDS ===');
  const { pool } = await newDb(); await migrate(pool, quiet);
  const r1 = await seed(pool, quiet);
  const items = await count(pool, 'research_feed_items');
  check('the first run applies every seed file', r1.applied.length === sqlFiles(SEED).length && items === 14 && (await count(pool, 'research_feed_item_topics', "WHERE topic_id = 'fasting'")) === 5, `${r1.applied.length} files, ${items} items`);
  const disc = await count(pool, 'disciplines');
  const r2 = await seed(pool, quiet);
  check('running it again changes nothing in the content (the original research-feed seed used to DUPLICATE its items)', (await count(pool, 'research_feed_items')) === 14, String(await count(pool, 'research_feed_items')));
  check('only the re-runnable reference data was applied again (the disciplines)', r2.applied.join() === 'seed_disciplines.sql' && (await count(pool, 'disciplines')) === disc, JSON.stringify(r2.applied));
  await pool.query("DELETE FROM research_feed_items WHERE title = 'Nirmal Khadse'");
  await seed(pool, quiet);
  check('an item the admin DELETED is not resurrected by running the seed again', (await count(pool, 'research_feed_items')) === 13 && (await count(pool, 'research_feed_items', "WHERE title = 'Nirmal Khadse'")) === 0);
  await pool.query("DELETE FROM disciplines WHERE slug = (SELECT slug FROM disciplines LIMIT 1)");
  await seed(pool, quiet);
  check('but a missing discipline (reference data) IS restored', (await count(pool, 'disciplines')) === disc);
  const sd = copyDir(SEED); fs.appendFileSync(path.join(sd, 'seed_research_feed_diet.sql'), '\n-- edited later\n');
  const logs = []; const r3 = await seed(pool, { log: (m) => logs.push(m), dir: sd });
  check('a content seed edited after it was applied is NOT re-run, and a warning says how to change live content', r3.warned.join() === 'seed_research_feed_diet.sql' && logs.some((l) => /WARNING/.test(l)));

  const { pool: lp } = await newDb(); await migrate(lp, quiet);
  for (const f of sqlFiles(SEED)) await lp.query(fs.readFileSync(path.join(SEED, f), 'utf8'));   // the EARLIER tool's way
  const e = await rejects(seed(lp, quiet));
  check('a database seeded by the earlier tool is REFUSED (running the content seeds again would duplicate or resurrect rows)', /no seed history/.test(e || '') && /--baseline/.test(e || ''), e);
  const rb = await seed(lp, { ...quiet, baseline: true });
  check('with --baseline it is adopted without running anything, and the data is untouched', rb.baselined.length === sqlFiles(SEED).length && (await count(lp, 'research_feed_items')) === 14);
}

function startServer(env, cwd) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], { cwd, env: { PATH: process.env.PATH, JWT_SECRET: 'ops-secret', FIELD_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), STRIPE_SECRET_KEY: 'sk_test_dummy', ...env } });
  const out = { stdout: '', stderr: '' }; child.stdout.on('data', (d) => (out.stdout += d)); child.stderr.on('data', (d) => (out.stderr += d));
  const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
  return { child, out, exited };
}
async function waitFor(fn, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch (e) { /* retry */ } await sleep(150); } return null; }
const getJson = async (port, p) => { const r = await fetch(`http://localhost:${port}${p}`, { headers: { connection: 'close' } }); return { status: r.status, body: await r.json() }; };

async function processes() {
  console.log('\n=== PROCESS: production safety, health, readiness, jobs, shutdown ===');
  const cwd = tmp();   // an empty folder, so no stray .env file can change what is being tested
  const prod = { NODE_ENV: 'production', DATABASE_URL: BASE, ALLOWED_ORIGIN: 'https://www.example.com', TRUST_PROXY: '1', PORT: '0' };
  for (const [label, over, re] of [['CORS wide open ("*")', { ALLOWED_ORIGIN: '*' }, /ALLOWED_ORIGIN/], ['no ALLOWED_ORIGIN', { ALLOWED_ORIGIN: '' }, /ALLOWED_ORIGIN/], ['no TRUST_PROXY', { TRUST_PROXY: '' }, /TRUST_PROXY must be set/], ['TRUST_PROXY=true', { TRUST_PROXY: 'true' }, /TRUST_PROXY=true/]]) {
    const s = startServer({ ...prod, ...over }, cwd); const ex = await Promise.race([s.exited, sleep(10000).then(() => ({ code: 'timeout' }))]);
    if (ex.code === 'timeout') s.child.kill('SIGKILL');
    check(`a PRODUCTION start with ${label} refuses to start (exit code ${ex.code}) and says why`, ex.code !== 0 && ex.code !== 'timeout' && re.test(s.out.stderr), s.out.stderr.slice(0, 120));
  }

  const { name, pool } = await newDb(); await migrate(pool, quiet); await seed(pool, quiet);
  const port = 4300 + Math.floor(Math.random() * 400);
  const s = startServer({ NODE_ENV: 'development', DATABASE_URL: urlFor(name), PORT: String(port) }, cwd);
  const up = await waitFor(async () => (await getJson(port, '/api/health')).status === 200);
  check('the server starts and /api/health answers 200', !!up, s.out.stderr.slice(0, 200));
  let r = await getJson(port, '/api/ready');
  check('/api/ready: 200, database ok, payout job "never-run" on a fresh deployment', r.status === 200 && r.body.db === true && r.body.jobs === 'never-run', JSON.stringify(r));

  const job = spawnSync(process.execPath, [path.join(ROOT, 'scripts/run-consultation-jobs.js')], { cwd, env: { PATH: process.env.PATH, DATABASE_URL: urlFor(name), JWT_SECRET: 'x', FIELD_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), STRIPE_SECRET_KEY: 'sk_test_dummy' }, encoding: 'utf8' });
  r = await getJson(port, '/api/ready');
  check('after the payout job runs once (the real command), /api/ready reports the job "ok" and the heartbeat row exists', job.status === 0 && r.body.jobs === 'ok' && (await count(pool, 'job_heartbeats', "WHERE job_name = 'consultations' AND last_ok")) === 1, `${job.status} ${job.stderr.slice(0, 100)} ${JSON.stringify(r.body)}`);
  await pool.query("UPDATE job_heartbeats SET last_finished_at = now() - interval '1 hour'");
  check('an hour with no finished run: "stale" (this is the alert condition for a stalled payout job)', (await getJson(port, '/api/ready')).body.jobs === 'stale');
  await pool.query("UPDATE job_heartbeats SET last_finished_at = now(), last_ok = false, last_error = '1 release failure(s)'");
  check('a recent run that reported failures: "failing" (the other alert condition)', (await getJson(port, '/api/ready')).body.jobs === 'failing');

  let throttled = 0;
  for (let i = 0; i < 340; i++) { const x = await fetch(`http://localhost:${port}/api/ready`, { headers: { connection: 'close' } }); if (x.status === 429) throttled++; }
  check('340 readiness checks in a row (over the 300 per 15 minutes API limit): none throttled, so monitoring can never cause a false outage', throttled === 0, String(throttled));

  s.child.kill('SIGTERM'); const t0 = Date.now();
  const ex = await Promise.race([s.exited, sleep(8000).then(() => ({ code: 'timeout' }))]); if (ex.code === 'timeout') s.child.kill('SIGKILL');
  check(`SIGTERM: the server shuts down cleanly (exit code ${ex.code}) in ${Date.now() - t0} ms and logs it`, ex.code === 0 && /SIGTERM received/.test(s.out.stdout), `${ex.code} ${s.out.stdout.slice(-120)}`);

  const o = await newDb(); await migrate(o.pool, quiet);
  const port2 = 4700 + Math.floor(Math.random() * 200);
  const s2 = startServer({ NODE_ENV: 'development', DATABASE_URL: urlFor(o.name), PORT: String(port2) }, cwd);
  await waitFor(async () => (await getJson(port2, '/api/health')).status === 200);
  check('before the outage: ready 200', (await getJson(port2, '/api/ready')).status === 200);
  await o.pool.end(); await admin.query(`DROP DATABASE ${o.name} WITH (FORCE)`); made.splice(made.findIndex((m) => m[0] === o.name), 1);
  const down = await getJson(port2, '/api/ready'); const alive = await getJson(port2, '/api/health');
  check('DATABASE OUTAGE: /api/ready turns 503 (take it out of rotation) while /api/health stays 200 (do not restart a healthy app)', down.status === 503 && down.body.db === false && alive.status === 200, JSON.stringify({ down, alive }));
  s2.child.kill('SIGTERM'); const ex2 = await Promise.race([s2.exited, sleep(8000).then(() => ({ code: 'timeout' }))]); if (ex2.code === 'timeout') s2.child.kill('SIGKILL');
  check('and it still shuts down cleanly with the database gone', ex2.code === 0, String(ex2.code));
}

(async () => {
  admin = new Pool({ connectionString: BASE }); admin.on('error', () => {});
  try { await migrations(); await seeds(); await processes(); }
  catch (e) { fail++; console.log('CRASHED -', e.stack || e); }
  finally {
    for (const [name, pool] of made) { await pool.end().catch(() => {}); await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {}); }
    await admin.end();
  }
  console.log(`\n${pass} passed, ${fail} failed (against REAL PostgreSQL and real server processes)`);
  process.exit(fail ? 1 : 0);
})();
