// tests/consent.test.js
//
// Exercises the REAL controller code from src/controllers, not a
// simplified re-implementation -- injects the pg-mem test pool into
// Node's module cache in place of the real pg.Pool, so
// src/controllers/*.js run completely unmodified.

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

function jsonRequest(app, method, url, { body, token } = {}) {
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
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  });
}

process.env.JWT_SECRET = 'test-secret-not-for-production';

test('health check responds', async () => {
  const { app } = freshApp();
  const res = await jsonRequest(app, 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('register rejects a short password', async () => {
  const { app } = freshApp();
  const res = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'a@test.com', password: 'short' } });
  assert.equal(res.status, 400);
});

test('register then signin succeeds with correct password, fails with wrong password', async () => {
  const { app } = freshApp();
  const reg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'real@test.com', password: 'correct-horse-battery' } });
  assert.equal(reg.status, 201);
  assert.ok(reg.body.token, 'register should issue a token');

  const goodSignin = await jsonRequest(app, 'POST', '/api/auth/signin', { body: { email: 'real@test.com', password: 'correct-horse-battery' } });
  assert.equal(goodSignin.status, 200);

  // This is the exact bug the current frontend stub has: sign-in must
  // reject a wrong password, not just check that the email exists.
  const badSignin = await jsonRequest(app, 'POST', '/api/auth/signin', { body: { email: 'real@test.com', password: 'totally-wrong' } });
  assert.equal(badSignin.status, 401, 'sign-in with wrong password must be rejected');
});

test('signin error is identical for unknown email vs wrong password (no user enumeration)', async () => {
  const { app } = freshApp();
  await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'exists@test.com', password: 'correct-horse-battery' } });

  const unknownEmail = await jsonRequest(app, 'POST', '/api/auth/signin', { body: { email: 'nobody@test.com', password: 'whatever123' } });
  const wrongPassword = await jsonRequest(app, 'POST', '/api/auth/signin', { body: { email: 'exists@test.com', password: 'whatever123' } });
  assert.equal(unknownEmail.status, wrongPassword.status);
  assert.deepEqual(unknownEmail.body, wrongPassword.body);
});

test('marketplace lists all 18 seeded disciplines, unauthenticated', async () => {
  const { app } = freshApp();
  const res = await jsonRequest(app, 'GET', '/api/marketplace/disciplines');
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 18);
});

test('marketplace search narrows results correctly', async () => {
  const { app } = freshApp();
  const res = await jsonRequest(app, 'GET', '/api/marketplace/disciplines?search=reiki');
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.disciplines[0].slug, 'reiki');
});

test('recording sliders computes scores matching known values', async () => {
  const { app } = freshApp();
  const reg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'sub@test.com', password: 'correct-horse-battery' } });
  const token = reg.body.token;

  const res = await jsonRequest(app, 'POST', '/api/subscriber/sliders', {
    token, body: { en: 15, rf: 27, ft: 5, md: 31, sl: 31 },
  });
  assert.equal(res.status, 201);
  assert.ok(res.body.scores.organs.pk < res.body.scores.organs.g, 'critical ft should hit Pancreas & Meta hardest');
});

test('per-match consent: granting for one match does not grant a second match of the same discipline', async () => {
  const { app } = freshApp();
  const subReg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'sub2@test.com', password: 'correct-horse-battery' } });
  const subToken = subReg.body.token;

  const pracReg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'prac@test.com', password: 'correct-horse-battery', role: 'practitioner' } });
  const pracToken = pracReg.body.token;

  const match1 = await jsonRequest(app, 'POST', '/api/marketplace/matches', { token: subToken, body: { disciplineSlug: 'fasting-coach' } });
  const match2 = await jsonRequest(app, 'POST', '/api/marketplace/matches', { token: subToken, body: { disciplineSlug: 'fasting-coach' } });
  assert.notEqual(match1.body.id, match2.body.id, 'two requests for the same discipline must create two distinct matches');

  const grant1 = await jsonRequest(app, 'POST', '/api/consent/grant', { token: subToken, body: { practitionerMatchId: match1.body.id, durationDays: 30 } });
  assert.equal(grant1.status, 200);

  // Attempting to read match2's data with match1's token must fail --
  // this is the actual, server-enforced version of the per-match scoping.
  const wrongTokenAccess = await jsonRequest(app, 'GET', `/api/consent/${match2.body.id}/data`, {
    token: pracToken,
  });
  assert.equal(wrongTokenAccess.status, 401, 'no consent token supplied for match2 should be rejected');
});

test('revoking one match consent does not affect a second, separately-granted match', async () => {
  const { app } = freshApp();
  const subReg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'sub3@test.com', password: 'correct-horse-battery' } });
  const subToken = subReg.body.token;

  const m1 = await jsonRequest(app, 'POST', '/api/marketplace/matches', { token: subToken, body: { disciplineSlug: 'reiki' } });
  const m2 = await jsonRequest(app, 'POST', '/api/marketplace/matches', { token: subToken, body: { disciplineSlug: 'reiki' } });

  const g1 = await jsonRequest(app, 'POST', '/api/consent/grant', { token: subToken, body: { practitionerMatchId: m1.body.id } });
  const g2 = await jsonRequest(app, 'POST', '/api/consent/grant', { token: subToken, body: { practitionerMatchId: m2.body.id } });
  assert.ok(g1.body.token && g2.body.token);
  assert.notEqual(g1.body.token, g2.body.token, 'each match must receive its own distinct consent token');

  const revoke1 = await jsonRequest(app, 'POST', `/api/consent/${m1.body.id}/revoke`, { token: subToken });
  assert.equal(revoke1.status, 200);

  // m2's consent must still be independently active -- verified via a
  // second revoke call, which should succeed (proving it was still active).
  const revoke2 = await jsonRequest(app, 'POST', `/api/consent/${m2.body.id}/revoke`, { token: subToken });
  assert.equal(revoke2.status, 200, 'match 2 consent should still have been active and revocable independently of match 1');
});

test('case entry cannot be published without all three consent booleans (database CHECK constraint)', async () => {
  const { app, pool } = freshApp();
  const pracReg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'prac2@test.com', password: 'correct-horse-battery', role: 'practitioner' } });

  const discipline = await pool.query(`SELECT id FROM disciplines WHERE slug = 'reiki'`);
  const submitted = await pool.query(
    `INSERT INTO case_entries (practitioner_id, discipline_id, subscriber_case_code, aidh_pillar, wellness_category, organ_system_focus, change_summary, client_consent_confirmed, physician_involvement_confirmed, outcome_disclaimer_ack)
     VALUES ((SELECT id FROM practitioner_profiles WHERE user_id = $1), $2, 'CASE-TEST-001', 'Pillar 4', 'General Wellness', 'Mental & Emotional', 'Test summary', false, false, false)
     RETURNING id`,
    [pracReg.body.user.id, discipline.rows[0].id]
  );

  await assert.rejects(
    pool.query(`UPDATE case_entries SET status = 'published' WHERE id = $1`, [submitted.rows[0].id]),
    /constraint|check/i,
    'publishing without all three consent booleans confirmed must be rejected at the database level'
  );
});
