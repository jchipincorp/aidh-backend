// tests/stripe_run_check.test.js -- the pre-flight check and the after-the-run reconciler, against a SIMULATED Stripe.
// They have not been run against the real Stripe API; the first real run is the test of that.
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshApp, request, register, bookablePractitioner, slot, bookIt, pay, paidBooking, row, H } = require('./consultation_helpers');
const { checkEnvironment, verifyBookings } = require('../src/lib/stripeRunCheck');

const names = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);
const env = (o) => ({ STRIPE_SECRET_KEY: 'sk_test_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_abc', ...o });

test('pre-flight: a live key stops everything, before any call to Stripe', async () => {
  const ctx = freshApp(); const before = ctx.fake._calls.length;
  const r = await checkEnvironment({ env: env({ STRIPE_SECRET_KEY: 'sk_live_abc123' }), stripe: ctx.fake, db: ctx.pool });
  assert.equal(r.errors, 1); assert.match(r.checks[0].detail, /LIVE key/);
  assert.equal(ctx.fake._calls.length, before, 'no call was made to Stripe');
});

test('pre-flight: placeholder or missing keys and a missing webhook secret are reported', async () => {
  const ctx = freshApp();
  assert.ok(names(await checkEnvironment({ env: { STRIPE_WEBHOOK_SECRET: 'whsec_x' }, stripe: ctx.fake, db: ctx.pool })).includes('Stripe secret key is set'));
  assert.ok(names(await checkEnvironment({ env: { STRIPE_SECRET_KEY: 'sk_test_fixture_key', STRIPE_WEBHOOK_SECRET: 'whsec_x' }, stripe: ctx.fake, db: ctx.pool })).includes('Stripe secret key is set'));
  assert.ok(names(await checkEnvironment({ env: env({ STRIPE_WEBHOOK_SECRET: '' }), stripe: ctx.fake, db: ctx.pool })).includes('Webhook signing secret is set'));
});

test('pre-flight: with good test keys, Connect on and the database ready, there are no problems, and the notes warn about non-US practitioners', async () => {
  const ctx = freshApp({ 'balance.retrieve': () => ({ livemode: false }), 'accounts.list': () => ({ data: [] }) });
  const r = await checkEnvironment({ env: env({}), stripe: ctx.fake, db: ctx.pool });
  assert.equal(r.errors, 0, JSON.stringify(names(r)));
  assert.ok(r.checks.some((c) => c.level === 'warn' && /outside the US/.test(c.detail)), 'warns that non-US practitioners cannot onboard as built');
  assert.ok(r.checks.some((c) => c.level === 'warn' && /CONSULTATION_RELEASE_DELAY_HOURS/.test(c.name)));
});

test('pre-flight: Connect not enabled, a live-mode reply, and an unmigrated database are each reported', async () => {
  let ctx = freshApp({ 'balance.retrieve': () => ({ livemode: false }), 'accounts.list': () => { throw new Error('You can only create new accounts if you have signed up for Connect'); } });
  assert.ok(names(await checkEnvironment({ env: env({}), stripe: ctx.fake, db: ctx.pool })).includes('Connect is enabled on this Stripe account'));
  ctx = freshApp({ 'balance.retrieve': () => ({ livemode: true }), 'accounts.list': () => ({ data: [] }) });
  assert.ok(names(await checkEnvironment({ env: env({}), stripe: ctx.fake, db: ctx.pool })).includes('Stripe is reachable with this key, in test mode'));
  ctx = freshApp({ 'balance.retrieve': () => ({ livemode: false }), 'accounts.list': () => ({ data: [] }) });
  const brokenDb = { query: async () => { throw new Error('column "agreement_version" does not exist'); } };
  assert.ok(names(await checkEnvironment({ env: env({}), stripe: ctx.fake, db: brokenDb })).includes('The database has the booking tables and migration 013'));
});

// ---- the reconciler ----
function world(over = {}) {
  const st = { amount: 4000, status: 'succeeded', currency: 'usd', bookingId: null, chargeId: 'ch_test_1', fee: 146, refunds: [], transfer: null, ...over };
  return { st, responses: {
    'paymentIntents.retrieve': () => ({ id: 'pi_test_1', status: st.status, amount: st.amount, currency: st.currency, metadata: { bookingId: st.bookingId }, latest_charge: { id: st.chargeId, balance_transaction: { fee: st.fee } } }),
    'refunds.list': () => ({ data: st.refunds }),
    'transfers.retrieve': () => st.transfer,
  } };
}
const failing = (r) => r.findings.filter((f) => !f.ok).map((f) => f.check);

