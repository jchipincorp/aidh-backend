// tests/ready_and_heartbeat.test.js -- GET /api/health (liveness), GET /api/ready (readiness + the payout job's state).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const { buildTestDb } = require('./setup');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.FIELD_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.STRIPE_SECRET_KEY = 'sk_test_fixture_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fixture';
const dbConfigPath = path.join(__dirname, '..', 'src', 'config', 'db.js');

function freshApp() {
  Object.keys(require.cache).forEach((key) => { if (key.includes('/src/')) delete require.cache[key]; });
  const pool = buildTestDb();
  require.cache[require.resolve(dbConfigPath)] = { id: dbConfigPath, filename: dbConfigPath, loaded: true, exports: pool };
  return { app: require('../src/server').createApp(), pool };
}
function get(app, url) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      http.get({ port: server.address().port, path: url }, (res) => {
        let d = ''; res.on('data', (c) => (d += c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }); });
      }).on('error', reject);
    });
  });
}

test('READY: 200 with the database up and the job never run; health is 200 too', async () => {
  const { app } = freshApp();
  assert.deepEqual((await get(app, '/api/health')).body, { ok: true });
  const r = await get(app, '/api/ready');
  assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true, db: true, jobs: 'never-run' });
});

test('READY: 503 when the database is down, while health stays 200 (a database outage must not get healthy app servers restarted)', async () => {
  const { app, pool } = freshApp();
  pool.query = async () => { throw new Error('connection refused'); };
  const r = await get(app, '/api/ready');
  assert.equal(r.status, 503); assert.deepEqual(r.body, { ok: false, db: false });
  assert.equal((await get(app, '/api/health')).status, 200);
});

test('READY: 503 from the first moment of shutdown, so the load balancer drains the instance', async () => {
  const { app } = freshApp();
  app.locals.shuttingDown = true;
  const r = await get(app, '/api/ready');
  assert.equal(r.status, 503); assert.equal(r.body.reason, 'shutting-down');
});

test('READY: a database that hangs is a 503 within about two seconds, not a hung request', async () => {
  const { app, pool } = freshApp();
  pool.query = () => new Promise(() => {});
  const t0 = Date.now(); const r = await get(app, '/api/ready');
  assert.equal(r.status, 503); assert.ok(Date.now() - t0 < 3500, 'answered in ' + (Date.now() - t0) + 'ms');
});

test('JOBS: a run records a heartbeat and /api/ready reports ok; failures report failing; an old run reports stale', async () => {
  const { app, pool } = freshApp();
  const { runConsultationJobs } = require('../src/lib/consultationJobs');
  const ctrl = require('../src/controllers/consultations.controller');
  await runConsultationJobs();
  const row = (await pool.query("SELECT * FROM job_heartbeats WHERE job_name = 'consultations'")).rows[0];
  assert.equal(row.last_ok, true); assert.equal(row.last_error, null); assert.ok(row.last_finished_at && row.last_started_at);
  assert.ok(!/@/.test(row.last_result || ''), 'the stored summary holds no email addresses');
  assert.equal((await get(app, '/api/ready')).body.jobs, 'ok');

  const real = ctrl.releaseDueBookings;
  ctrl.releaseDueBookings = async () => ({ released: 0, failures: [{ id: 'x', error: 'boom' }] });
  await runConsultationJobs();
  assert.equal((await get(app, '/api/ready')).body.jobs, 'failing');
  assert.match((await pool.query("SELECT last_error FROM job_heartbeats WHERE job_name='consultations'")).rows[0].last_error, /1 release failure/);
  ctrl.releaseDueBookings = real;
  await runConsultationJobs();
  assert.equal((await get(app, '/api/ready')).body.jobs, 'ok', 'recovers on the next good run');

  process.env.JOBS_STALE_AFTER_SECONDS = '1';
  try { await new Promise((r) => setTimeout(r, 1300)); assert.equal((await get(app, '/api/ready')).body.jobs, 'stale'); }
  finally { delete process.env.JOBS_STALE_AFTER_SECONDS; }
});

test('JOBS: a job that THROWS is recorded as failing and still throws to its caller', async () => {
  const { app, pool } = freshApp();
  const { runConsultationJobs } = require('../src/lib/consultationJobs');
  const ctrl = require('../src/controllers/consultations.controller');
  ctrl.expireStaleHolds = async () => { throw new Error('database exploded'); };
  await assert.rejects(runConsultationJobs(), /database exploded/);
  const row = (await pool.query("SELECT last_ok, last_error FROM job_heartbeats WHERE job_name='consultations'")).rows[0];
  assert.equal(row.last_ok, false); assert.match(row.last_error, /database exploded/);
  assert.equal((await get(app, '/api/ready')).body.jobs, 'failing');
});

test('READY: the readiness and health checks are not throttled by the API rate limit', async () => {
  const { app } = freshApp();
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const statuses = new Set();
    for (let i = 0; i < 320; i++) statuses.add((await fetch(`http://localhost:${server.address().port}/api/ready`)).status);
    assert.deepEqual([...statuses], [200], 'more requests than the 300-per-window API limit, none refused');
  } finally { server.close(); }
});
