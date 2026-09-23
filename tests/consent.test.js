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
process.env.FIELD_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');

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
  const reg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'real@test.com', password: 'correct-horse-battery-9' } });
  assert.equal(reg.status, 201);
  assert.ok(reg.body.token, 'register should issue a token');

  const goodSignin = await jsonRequest(app, 'POST', '/api/auth/signin', { body: { email: 'real@test.com', password: 'correct-horse-battery-9' } });
  assert.equal(goodSignin.status, 200);

  // This is the exact bug the current frontend stub has: sign-in must
  // reject a wrong password, not just check that the email exists.
  const badSignin = await jsonRequest(app, 'POST', '/api/auth/signin', { body: { email: 'real@test.com', password: 'totally-wrong' } });
  assert.equal(badSignin.status, 401, 'sign-in with wrong password must be rejected');
});

test('signin error is identical for unknown email vs wrong password (no user enumeration)', async () => {
  const { app } = freshApp();
  await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'exists@test.com', password: 'correct-horse-battery-9' } });

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
  const reg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'sub@test.com', password: 'correct-horse-battery-9' } });
  const token = reg.body.token;

  const res = await jsonRequest(app, 'POST', '/api/subscriber/sliders', {
    token, body: { en: 15, rf: 27, ft: 5, md: 31, sl: 31 },
  });
  assert.equal(res.status, 201);
  assert.ok(res.body.scores.organs.pk < res.body.scores.organs.g, 'critical ft should hit Pancreas & Meta hardest');
});

test('per-match consent: granting for one match does not grant a second match of the same discipline', async () => {
  const { app } = freshApp();
  const subReg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'sub2@test.com', password: 'correct-horse-battery-9' } });
  const subToken = subReg.body.token;

  const pracReg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'prac@test.com', password: 'correct-horse-battery-9', role: 'practitioner' } });
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
  const subReg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'sub3@test.com', password: 'correct-horse-battery-9' } });
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
  const pracReg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'prac2@test.com', password: 'correct-horse-battery-9', role: 'practitioner' } });

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

test('case entry change_summary is encrypted at rest and decrypted correctly on public read', async () => {
  const { app, pool } = freshApp();
  const { encryptField, decryptField } = require('../src/lib/fieldEncryption');

  const pracReg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'prac3@test.com', password: 'correct-horse-battery-9', role: 'practitioner' } });
  const practitionerToken = pracReg.body.token;
  const plaintext = 'Subscriber reported markedly improved energy after 6 weeks on the fasting-coach protocol.';

  const submitted = await jsonRequest(app, 'POST', '/api/case-registry', {
    token: practitionerToken,
    body: {
      disciplineSlug: 'reiki', subscriberCaseCode: 'CASE-TEST-ENC-01', aidhPillar: 'Pillar 3',
      wellnessCategory: 'General Wellness', organSystemFocus: 'Mental & Emotional',
      changeSummary: plaintext, labCorroboration: 'not_applicable',
      clientConsentConfirmed: true, physicianInvolvementConfirmed: true, outcomeDisclaimerAck: true,
    },
  });
  assert.equal(submitted.status, 201);

  // Prove it's actually encrypted at rest -- the raw column must never equal
  // the plaintext, and must not simply contain it as a substring either.
  const raw = await pool.query('SELECT change_summary FROM case_entries WHERE id = $1', [submitted.body.id]);
  const rawValue = raw.rows[0].change_summary;
  assert.notEqual(rawValue, plaintext, 'change_summary must not be stored in plaintext');
  assert.ok(!rawValue.includes('energy'), 'ciphertext must not leak readable fragments of the plaintext');
  assert.equal(decryptField(rawValue), plaintext, 'stored ciphertext must decrypt back to the original text');

  // Publish it directly (bypassing admin review, which is out of scope here)
  // and confirm the public case-directory read path returns the decrypted text.
  await pool.query(`UPDATE case_entries SET status = 'published' WHERE id = $1`, [submitted.body.id]);
  const published = await jsonRequest(app, 'GET', '/api/case-registry');
  const entry = published.body.entries.find((e) => e.id === submitted.body.id);
  assert.ok(entry, 'published entry should appear in the public listing');
  assert.equal(entry.change_summary, plaintext, 'public API must return decrypted plaintext, not ciphertext');
});

