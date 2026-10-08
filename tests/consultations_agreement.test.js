// tests/consultations_agreement.test.js -- nobody is bookable until they have accepted the CURRENT Practitioner Agreement.
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshApp, request, register, bookablePractitioner, slot, bookIt, pay, row, practitionerId } = require('./consultation_helpers');

const accept = (ctx, tok, body) => request(ctx.app, 'POST', '/api/consultations/agreement/accept', { token: tok, body });

test('the current agreement version is public, and a placeholder is marked as a draft', async () => {
  const ctx = freshApp();
  const a = (await request(ctx.app, 'GET', '/api/consultations/agreement')).body;
  assert.deepEqual([a.version, a.isDraft, a.page], ['DRAFT-1', true, 'aidh_practitioner_agreement.html']);
  process.env.PRACTITIONER_AGREEMENT_VERSION = 'FINAL-1';
  try { const f = (await request(ctx.app, 'GET', '/api/consultations/agreement')).body; assert.deepEqual([f.version, f.isDraft], ['FINAL-1', false]); }
  finally { delete process.env.PRACTITIONER_AGREEMENT_VERSION; }
});

test('with everything else ready but no acceptance, a practitioner is not bookable, listed or offered slots', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx, { agreement: false });
  const s = (await request(ctx.app, 'GET', '/api/consultations/settings', { token: prac.token })).body;
  assert.deepEqual(s.notBookableBecause, ['agreement_not_accepted'], 'the agreement is the ONLY thing missing');
  assert.equal(s.bookable, false); assert.equal(s.agreement.accepted, false); assert.equal(s.agreement.acceptedVersion, null);
  assert.equal((await request(ctx.app, 'GET', `/api/consultations/practitioners/${prac.id}/slots`)).status, 409);
  assert.deepEqual((await request(ctx.app, 'GET', '/api/consultations/practitioners')).body.practitioners, []);
  const sub = await register(ctx, 'subscriber');
  assert.equal((await bookIt(ctx, sub, prac.id, new Date(Date.now() + 3 * 86400000).toISOString())).status, 409, 'and a booking is refused');
});

test('accepting needs accept:true and the exact current version; only a practitioner can accept', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx, { agreement: false }); const sub = await register(ctx, 'subscriber');
  assert.equal((await accept(ctx, prac.token, { version: 'DRAFT-1' })).status, 400, 'a missing accept flag is refused');
  assert.equal((await accept(ctx, prac.token, { version: 'DRAFT-1', accept: 'yes' })).status, 400);
  const wrong = await accept(ctx, prac.token, { version: 'DRAFT-0', accept: true });
  assert.equal(wrong.status, 409); assert.equal(wrong.body.code, 'AGREEMENT_VERSION_MISMATCH'); assert.equal(wrong.body.currentVersion, 'DRAFT-1');
  assert.equal((await accept(ctx, prac.token, { accept: true })).status, 409, 'no version is refused too');
  assert.equal((await accept(ctx, sub.token, { version: 'DRAFT-1', accept: true })).status, 403);
  assert.equal((await request(ctx.app, 'POST', '/api/consultations/agreement/accept', { body: { version: 'DRAFT-1', accept: true } })).status, 401);
  assert.equal((await request(ctx.app, 'GET', '/api/consultations/settings', { token: prac.token })).body.agreement.accepted, false, 'none of those counted');
});

test('accepting records the version and the time, is audited, makes them bookable, and never overwrites the original time', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx, { agreement: false });
  const r = await accept(ctx, prac.token, { version: 'DRAFT-1', accept: true });
  assert.equal(r.status, 200); assert.equal(r.body.agreement.accepted, true); assert.equal(r.body.agreement.acceptedVersion, 'DRAFT-1'); assert.equal(r.body.bookable, true);
  const first = r.body.agreement.acceptedAt; assert.ok(first);
  const a = await ctx.pool.query(`SELECT description FROM audit_log WHERE action = 'AGREEMENT_ACCEPTED'`);
  assert.equal(a.rows.length, 1); assert.equal(a.rows[0].description, 'version DRAFT-1');
  await new Promise((x) => setTimeout(x, 15));
  const again = await accept(ctx, prac.token, { version: 'DRAFT-1', accept: true });
  assert.equal(again.body.agreement.acceptedAt, first, 'a second acceptance of the same version keeps the first time');
  assert.equal((await ctx.pool.query(`SELECT description FROM audit_log WHERE action = 'AGREEMENT_ACCEPTED'`)).rows.length, 1, 'and is not audited twice');
  assert.equal((await request(ctx.app, 'GET', `/api/consultations/practitioners/${prac.id}/slots`)).status, 200);
  assert.equal((await request(ctx.app, 'GET', '/api/consultations/practitioners')).body.practitioners.length, 1);
});

test('a new agreement version makes every practitioner accept again; bookings already made are untouched', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const b = await bookIt(ctx, sub, prac.id, await slot(ctx, prac.id)); assert.equal(b.status, 201);
  assert.equal((await pay(ctx, b.body.bookingId)).status, 200);
  process.env.PRACTITIONER_AGREEMENT_VERSION = 'FINAL-1';
  try {
    const s = (await request(ctx.app, 'GET', '/api/consultations/settings', { token: prac.token })).body;
    assert.equal(s.agreement.accepted, false); assert.equal(s.agreement.acceptedVersion, 'DRAFT-1'); assert.equal(s.agreement.currentVersion, 'FINAL-1');
    assert.ok(s.notBookableBecause.includes('agreement_not_accepted'));
    assert.equal((await request(ctx.app, 'GET', `/api/consultations/practitioners/${prac.id}/slots`)).status, 409, 'not bookable under the new version');
    assert.equal((await request(ctx.app, 'GET', `/api/consultations/${b.body.bookingId}`, { token: sub.token })).body.status, 'confirmed', 'the existing booking is untouched');
    assert.equal((await accept(ctx, prac.token, { version: 'DRAFT-1', accept: true })).status, 409, 'the old version can no longer be accepted');
    assert.equal((await accept(ctx, prac.token, { version: 'FINAL-1', accept: true })).body.bookable, true);
    assert.equal((await request(ctx.app, 'GET', `/api/consultations/practitioners/${prac.id}/slots`)).status, 200);
  } finally { delete process.env.PRACTITIONER_AGREEMENT_VERSION; }
});

test('each booking records the agreement version that was in force when it was made', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const b = await bookIt(ctx, sub, prac.id, await slot(ctx, prac.id));
  assert.equal((await row(ctx, b.body.bookingId)).practitioner_agreement_version, 'DRAFT-1');
});