test('reconciler: a clean paid booking agrees with Stripe on every check', async () => {
  const w = world(); const ctx = freshApp(w.responses); const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const b = await paidBooking(ctx, sub, prac, 0); w.st.bookingId = b.bookingId;
  const r = await verifyBookings({ db: ctx.pool, stripe: ctx.fake });
  assert.equal(r.bookingsChecked, 1); assert.deepEqual(failing(r), [], JSON.stringify(r.findings.filter((f) => !f.ok)));
  assert.ok(r.findings.length >= 6);
});

test('reconciler: it catches a wrong fee, a wrong amount, a booking tied to another payment, and a payment that did not succeed', async () => {
  const w = world(); const ctx = freshApp(w.responses); const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const b = await paidBooking(ctx, sub, prac, 0); w.st.bookingId = b.bookingId;
  w.st.fee = 150; assert.deepEqual(failing(await verifyBookings({ db: ctx.pool, stripe: ctx.fake })), ['the processing fee we recorded equals the fee Stripe charged']); w.st.fee = 146;
  w.st.amount = 3900; assert.deepEqual(failing(await verifyBookings({ db: ctx.pool, stripe: ctx.fake })), ['amount and currency match what we recorded']); w.st.amount = 4000;
  w.st.bookingId = 'someone-else'; assert.deepEqual(failing(await verifyBookings({ db: ctx.pool, stripe: ctx.fake })), ['the payment is tied to this booking (metadata)']); w.st.bookingId = b.bookingId;
  w.st.status = 'requires_payment_method'; assert.deepEqual(failing(await verifyBookings({ db: ctx.pool, stripe: ctx.fake })), ['the payment succeeded at Stripe']);
});

test('reconciler: refunds are compared with what we recorded (payment minus the fee for an early subscriber cancellation)', async () => {
  const w = world(); const ctx = freshApp(w.responses); const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const b = await paidBooking(ctx, sub, prac, 0); w.st.bookingId = b.bookingId;
  await ctx.pool.query('UPDATE consultation_bookings SET starts_at = $1, ends_at = $2 WHERE id = $3', [new Date(Date.now() + 72 * H), new Date(Date.now() + 72 * H + 1800000), b.bookingId]);
  assert.equal((await request(ctx.app, 'POST', `/api/consultations/${b.bookingId}/cancel`, { token: sub.token })).body.refundCents, 3854);
  w.st.refunds = [{ amount: 3854, status: 'succeeded' }];
  assert.deepEqual(failing(await verifyBookings({ db: ctx.pool, stripe: ctx.fake })), [], 'Stripe refunded exactly what we recorded');
  w.st.refunds = [{ amount: 4000, status: 'succeeded' }];
  assert.deepEqual(failing(await verifyBookings({ db: ctx.pool, stripe: ctx.fake })), ['the amount refunded at Stripe equals what we recorded'], 'a full refund where we recorded payment-minus-fee is caught');
  w.st.refunds = [{ amount: 3854, status: 'failed' }];
  assert.ok(failing(await verifyBookings({ db: ctx.pool, stripe: ctx.fake })).length === 1, 'a failed refund does not count');
});

test('reconciler: a released booking\'s transfer is checked for amount, destination, charge and reversal', async () => {
  const w = world(); const ctx = freshApp(w.responses); const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const b = await paidBooking(ctx, sub, prac, 0); w.st.bookingId = b.bookingId;
  assert.equal((await ctx.jobs.runConsultationJobs(Date.now() + 60 * 24 * H)).released, 1);
  const t = (await row(ctx, b.bookingId)).stripe_transfer_id; assert.ok(t);
  w.st.transfer = { id: t, amount: 2854, destination: 'acct_test_1', source_transaction: 'ch_test_1', reversed: false, amount_reversed: 0 };
  assert.deepEqual(failing(await verifyBookings({ db: ctx.pool, stripe: ctx.fake })), [], 'a correct transfer passes');
  w.st.transfer = { ...w.st.transfer, amount: 3000 };
  assert.ok(failing(await verifyBookings({ db: ctx.pool, stripe: ctx.fake })).includes('the transfer is the practitioner\'s 75% share minus the processing fee'));
  w.st.transfer = { ...w.st.transfer, amount: 2854, destination: 'acct_wrong' };
  assert.deepEqual(failing(await verifyBookings({ db: ctx.pool, stripe: ctx.fake })), ['the transfer went to the practitioner\'s connected account']);
  w.st.transfer = { ...w.st.transfer, destination: 'acct_test_1', amount_reversed: 500, reversed: false };
  assert.deepEqual(failing(await verifyBookings({ db: ctx.pool, stripe: ctx.fake })), ['the transfer has not been reversed']);
});

test('reconciler: with no Stripe payments yet it says so and does not fail', async () => {
  const ctx = freshApp(); const r = await verifyBookings({ db: ctx.pool, stripe: ctx.fake });
  assert.deepEqual([r.bookingsChecked, r.mismatches], [0, 0]);
});