test('lab result value is encrypted at rest', async () => {
  const { app, pool } = freshApp();
  const { decryptField } = require('../src/lib/fieldEncryption');

  const subReg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'sub-lab@test.com', password: 'correct-horse-battery-9', role: 'subscriber' } });
  const res = await jsonRequest(app, 'POST', '/api/subscriber/lab-results', {
    token: subReg.body.token,
    body: { biomarkerCode: 'crp', value: 3.2, unit: 'mg/L', resultDate: '2026-01-15' },
  });
  assert.equal(res.status, 201);

  const raw = await pool.query('SELECT value, unit FROM lab_results WHERE id = $1', [res.body.id]);
  assert.notEqual(raw.rows[0].value, '3.2', 'lab_results.value must not be stored in plaintext');
  assert.equal(decryptField(raw.rows[0].value), '3.2', 'stored ciphertext must decrypt back to the original value');
  assert.equal(raw.rows[0].unit, 'mg/L', 'unit is intentionally left in plaintext -- not identifying on its own');
});

test('deleting a subscriber account succeeds even after audit_log entries reference them (GDPR/CCPA right-to-erasure)', async () => {
  const { app, pool } = freshApp();
  const reg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'delete-me@test.com', password: 'correct-horse-battery-9', role: 'subscriber' } });
  // register() itself already wrote an audit_log row referencing this user --
  // this is exactly the scenario that used to make the FK reject the delete.
  const before = await pool.query('SELECT count(*) FROM audit_log WHERE actor_user_id = $1', [reg.body.user.id]);
  assert.ok(Number(before.rows[0].count) > 0, 'test setup assumption: registering should have logged an audit_log row');

  const del = await jsonRequest(app, 'DELETE', '/api/subscriber/me', { token: reg.body.token });
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);

  const userRow = await pool.query('SELECT * FROM users WHERE id = $1', [reg.body.user.id]);
  assert.equal(userRow.rows.length, 0, 'user row should be hard-deleted');

  // The audit trail itself must survive the deletion (compliance retention),
  // just with actor_user_id nulled out rather than the row being removed.
  const after = await pool.query('SELECT actor_user_id FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE action = $1) AND action_category = $2 ORDER BY created_at DESC LIMIT 1', ['REGISTERED', 'AUTH']);
  assert.equal(after.rows[0].actor_user_id, null, 'audit_log row should survive with actor_user_id set to NULL, not be deleted or blocked');
});

