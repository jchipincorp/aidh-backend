// tests/health_data_off.test.js
//
// Default behaviour: health inputs, computed scores, lab values and practitioner
// data release are refused by the server and nothing is stored. This is the
// enforcement behind "your health inputs stay on your device".

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { buildTestDb } = require('./setup');

const dbConfigPath = path.join(__dirname, '..', 'src', 'config', 'db.js');

function freshApp() {
  // Clear the module cache for everything downstream of config/db so
  // each test gets a clean, isolated database and app instance.
  Object.keys(require.cache).forEach((key) => {
    if (key.includes('/src/')) delete require.cache[key];
  });
  const testPool = buildTestDb();
  require.cache[require.resolve(dbConfigPath)] = { id: dbConfigPath, filename: dbConfigPath, loaded: true, exports: testPool };
  const { createApp } = require('../src/server');
  return { app: createApp(), pool: testPool };
}

function jsonRequest(app, method, url, { body, token, consentToken } = {}) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({
        method, port, path: url,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(consentToken ? { 'X-Consent-Token': consentToken } : {}),
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  });
}

process.env.JWT_SECRET = 'test-secret-not-for-production';
// These tests exercise the slider / snapshot / practitioner-data code paths, which are

// Default state: the switch is OFF. Other test files set it to 'true' in their
// own processes; this one must run with it unset.
delete process.env.AIDH_STORE_HEALTH_DATA;

async function register(app, email, role) {
  const res = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email, password: 'correct-horse-battery-9', ...(role ? { role } : {}) } });
  assert.equal(res.status, 201, 'registration should succeed: ' + JSON.stringify(res.body));
  return res.body.token;
}
async function count(pool, table) {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM ' + table);
  return r.rows[0].n;
}

test('POST /api/subscriber/sliders is refused with 410 and stores nothing', async () => {
  const { app, pool } = freshApp();
  const token = await register(app, 'off1@test.com');
  const res = await jsonRequest(app, 'POST', '/api/subscriber/sliders', { token, body: { en: 15, rf: 27, ft: 5, md: 31, sl: 31 } });
  assert.equal(res.status, 410);
  assert.equal(res.body.code, 'HEALTH_DATA_NOT_STORED');
  assert.equal(await count(pool, 'slider_snapshots'), 0, 'no slider snapshot may be written');
  assert.equal(await count(pool, 'computed_scores_cache'), 0, 'no computed scores may be written');
});

test('GET /api/subscriber/sliders/latest is refused with 410', async () => {
  const { app } = freshApp();
  const token = await register(app, 'off2@test.com');
  const res = await jsonRequest(app, 'GET', '/api/subscriber/sliders/latest', { token });
  assert.equal(res.status, 410);
  assert.equal(res.body.code, 'HEALTH_DATA_NOT_STORED');
});

test('POST /api/subscriber/lab-results is refused with 410 and stores nothing', async () => {
  const { app, pool } = freshApp();
  const token = await register(app, 'off3@test.com');
  const res = await jsonRequest(app, 'POST', '/api/subscriber/lab-results', { token, body: { biomarkerCode: 'crp', value: 3.2, unit: 'mg/L', resultDate: '2026-01-01' } });
  assert.equal(res.status, 410);
  assert.equal(await count(pool, 'lab_results'), 0, 'no lab result may be written');
});

test('the practitioner data-release endpoint is refused with 410', async () => {
  const { app } = freshApp();
  const token = await register(app, 'prac1@test.com', 'practitioner');
  const res = await jsonRequest(app, 'GET', '/api/consent/00000000-0000-0000-0000-000000000000/data', { token });
  assert.equal(res.status, 410);
  assert.equal(res.body.code, 'HEALTH_DATA_NOT_STORED');
});

test('authentication still runs first: no token is a 401, never a 410', async () => {
  const { app } = freshApp();
  const a = await jsonRequest(app, 'POST', '/api/subscriber/sliders', { body: { en: 1, rf: 1, ft: 1, md: 1, sl: 1 } });
  assert.equal(a.status, 401);
  const b = await jsonRequest(app, 'GET', '/api/subscriber/sliders/latest');
  assert.equal(b.status, 401);
});

test('account deletion is unaffected by the switch', async () => {
  const { app } = freshApp();
  const token = await register(app, 'off4@test.com');
  const res = await jsonRequest(app, 'DELETE', '/api/subscriber/me', { token });
  assert.ok(res.status === 200 || res.status === 204, 'deletion must still work, got ' + res.status);
});

test('setting AIDH_STORE_HEALTH_DATA=true is the single, explicit way to turn storage back on', async () => {
  const { app } = freshApp();
  const token = await register(app, 'on1@test.com');
  process.env.AIDH_STORE_HEALTH_DATA = 'true';
  try {
    const res = await jsonRequest(app, 'POST', '/api/subscriber/sliders', { token, body: { en: 15, rf: 27, ft: 5, md: 31, sl: 31 } });
    assert.equal(res.status, 201);
  } finally {
    delete process.env.AIDH_STORE_HEALTH_DATA;
  }
});
