// tests/legacy_retired.test.js -- the old request-based booking records: creation is retired, and the
// purge deletes them only when confirmed. (The purge is irreversible, so a dry run is the default.)
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshApp, request, register } = require('./consultation_helpers');

async function seedLegacy(ctx) {
  const sub = await register(ctx, 'subscriber');
  process.env.AIDH_LEGACY_MATCHES = 'true';   // only to seed an old-style row; creation is off by default
  let m; try { m = await request(ctx.app, 'POST', '/api/marketplace/matches', { token: sub.token, body: { disciplineSlug: 'reiki', isUrgent: false } }); } finally { delete process.env.AIDH_LEGACY_MATCHES; }
  assert.equal(m.status, 201, JSON.stringify(m.body));
  const br = await ctx.pool.query(`INSERT INTO booking_requests (practitioner_match_id, contact_method, contact_value, preferred_time_window, notes, payment_agreement_accepted_at)
    VALUES ($1, 'email', 'a@b.co', 'any', 'my knee hurts since March', now()) RETURNING id`, [m.body.id]);
  await ctx.pool.query(`INSERT INTO orders (booking_request_id, order_reference) VALUES ($1, 'ORD-LEGACY')`, [br.rows[0].id]);
  return sub;
}
const count = async (ctx, t) => (await ctx.pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n;

test('creating an old booking request is refused for a subscriber, and sign-in and role are still checked first', async () => {
  const ctx = freshApp(); const sub = await register(ctx, 'subscriber'); const prac = await register(ctx, 'practitioner');
  const body = { practitionerMatchId: '00000000-0000-0000-0000-000000000000', contactMethod: 'email', contactValue: 'x@y.co', preferredTimeWindow: 'any', paymentAgreementAccepted: true, notes: 'n' };
  const r = await request(ctx.app, 'POST', '/api/bookings', { token: sub.token, body });
  assert.equal(r.status, 410); assert.equal(r.body.code, 'BOOKING_REQUESTS_RETIRED');
  assert.equal((await request(ctx.app, 'POST', '/api/bookings', { token: prac.token, body })).status, 403);
  assert.equal((await request(ctx.app, 'POST', '/api/bookings', { body })).status, 401);
  assert.equal(await count(ctx, 'booking_requests'), 0);
});

test('purge: a dry run only counts; confirm deletes booking requests and orders but not match requests; --include-matches deletes those too; each real purge is audited', async () => {
  const ctx = freshApp(); await seedLegacy(ctx);
  const { purgeLegacyBookingRequests } = require('../src/lib/legacyPurge');
  const dry = await purgeLegacyBookingRequests(ctx.pool);
  assert.deepEqual(dry, { bookingRequests: 1, orders: 1, matchRequests: 1, matchRequestsIncluded: false, deleted: false });
  assert.deepEqual([await count(ctx, 'booking_requests'), await count(ctx, 'orders'), await count(ctx, 'practitioner_matches')], [1, 1, 1], 'a dry run deletes nothing');
  const done = await purgeLegacyBookingRequests(ctx.pool, { confirm: true });
  assert.equal(done.deleted, true);
  assert.deepEqual([await count(ctx, 'booking_requests'), await count(ctx, 'orders'), await count(ctx, 'practitioner_matches')], [0, 0, 1], 'the free-text notes and contact details are gone; the match request (no free text) remains');
  const noteLeft = await ctx.pool.query(`SELECT 1 FROM booking_requests WHERE notes IS NOT NULL`);
  assert.equal(noteLeft.rows.length, 0);
  const audit = await ctx.pool.query(`SELECT description FROM audit_log WHERE action = 'LEGACY_REQUESTS_PURGED'`);
  assert.equal(audit.rows.length, 1); assert.match(audit.rows[0].description, /1 booking requests and 1 orders deleted/);
  await purgeLegacyBookingRequests(ctx.pool, { confirm: true, includeMatches: true });
  assert.equal(await count(ctx, 'practitioner_matches'), 0);
  assert.equal((await ctx.pool.query(`SELECT 1 FROM audit_log WHERE action = 'LEGACY_REQUESTS_PURGED'`)).rows.length, 2);
});

test('purge on an empty database is harmless', async () => {
  const ctx = freshApp(); const { purgeLegacyBookingRequests } = require('../src/lib/legacyPurge');
  assert.equal((await purgeLegacyBookingRequests(ctx.pool, { confirm: true })).bookingRequests, 0);
});

test('creating a match request is off by default: refused after sign-in and role checks, and nothing is stored', async () => {
  const ctx = freshApp(); const sub = await register(ctx, 'subscriber'); const prac = await register(ctx, 'practitioner');
  const body = { disciplineSlug: 'reiki', isUrgent: false };
  const r = await request(ctx.app, 'POST', '/api/marketplace/matches', { token: sub.token, body });
  assert.equal(r.status, 410); assert.equal(r.body.code, 'MATCH_REQUESTS_RETIRED');
  assert.equal((await request(ctx.app, 'POST', '/api/marketplace/matches', { body })).status, 401);
  assert.equal((await request(ctx.app, 'POST', '/api/marketplace/matches', { token: prac.token, body })).status, 403);
  assert.equal(await count(ctx, 'practitioner_matches'), 0);
});