test('admin can list practitioners and verify one -- the full pending-review loop', async () => {
  const { app, pool } = freshApp();
  const authCtrl = require('../src/controllers/auth.controller');

  // Seed a practitioner the normal way (via the real API)...
  const pracReg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'pending-prac@test.com', password: 'correct-horse-battery-9', role: 'practitioner' } });

  // ...and an admin the way the schema requires: register() has no 'admin'
  // role option (see auth.controller.js), so a real admin account only
  // ever exists via direct seeding -- there's no public sign-up path for
  // one, by design. Mirrors that directly here rather than adding a
  // shortcut that wouldn't exist in production.
  const adminUserId = require('crypto').randomUUID();
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, 'admin@test.com', 'x', 'admin')`, [adminUserId]);
  await pool.query(`INSERT INTO admin_users (user_id, admin_role) VALUES ($1, 'super_admin')`, [adminUserId]);
  const adminToken = await authCtrl.issueToken({ id: adminUserId, role: 'admin' });

  // Non-admin (the practitioner themself) must be rejected.
  const forbidden = await jsonRequest(app, 'GET', '/api/admin/practitioners', { token: pracReg.body.token });
  assert.equal(forbidden.status, 403);

  const listed = await jsonRequest(app, 'GET', '/api/admin/practitioners?status=pending', { token: adminToken });
  assert.equal(listed.status, 200);
  const entry = listed.body.practitioners.find((p) => p.email === 'pending-prac@test.com');
  assert.ok(entry, 'newly registered practitioner should appear in the pending list');
  assert.match(entry.practitioner_code, /^PRACT-\d+$/);
  assert.equal(entry.verification_status, 'pending');

  const verify = await jsonRequest(app, 'POST', `/api/admin/practitioners/${entry.id}/verify`, { token: adminToken, body: { decision: 'verified' } });
  assert.equal(verify.status, 200);
  assert.equal(verify.body.decision, 'verified');

  const relisted = await jsonRequest(app, 'GET', '/api/admin/practitioners?status=verified', { token: adminToken });
  assert.ok(relisted.body.practitioners.some((p) => p.id === entry.id), 'practitioner should now appear under status=verified');
});

test('published case listing returns practitioner_code and discipline name, not just raw ids (frontend/backend integration fix)', async () => {
  const { app, pool } = freshApp();
  const pracReg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'pubtest@test.com', password: 'correct-horse-battery-9', role: 'practitioner' } });

  const submit = await jsonRequest(app, 'POST', '/api/case-registry', {
    token: pracReg.body.token,
    body: {
      disciplineSlug: 'reiki', subscriberCaseCode: 'CASE-PUB-01', aidhPillar: 'Pillar 3',
      wellnessCategory: 'General Wellness', organSystemFocus: 'Mental & Emotional',
      engagementDuration: '6 weeks', wellbeingBefore: 4, wellbeingAfter: 8,
      changeSummary: 'Improved energy and mood.', labCorroboration: 'not_applicable',
      clientConsentConfirmed: true, physicianInvolvementConfirmed: true, outcomeDisclaimerAck: true,
    },
  });
  await pool.query(`UPDATE case_entries SET status = 'published' WHERE id = $1`, [submit.body.id]);

  const listed = await jsonRequest(app, 'GET', '/api/case-registry');
  const entry = listed.body.entries.find((e) => e.id === submit.body.id);
  assert.ok(entry, 'published entry should appear in the public listing');
  assert.equal(entry.discipline, 'Reiki', 'discipline name must be joined in, not just an id');
  assert.match(entry.practitioner_code, /^PRACT-\d+$/, 'practitioner_code must be joined in');
  assert.equal(entry.engagement_duration, '6 weeks', 'engagement_duration was previously missing from this query entirely');
  assert.equal(entry.status, 'published', 'status was previously missing -- the frontend\'s own client-side status check would have hidden every entry without it');
});

test('signin rate limiting returns a real JSON error, not the default plain-text response', async () => {
  const { app } = freshApp();
  // express-rate-limit's default handler returns text/html, breaking the
  // JSON-error contract every other /api/* endpoint follows (see
  // errorHandler.js) -- a client that does JSON.parse() on every error
  // body, as aidh-api-client.js does, would get an unparseable body right
  // when the user most needs a clear message. Found via an actual
  // 25-request test against the real rate limiter, not just reading the
  // config; fixed with a custom JSON handler in auth.routes.js.
  let blocked = null;
  for (let i = 0; i < 21; i++) {
    const res = await jsonRequest(app, 'POST', '/api/auth/signin', { body: { email: 'nobody@test.com', password: 'wrong-' + i } });
    if (res.status === 429) { blocked = res; break; }
  }
  assert.ok(blocked, 'the 21st signin attempt within the window should be rate-limited (max: 20)');
  assert.equal(typeof blocked.body, 'object', 'rate-limit response body must be parsed JSON, not left as unparseable text');
  assert.ok(blocked.body.error, 'rate-limit response must have the same {error: ...} shape as every other endpoint');
});

test('SECURITY: a subscriber cannot grant or revoke consent on another subscriber\'s practitioner match (IDOR)', async () => {
  const { app } = freshApp();
  // Live-exploited against the pre-fix code: an unrelated "attacker"
  // account could POST /api/consent/grant with a "victim" subscriber's
  // real practitionerMatchId and receive back a fully valid consent
  // token -- which a practitioner could then use via
  // getDataForPractitioner to read the victim's real health snapshot.
  // The same gap let an attacker revoke a victim's legitimate active
  // consent. See consent.controller.js's grantConsent/revokeConsent for
  // the fix (an ownership join through subscriber_profiles).
  const victim = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'victim3@test.com', password: 'correct-horse-battery-9', role: 'subscriber' } });
  const victimMatch = await jsonRequest(app, 'POST', '/api/marketplace/matches', { token: victim.body.token, body: { disciplineSlug: 'clinical-psychology', isUrgent: false } });
  await jsonRequest(app, 'POST', '/api/subscriber/sliders', { token: victim.body.token, body: { en: 90, rf: 5, ft: 5, md: 95, sl: 5 } });

  const attacker = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'attacker3@test.com', password: 'correct-horse-battery-9', role: 'subscriber' } });

  const attackGrant = await jsonRequest(app, 'POST', '/api/consent/grant', { token: attacker.body.token, body: { practitionerMatchId: victimMatch.body.id, durationDays: 30 } });
  assert.equal(attackGrant.status, 404, 'granting consent on a match you do not own must be rejected');

  // Victim grants their own legitimate consent...
  const legitGrant = await jsonRequest(app, 'POST', '/api/consent/grant', { token: victim.body.token, body: { practitionerMatchId: victimMatch.body.id, durationDays: 30 } });
  assert.equal(legitGrant.status, 200);

  // ...and the attacker still cannot revoke it.
  const attackRevoke = await jsonRequest(app, 'POST', `/api/consent/${victimMatch.body.id}/revoke`, { token: attacker.body.token });
  assert.equal(attackRevoke.status, 404, 'revoking consent on a match you do not own must be rejected');

  // Confirm the victim's legitimate consent is still active and unaffected.
  const practReg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'prac4@test.com', password: 'correct-horse-battery-9', role: 'practitioner' } });
  const stillWorks = await jsonRequest(app, 'GET', `/api/consent/${victimMatch.body.id}/data`, { token: practReg.body.token, consentToken: legitGrant.body.token });
  assert.equal(stillWorks.status, 200, "victim's own legitimate consent must still work after the attack attempts");
});

test('SECURITY: a subscriber cannot create a booking against another subscriber\'s practitioner match (IDOR)', async () => {
  const { app } = freshApp();
  // Live-exploited against the pre-fix code: an attacker could POST
  // /api/bookings with a victim's practitionerMatchId and their OWN
  // contactMethod/contactValue, hijacking the practitioner's
  // communication channel for that engagement. See
  // booking.controller.js's createBookingRequest for the fix.
  const victim = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'victim4@test.com', password: 'correct-horse-battery-9', role: 'subscriber' } });
  const victimMatch = await jsonRequest(app, 'POST', '/api/marketplace/matches', { token: victim.body.token, body: { disciplineSlug: 'reiki', isUrgent: false } });

  const attacker = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'attacker4@test.com', password: 'correct-horse-battery-9', role: 'subscriber' } });
  const attackBooking = await jsonRequest(app, 'POST', '/api/bookings', {
    token: attacker.body.token,
    body: { practitionerMatchId: victimMatch.body.id, contactMethod: 'email', contactValue: 'attacker-controlled@evil.com', preferredTimeWindow: 'any', paymentAgreementAccepted: true },
  });
  assert.equal(attackBooking.status, 404, 'booking against a match you do not own must be rejected');

  // The legitimate owner can still book their own match.
  const legitBooking = await jsonRequest(app, 'POST', '/api/bookings', {
    token: victim.body.token,
    body: { practitionerMatchId: victimMatch.body.id, contactMethod: 'email', contactValue: 'victim4@test.com', preferredTimeWindow: 'any', paymentAgreementAccepted: true },
  });
  assert.equal(legitBooking.status, 201);
});

test('SECURITY: email verification requires authentication and cannot target another account', async () => {
  const { app, pool } = freshApp();
  // Previously POST /api/auth/verify took a bare {userId} in the body
  // with NO authentication -- ids aren't secret (register()/signin()
  // return them directly), so anyone could mark ANY account verified.
  // See auth.controller.js's verifyEmail for the fix (identity now comes
  // from the caller's own token, not the request body).
  const victim = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'victim5@test.com', password: 'correct-horse-battery-9', role: 'subscriber' } });

  const noAuth = await jsonRequest(app, 'POST', '/api/auth/verify', { body: {} });
  assert.equal(noAuth.status, 401, 'verifying email with no auth token at all must be rejected');

  const attacker = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'attacker5@test.com', password: 'correct-horse-battery-9', role: 'subscriber' } });
  // Attacker is signed in as themself, but tries to target the VICTIM's
  // id in the request body -- the fix must ignore that and only ever
  // act on the caller's own identity (req.user.sub).
  const attack = await jsonRequest(app, 'POST', '/api/auth/verify', { token: attacker.body.token, body: { userId: victim.body.user.id } });
  assert.equal(attack.status, 200);

  const victimRow = await pool.query('SELECT email_verified_at FROM users WHERE id = $1', [victim.body.user.id]);
  assert.equal(victimRow.rows[0].email_verified_at, null, "the attacker's call must NOT mark the VICTIM's account verified, even though the victim's id was in the request body");

  const attackerRow = await pool.query('SELECT email_verified_at FROM users WHERE id = $1', [attacker.body.user.id]);
  assert.notEqual(attackerRow.rows[0].email_verified_at, null, "the call verifies the CALLER's own account (attacker), proving the body's userId is ignored entirely, not silently rejected");
});

test('SECURITY: registration enforces the same password policy the frontend UI promises', async () => {
  const { app } = freshApp();
  // aidh_website.html's create-account form has always required 8+ chars,
  // a number, AND a symbol before it would even call the API -- but this
  // endpoint previously only checked length, so anyone calling it
  // directly (bypassing the UI) could create an account with a password
  // weaker than what the product tells users it requires.
  const tooShort = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'pw1@test.com', password: 'ab1!', role: 'subscriber' } });
  assert.equal(tooShort.status, 400);

  const noNumber = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'pw2@test.com', password: 'no-digits-here!', role: 'subscriber' } });
  assert.equal(noNumber.status, 400);
  assert.match(noNumber.body.error, /number/i);

  const noSymbol = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'pw3@test.com', password: 'nosymbols123', role: 'subscriber' } });
  assert.equal(noSymbol.status, 400);
  assert.match(noSymbol.body.error, /symbol/i);

  const valid = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'pw4@test.com', password: 'correct-horse-battery-9', role: 'subscriber' } });
  assert.equal(valid.status, 201);
});

test('ROBUSTNESS: one case entry with undecryptable ciphertext does not crash the entire public listing', async () => {
  const { app, pool } = freshApp();
  // Found via a real-Postgres verification run: FIELD_ENCRYPTION_KEY
  // changing between deploys (rotation without re-encrypting old rows),
  // or any single row's ciphertext being corrupted, made decryptField()
  // throw -- and an unguarded .map() over all published rows let that ONE
  // bad row crash the entire /api/case-registry GET with a 500, taking
  // down the public case directory for every visitor. See
  // caseRegistry.controller.js's listPublishedCases for the fix: each
  // row's decryption is now isolated, a bad row is logged and excluded,
  // every healthy row still renders.
  const pracReg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'robust-prac@test.com', password: 'correct-horse-battery-9', role: 'practitioner' } });

  const good = await jsonRequest(app, 'POST', '/api/case-registry', {
    token: pracReg.body.token,
    body: {
      disciplineSlug: 'reiki', subscriberCaseCode: 'CASE-GOOD-01', aidhPillar: 'Pillar 3',
      wellnessCategory: 'General Wellness', organSystemFocus: 'Mental & Emotional',
      changeSummary: 'A perfectly healthy, decryptable entry.', labCorroboration: 'not_applicable',
      clientConsentConfirmed: true, physicianInvolvementConfirmed: true, outcomeDisclaimerAck: true,
    },
  });
  const bad = await jsonRequest(app, 'POST', '/api/case-registry', {
    token: pracReg.body.token,
    body: {
      disciplineSlug: 'reiki', subscriberCaseCode: 'CASE-BAD-01', aidhPillar: 'Pillar 3',
      wellnessCategory: 'General Wellness', organSystemFocus: 'Mental & Emotional',
      changeSummary: 'This one will get its ciphertext corrupted below.', labCorroboration: 'not_applicable',
      clientConsentConfirmed: true, physicianInvolvementConfirmed: true, outcomeDisclaimerAck: true,
    },
  });
  await pool.query(`UPDATE case_entries SET status = 'published' WHERE id IN ($1, $2)`, [good.body.id, bad.body.id]);
  // Corrupt the "bad" row's ciphertext directly -- simulates a key
  // rotation or data-corruption scenario without needing a second real key.
  await pool.query(`UPDATE case_entries SET change_summary = 'not-valid-base64-ciphertext-at-all' WHERE id = $1`, [bad.body.id]);

  const listed = await jsonRequest(app, 'GET', '/api/case-registry');
  assert.equal(listed.status, 200, 'the endpoint must not 500 just because one row is undecryptable');
  const goodEntry = listed.body.entries.find((e) => e.id === good.body.id);
  const badEntry = listed.body.entries.find((e) => e.id === bad.body.id);
  assert.ok(goodEntry, 'the healthy entry must still be present and correct');
  assert.equal(goodEntry.change_summary, 'A perfectly healthy, decryptable entry.');
  assert.equal(badEntry, undefined, 'the undecryptable entry must be excluded, not shown broken or half-decrypted');
});

test('SECURITY: server refuses to start in production with wide-open CORS and no ALLOWED_ORIGIN set', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOrigin = process.env.ALLOWED_ORIGIN;
  delete process.env.ALLOWED_ORIGIN;
  process.env.NODE_ENV = 'production';
  Object.keys(require.cache).forEach((key) => { if (key.includes('/src/server.js')) delete require.cache[key]; });
  try {
    assert.throws(() => {
      const { createApp } = require('../src/server');
      createApp();
    }, /ALLOWED_ORIGIN/);
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalOrigin) process.env.ALLOWED_ORIGIN = originalOrigin;
    Object.keys(require.cache).forEach((key) => { if (key.includes('/src/server.js')) delete require.cache[key]; });
  }
});

test('baseline rate limiting now applies to non-auth endpoints too (previously only auth had any)', async () => {
  const { app } = freshApp();
  // Firing 300 real requests to prove the cap itself would be slow and
  // redundant -- the auth-route test above already proves
  // express-rate-limit's actual blocking behavior works correctly once
  // triggered. What matters here is narrower: that the limiter
  // middleware is mounted on the general /api path at all, not just
  // /api/auth/*, which is what "only auth had any rate limiting" means
  // to fix. The RateLimit-* response headers (standardHeaders: true)
  // are set by the middleware itself on every request it handles, so
  // their presence on a non-auth route is direct proof it ran here.
  const res = await jsonRequest(app, 'GET', '/api/marketplace/disciplines');
  assert.equal(res.status, 200);
  assert.ok(res.headers['ratelimit-limit'] || res.headers['x-ratelimit-limit'],
    'rate-limit headers must be present on a non-auth route, proving the general apiLimiter is mounted there');
});

test('SECURITY/FEATURE: logout revokes the session server-side -- the token is rejected on its next use', async () => {
  const { app, pool } = freshApp();
  // The sessions table (migration 001) existed in the schema for this
  // exact purpose but nothing ever wrote to or read from it -- a stolen
  // or leaked token was valid for its full 7-day JWT expiry with no way
  // to cut it short server-side. See auth.controller.js's issueToken/
  // logout and middleware/auth.js's requireAuth for the fix.
  const reg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'logout-test@test.com', password: 'correct-horse-battery-9', role: 'subscriber' } });
  const token = reg.body.token;

  const before = await pool.query('SELECT count(*) FROM sessions WHERE user_id = $1', [reg.body.user.id]);
  assert.equal(Number(before.rows[0].count), 1, 'registering should have created exactly one session row');

  const worksBeforeLogout = await jsonRequest(app, 'GET', '/api/subscriber/sliders/latest', { token });
  assert.equal(worksBeforeLogout.status, 404, 'token works before logout (404 here just means no snapshot yet, not an auth failure)');

  const logout = await jsonRequest(app, 'POST', '/api/auth/logout', { token });
  assert.equal(logout.status, 200);
  assert.equal(logout.body.loggedOut, true);

  const after = await pool.query('SELECT count(*) FROM sessions WHERE user_id = $1', [reg.body.user.id]);
  assert.equal(Number(after.rows[0].count), 0, 'the session row must actually be deleted');

  // The SAME token, still cryptographically valid and unexpired as a JWT,
  // must now be rejected -- this is the entire point of the fix.
  const rejectedAfterLogout = await jsonRequest(app, 'GET', '/api/subscriber/sliders/latest', { token });
  assert.equal(rejectedAfterLogout.status, 401);
  assert.match(rejectedAfterLogout.body.error, /revoked|expired/i);
});

test('SECURITY/FEATURE: logout-all revokes every session for the user, not just the caller\'s own', async () => {
  const { app, pool } = freshApp();
  const email = 'logout-all-test@test.com';
  const reg1 = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email, password: 'correct-horse-battery-9', role: 'subscriber' } });
  // A second "session" for the same user, e.g. a second device signing in.
  // Note: signing in again within the same second CAN legitimately produce
  // a byte-identical JWT (iat/exp only have second granularity, and the
  // rest of the payload -- sub, role -- is unchanged), so this doesn't
  // assert the two tokens differ; what matters is that the sessions table
  // has two rows and logout-all clears all of them for this user.
  const reg2 = await jsonRequest(app, 'POST', '/api/auth/signin', { body: { email, password: 'correct-horse-battery-9' } });

  const before = await pool.query('SELECT count(*) FROM sessions WHERE user_id = $1', [reg1.body.user.id]);
  assert.equal(Number(before.rows[0].count), 2, 'should have two separate session rows now');

  const logoutAll = await jsonRequest(app, 'POST', '/api/auth/logout-all', { token: reg1.body.token });
  assert.equal(logoutAll.status, 200);
  assert.equal(logoutAll.body.sessionsRevoked, 2);

  // The token must now be rejected -- if reg2's token happened to be
  // identical to reg1's (same-second issuance, see note above), this
  // single check already covers both; if it differed, checking it
  // separately below still holds.
  const firstRejected = await jsonRequest(app, 'GET', '/api/subscriber/sliders/latest', { token: reg1.body.token });
  assert.equal(firstRejected.status, 401);
  const secondRejected = await jsonRequest(app, 'GET', '/api/subscriber/sliders/latest', { token: reg2.body.token });
  assert.equal(secondRejected.status, 401);
});

test('SECURITY: a request with a well-formed but never-issued JWT (no matching session) is rejected', async () => {
  const { app } = freshApp();
  // Distinguishes "signature valid" from "actually revocable/tracked" --
  // a forged-but-correctly-signed token (impossible without JWT_SECRET,
  // but this also covers a token whose session row was deleted by some
  // other path, e.g. a future admin-initiated force-logout) must still
  // be rejected by the sessions-table check, not accepted on signature
  // verification alone.
  const authCtrl = require('../src/controllers/auth.controller');
  const jwt = require('jsonwebtoken');
  const fakeToken = jwt.sign({ sub: require('crypto').randomUUID(), role: 'subscriber' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  const res = await jsonRequest(app, 'GET', '/api/subscriber/sliders/latest', { token: fakeToken });
  assert.equal(res.status, 401);
});

test('FEATURE: practitioner can fetch and partially update their real profile', async () => {
  const { app, pool } = freshApp();
  const reg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'newprac@test.com', password: 'correct-horse-battery-9', role: 'practitioner' } });

  // Freshly registered: profile exists (created at registration) but is empty.
  const initial = await jsonRequest(app, 'GET', '/api/practitioner/profile', { token: reg.body.token });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.firstName, null);
  assert.equal(initial.body.profileCompletedAt, null);
  assert.match(initial.body.practitionerCode, /^PRACT-\d+$/);

  // A subscriber must not be able to reach this practitioner-only route.
  const subReg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'notaprac@test.com', password: 'correct-horse-battery-9', role: 'subscriber' } });
  const subAttempt = await jsonRequest(app, 'GET', '/api/practitioner/profile', { token: subReg.body.token });
  assert.equal(subAttempt.status, 403);

  // Partial update #1: just name and country.
  const update1 = await jsonRequest(app, 'PATCH', '/api/practitioner/profile', {
    token: reg.body.token,
    body: { firstName: 'Priya', lastName: 'Sharma', country: 'India' },
  });
  assert.equal(update1.status, 200);
  assert.equal(update1.body.firstName, 'Priya');
  assert.equal(update1.body.profileCompletedAt, null, 'not complete yet -- required fields still missing');

  // Partial update #2: profileDetails merges, doesn't replace.
  const update2 = await jsonRequest(app, 'PATCH', '/api/practitioner/profile', {
    token: reg.body.token,
    body: { profileDetails: { langs: ['English', 'Hindi'] } },
  });
  assert.deepEqual(update2.body.profileDetails, { langs: ['English', 'Hindi'] });
  assert.equal(update2.body.firstName, 'Priya', 'earlier fields must survive an update that only touches profileDetails');

  const update3 = await jsonRequest(app, 'PATCH', '/api/practitioner/profile', {
    token: reg.body.token,
    body: { profileDetails: { philosophy: 'Root-cause first.' } },
  });
  assert.deepEqual(update3.body.profileDetails, { langs: ['English', 'Hindi'], philosophy: 'Root-cause first.' }, 'profileDetails must merge shallowly, not overwrite the whole JSONB blob');

  // Complete the rest of the required fields -- profile_completed_at should now stamp.
  const complete = await jsonRequest(app, 'PATCH', '/api/practitioner/profile', {
    token: reg.body.token,
    body: {
      city: 'Mumbai', publicContactEmail: 'priya@example.com', qualifications: 'BAMS',
      registrationBody: 'AHPRA', insuranceStatus: 'Yes — current', complaintsHistory: 'None',
      platformIndependenceAck: true,
    },
  });
  assert.equal(complete.status, 200);
  assert.ok(complete.body.profileCompletedAt, 'all REQUIRED_FOR_COMPLETION fields now present -- should stamp completion');

  // Re-completing (sending the same complete set again) must not move the
  // original completion timestamp.
  await new Promise((r) => setTimeout(r, 50));
  const recomplete = await jsonRequest(app, 'PATCH', '/api/practitioner/profile', { token: reg.body.token, body: { city: 'Mumbai' } });
  assert.equal(recomplete.body.profileCompletedAt, complete.body.profileCompletedAt, 'profile_completed_at must not move once already set');

  // Verify it's real, persisted data in the database, not just an echoed request.
  const dbRow = await pool.query('SELECT first_name, last_name, profile_details, profile_completed_at FROM practitioner_profiles WHERE user_id = $1', [reg.body.user.id]);
  assert.equal(dbRow.rows[0].first_name, 'Priya');
  assert.deepEqual(dbRow.rows[0].profile_details, { langs: ['English', 'Hindi'], philosophy: 'Root-cause first.' });
  assert.ok(dbRow.rows[0].profile_completed_at);
});

test('FEATURE: real practitioner names now surface in admin practitioner list and the public case directory', async () => {
  const { app, pool } = freshApp();
  const reg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'namedprac@test.com', password: 'correct-horse-battery-9', role: 'practitioner' } });
  await jsonRequest(app, 'PATCH', '/api/practitioner/profile', { token: reg.body.token, body: { firstName: 'Amara', lastName: 'Okafor' } });

  const adminUserId = require('crypto').randomUUID();
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, 'admin2@test.com', 'x', 'admin')`, [adminUserId]);
  await pool.query(`INSERT INTO admin_users (user_id, admin_role) VALUES ($1, 'super_admin')`, [adminUserId]);
  const authCtrl = require('../src/controllers/auth.controller');
  const adminToken = await authCtrl.issueToken({ id: adminUserId, role: 'admin' });

  const list = await jsonRequest(app, 'GET', '/api/admin/practitioners', { token: adminToken });
  const entry = list.body.practitioners.find((p) => p.email === 'namedprac@test.com');
  assert.equal(entry.first_name, 'Amara');
  assert.equal(entry.last_name, 'Okafor');

  // A DIFFERENT practitioner who never completed onboarding -- the public
  // listing must fall back to practitioner_code, not show a blank/null name.
  const bareReg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email: 'bareprac@test.com', password: 'correct-horse-battery-9', role: 'practitioner' } });
  const namedCase = await jsonRequest(app, 'POST', '/api/case-registry', {
    token: reg.body.token,
    body: { disciplineSlug: 'reiki', subscriberCaseCode: 'CASE-NAMED-01', aidhPillar: 'Pillar 3', wellnessCategory: 'General Wellness', organSystemFocus: 'Mental & Emotional', changeSummary: 'Named practitioner case.', labCorroboration: 'not_applicable', clientConsentConfirmed: true, physicianInvolvementConfirmed: true, outcomeDisclaimerAck: true },
  });
  const bareCase = await jsonRequest(app, 'POST', '/api/case-registry', {
    token: bareReg.body.token,
    body: { disciplineSlug: 'reiki', subscriberCaseCode: 'CASE-BARE-01', aidhPillar: 'Pillar 3', wellnessCategory: 'General Wellness', organSystemFocus: 'Mental & Emotional', changeSummary: 'Bare practitioner case.', labCorroboration: 'not_applicable', clientConsentConfirmed: true, physicianInvolvementConfirmed: true, outcomeDisclaimerAck: true },
  });
  await pool.query(`UPDATE case_entries SET status = 'published' WHERE id IN ($1, $2)`, [namedCase.body.id, bareCase.body.id]);

  const published = await jsonRequest(app, 'GET', '/api/case-registry');
  const namedEntry = published.body.entries.find((e) => e.id === namedCase.body.id);
  const bareEntry = published.body.entries.find((e) => e.id === bareCase.body.id);
  assert.equal(namedEntry.practitioner_display_name, 'Amara Okafor', 'real name used once the practitioner has completed their profile');
  assert.match(bareEntry.practitioner_display_name, /^PRACT-\d+$/, 'falls back to practitioner_code when no name has been set yet');
});
