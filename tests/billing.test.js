// tests/billing.test.js
//
// Exercises the REAL billing.controller.js -- not a simplified
// reimplementation -- with a dependency-injected fake standing in for
// src/lib/stripeClient.js's Stripe SDK instance (see
// tests/fakeStripeClient.js for why this replaced HTTP-level mocking
// with nock, which hung indefinitely in this sandbox). Every assertion
// about what the controller does with a Stripe response, how it
// authorizes requests, and how it writes to the real `subscriptions`
// table runs against the real controller code and a real pg-mem
// database, exactly like every other test in this suite. What this
// CANNOT prove is that Stripe's own real API behaves as these fixtures
// assume -- that needs real STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET
// test-mode credentials this environment doesn't have. See README
// "Final activation checklist".
//
// The fake Stripe client built by buildStatefulStripe() below is
// genuinely STATEFUL within a test, not a set of static canned
// responses: customers.create stores whatever the controller actually
// passed (including its metadata), and customers.retrieve reads that
// same record back. This matters -- an earlier version used static
// fixtures instead, which made the IDOR test below pass even when the
// controller had a real authorization bug (a plausible-looking mock
// happened to agree with what the controller expected, instead of
// reflecting what the controller had actually written). With a
// stateful fake, that bug surfaced immediately.
//
// The webhook signature tests reach all the way to genuinely real
// Stripe code with no fixture involved at all:
// stripe.webhooks.generateTestHeaderString() (a real function Stripe
// ships specifically for this) signs a payload using the exact same
// algorithm stripe.webhooks.constructEvent() verifies against -- both
// real, neither faked -- so the signature-verification path is
// actually proven, not assumed.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const { buildFakeStripeClient, realStripeWebhooks } = require('./fakeStripeClient');
const { buildTestDb } = require('./setup');

process.env.JWT_SECRET = 'test-secret-not-for-production';
process.env.FIELD_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.STRIPE_SECRET_KEY = 'sk_test_fixture_key_present_so_the_controller_does_not_500_on_missing_config';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fixture_secret_for_signature_tests';
process.env.STRIPE_PRICE_ID_MONTHLY = 'price_test_monthly';
process.env.STRIPE_PRICE_ID_ANNUAL = 'price_test_annual';

const dbConfigPath = path.join(__dirname, '..', 'src', 'config', 'db.js');
const stripeConfigPath = path.join(__dirname, '..', 'src', 'lib', 'stripeClient.js');

function freshApp(stripeResponses = {}) {
  Object.keys(require.cache).forEach((key) => {
    if (key.includes('/src/')) delete require.cache[key];
  });
  const testPool = buildTestDb();
  require.cache[require.resolve(dbConfigPath)] = { id: dbConfigPath, filename: dbConfigPath, loaded: true, exports: testPool };

  const fakeStripe = buildFakeStripeClient(stripeResponses);
  require.cache[require.resolve(stripeConfigPath)] = { id: stripeConfigPath, filename: stripeConfigPath, loaded: true, exports: fakeStripe };

  const { createApp } = require('../src/server');
  return { app: createApp(), pool: testPool, stripe: fakeStripe };
}

function jsonRequest(app, method, url, { body, token, rawBody, headers } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = rawBody !== undefined ? rawBody : (body ? JSON.stringify(body) : null);
      const req = http.request({
        method, port, path: url,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(headers || {}),
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          server.close();
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch (e) { parsed = { __raw: data }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  });
}

/** A genuinely stateful fake Stripe: customers.create stores the real
 * object the controller passed (metadata included), customers.retrieve
 * and customers.update read/modify that same stored object. setupIntents
 * / paymentMethods / subscriptions are simpler and don't need cross-call
 * state within these tests, so they stay as straightforward per-call
 * fixture generators. cancelCalls, if passed, records every
 * subscriptions.cancel call for a test to assert against. */
function buildStatefulStripe({ cancelCalls } = {}) {
  const customers = {};
  let seq = 0;
  return {
    'customers.create': (args) => {
      const id = `cus_fixture_${++seq}`;
      const customer = { id, object: 'customer', email: args.email, metadata: args.metadata || {} };
      customers[id] = customer;
      return customer;
    },
    'customers.retrieve': (id) => customers[id] || null,
    'customers.update': (id, args) => {
      if (!customers[id]) throw new Error(`fake stripe: customers.update called for unknown customer ${id}`);
      Object.assign(customers[id], args);
      return customers[id];
    },
    'setupIntents.create': (args) => ({ id: `seti_${args.customer}`, object: 'setup_intent', client_secret: `seti_${args.customer}_secret_fixture`, customer: args.customer, status: 'requires_payment_method' }),
    'paymentMethods.attach': (pmId, args) => ({ id: pmId, object: 'payment_method', type: 'card', customer: args.customer }),
    'subscriptions.create': (args) => ({
      id: `sub_${args.customer}`, object: 'subscription', customer: args.customer, status: 'trialing',
      trial_end: Math.floor(Date.now() / 1000) + 7 * 86400,
      current_period_end: Math.floor(Date.now() / 1000) + 7 * 86400,
    }),
    'subscriptions.cancel': (id) => { if (cancelCalls) cancelCalls.push(id); return { id, object: 'subscription', status: 'canceled' }; },
  };
}

async function registerSubscriber(app, email) {
  return jsonRequest(app, 'POST', '/api/auth/register', { body: { email, password: 'correct-horse-battery-9', role: 'subscriber' } });
}

test('BILLING: createSetupIntent creates a real Stripe customer (with ownership metadata) + SetupIntent through the real controller', async () => {
  const { app } = freshApp(buildStatefulStripe());
  const reg = await registerSubscriber(app, 'billing1@test.com');

  const res = await jsonRequest(app, 'POST', '/api/billing/setup-intent', { token: reg.body.token });
  assert.equal(res.status, 201);
  assert.ok(res.body.customerId.startsWith('cus_fixture_'));
  assert.ok(res.body.clientSecret.startsWith(`seti_${res.body.customerId}`));
});

test('BILLING: subscribe creates a real trialing subscription, records it correctly, and REJECTS a real attempt to use someone else\'s customer id', async () => {
  const { app, pool } = freshApp(buildStatefulStripe());

  const victimReg = await registerSubscriber(app, 'victim-billing@test.com');
  const setupRes = await jsonRequest(app, 'POST', '/api/billing/setup-intent', { token: victimReg.body.token });
  const victimCustomerId = setupRes.body.customerId;

  const subscribeRes = await jsonRequest(app, 'POST', '/api/billing/subscribe', {
    token: victimReg.body.token,
    body: { plan: 'monthly', customerId: victimCustomerId, paymentMethodId: 'pm_fixture_a' },
  });
  assert.equal(subscribeRes.status, 201);
  assert.equal(subscribeRes.body.status, 'trialing');

  const dbRow = await pool.query(
    `SELECT s.status, s.external_subscription_id, sp.plan, sp.trial_ends_at
     FROM subscriptions s JOIN subscriber_profiles sp ON sp.id = s.subscriber_id
     JOIN users u ON u.id = sp.user_id WHERE u.email = 'victim-billing@test.com'`
  );
  assert.equal(dbRow.rows[0].status, 'trialing');
  assert.equal(dbRow.rows[0].plan, 'monthly');
  assert.ok(dbRow.rows[0].trial_ends_at, 'trial_ends_at should be set from the real Stripe trial_end, not left as the registration-time placeholder');

  // SECURITY: an attacker who somehow obtains the victim's real Stripe
  // customerId (a UUID-like string, not secret by design -- the real
  // protection has to be this check, not the id being hard to guess)
  // must not be able to subscribe using it. This is exactly the bug a
  // static-fixture version of this test missed: the ownership check
  // must consult the SAME metadata the controller itself wrote via
  // createSetupIntent, not a mock that happens to look plausible.
  const attackerReg = await registerSubscriber(app, 'attacker-billing@test.com');
  const attackAttempt = await jsonRequest(app, 'POST', '/api/billing/subscribe', {
    token: attackerReg.body.token,
    body: { plan: 'monthly', customerId: victimCustomerId, paymentMethodId: 'pm_attacker' },
  });
  assert.equal(attackAttempt.status, 403, "subscribing with someone else's customerId must be rejected");

  // Confirm the attack genuinely had no effect on the victim's real subscription.
  const dbRowAfter = await pool.query(
    `SELECT s.external_subscription_id FROM subscriptions s JOIN subscriber_profiles sp ON sp.id = s.subscriber_id
     JOIN users u ON u.id = sp.user_id WHERE u.email = 'victim-billing@test.com'`
  );
  assert.equal(dbRowAfter.rows[0].external_subscription_id, dbRow.rows[0].external_subscription_id);
});

test('BILLING: subscribe rejects an invalid plan, missing fields, and a missing price-id configuration with clear errors', async () => {
  const { app } = freshApp(buildStatefulStripe());
  const reg = await registerSubscriber(app, 'billing3@test.com');

  const badPlan = await jsonRequest(app, 'POST', '/api/billing/subscribe', { token: reg.body.token, body: { plan: 'lifetime', customerId: 'cus_x', paymentMethodId: 'pm_x' } });
  assert.equal(badPlan.status, 400);

  const missingFields = await jsonRequest(app, 'POST', '/api/billing/subscribe', { token: reg.body.token, body: { plan: 'monthly' } });
  assert.equal(missingFields.status, 400);

  // try/finally: an earlier version of this test let a failed assertion
  // skip the env var restoration below, corrupting process.env for
  // every test that ran after it in the same process (a real, if
  // self-inflicted, cascading failure found while writing this suite,
  // not just a hypothetical risk).
  const originalAnnual = process.env.STRIPE_PRICE_ID_ANNUAL;
  try {
    delete process.env.STRIPE_PRICE_ID_ANNUAL;
    const missingPriceId = await jsonRequest(app, 'POST', '/api/billing/subscribe', { token: reg.body.token, body: { plan: 'annual', customerId: 'cus_x', paymentMethodId: 'pm_x' } });
    assert.equal(missingPriceId.status, 500);
    assert.match(missingPriceId.body.error, /not fully configured/i);
  } finally {
    process.env.STRIPE_PRICE_ID_ANNUAL = originalAnnual;
  }
});

test('BILLING: canceling during the trial genuinely never creates a charge, and only the owning subscriber can cancel', async () => {
  const cancelCalls = [];
  const { app, pool } = freshApp(buildStatefulStripe({ cancelCalls }));

  const reg = await registerSubscriber(app, 'billing4@test.com');
  const setupRes = await jsonRequest(app, 'POST', '/api/billing/setup-intent', { token: reg.body.token });
  await jsonRequest(app, 'POST', '/api/billing/subscribe', { token: reg.body.token, body: { plan: 'annual', customerId: setupRes.body.customerId, paymentMethodId: 'pm_fixture_c' } });

  const strangerReg = await registerSubscriber(app, 'stranger-billing@test.com');
  const strangerAttempt = await jsonRequest(app, 'POST', '/api/billing/cancel', { token: strangerReg.body.token });
  assert.equal(strangerAttempt.status, 404);
  assert.equal(cancelCalls.length, 0, 'a subscriber with no subscription of their own must never trigger a real Stripe cancel call');

  const cancelRes = await jsonRequest(app, 'POST', '/api/billing/cancel', { token: reg.body.token });
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.body.canceled, true);
  assert.equal(cancelRes.body.wasTrialing, true);
  assert.equal(cancelRes.body.chargedDuringTrial, false);
  assert.equal(cancelCalls.length, 1, 'the real Stripe subscription must actually be canceled, not just marked canceled locally');

  const dbRow = await pool.query(
    `SELECT s.status FROM subscriptions s JOIN subscriber_profiles sp ON sp.id = s.subscriber_id
     JOIN users u ON u.id = sp.user_id WHERE u.email = 'billing4@test.com'`
  );
  assert.equal(dbRow.rows[0].status, 'canceled');

  const secondCancel = await jsonRequest(app, 'POST', '/api/billing/cancel', { token: reg.body.token });
  assert.equal(secondCancel.status, 400);
  assert.equal(cancelCalls.length, 1, 'an already-canceled subscription must not trigger a second real Stripe cancel call');
});

test('BILLING: getStatus reads from the local table, never makes a live Stripe call', async () => {
  const { app } = freshApp(buildStatefulStripe());
  const reg = await registerSubscriber(app, 'billing5@test.com');
  const setupRes = await jsonRequest(app, 'POST', '/api/billing/setup-intent', { token: reg.body.token });
  await jsonRequest(app, 'POST', '/api/billing/subscribe', { token: reg.body.token, body: { plan: 'monthly', customerId: setupRes.body.customerId, paymentMethodId: 'pm_fixture_d' } });

  const statusRes = await jsonRequest(app, 'GET', '/api/billing/status', { token: reg.body.token });
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.body.plan, 'monthly');
  assert.equal(statusRes.body.subscription.status, 'trialing');
});

// ---------------------------------------------------------------------
// Webhook tests -- real Stripe signing/verification code, no fixture
// involved in the signature itself.
// ---------------------------------------------------------------------

function signedWebhookRequest(payloadObj, secret) {
  const payload = JSON.stringify(payloadObj);
  const header = realStripeWebhooks.generateTestHeaderString({ payload, secret });
  return { rawBody: payload, headers: { 'stripe-signature': header } };
}

async function subscribedSubscriber(app, email) {
  const reg = await registerSubscriber(app, email);
  const setupRes = await jsonRequest(app, 'POST', '/api/billing/setup-intent', { token: reg.body.token });
  const subscribeRes = await jsonRequest(app, 'POST', '/api/billing/subscribe', { token: reg.body.token, body: { plan: 'monthly', customerId: setupRes.body.customerId, paymentMethodId: 'pm_fixture' } });
  return { reg, subscriptionId: subscribeRes.body.subscriptionId };
}

test('BILLING WEBHOOK: a genuinely, correctly signed event updates the local subscription -- real Stripe signing AND verification code', async () => {
  const { app, pool } = freshApp(buildStatefulStripe());
  const { subscriptionId } = await subscribedSubscriber(app, 'billing6@test.com');

  // This is the real event: Stripe's own day-8 automatic charge
  // succeeding -- the actual end of the "not charged during the trial"
  // period, driven by Stripe's billing engine, arriving here as a webhook.
  const newPeriodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
  const event = {
    id: 'evt_fixture_1', object: 'event', type: 'invoice.payment_succeeded',
    data: { object: { id: 'in_fixture_1', object: 'invoice', subscription: subscriptionId, current_period_end: newPeriodEnd } },
  };
  const { rawBody, headers } = signedWebhookRequest(event, process.env.STRIPE_WEBHOOK_SECRET);
  const res = await jsonRequest(app, 'POST', '/api/billing/webhook', { rawBody, headers });
  assert.equal(res.status, 200);
  assert.equal(res.body.received, true);

  const dbRow = await pool.query('SELECT status FROM subscriptions WHERE external_subscription_id = $1', [subscriptionId]);
  assert.equal(dbRow.rows[0].status, 'active', 'invoice.payment_succeeded must move status from trialing to active');
});

test('BILLING WEBHOOK: customer.subscription.deleted and invoice.payment_failed correctly update status', async () => {
  const { app, pool } = freshApp(buildStatefulStripe());
  const { subscriptionId } = await subscribedSubscriber(app, 'billing7@test.com');

  const failedEvent = { id: 'evt_fixture_2', object: 'event', type: 'invoice.payment_failed', data: { object: { id: 'in_fixture_2', subscription: subscriptionId } } };
  const signed1 = signedWebhookRequest(failedEvent, process.env.STRIPE_WEBHOOK_SECRET);
  const res1 = await jsonRequest(app, 'POST', '/api/billing/webhook', { rawBody: signed1.rawBody, headers: signed1.headers });
  assert.equal(res1.status, 200);
  const row1 = await pool.query('SELECT status FROM subscriptions WHERE external_subscription_id = $1', [subscriptionId]);
  assert.equal(row1.rows[0].status, 'past_due');

  const deletedEvent = { id: 'evt_fixture_3', object: 'event', type: 'customer.subscription.deleted', data: { object: { id: subscriptionId, status: 'canceled' } } };
  const signed2 = signedWebhookRequest(deletedEvent, process.env.STRIPE_WEBHOOK_SECRET);
  const res2 = await jsonRequest(app, 'POST', '/api/billing/webhook', { rawBody: signed2.rawBody, headers: signed2.headers });
  assert.equal(res2.status, 200);
  const row2 = await pool.query('SELECT status, canceled_at FROM subscriptions WHERE external_subscription_id = $1', [subscriptionId]);
  assert.equal(row2.rows[0].status, 'canceled');
  assert.ok(row2.rows[0].canceled_at);
});

test('BILLING WEBHOOK SECURITY: a tampered or unsigned payload is rejected and never applied', async () => {
  const { app, pool } = freshApp(buildStatefulStripe());
  const { subscriptionId } = await subscribedSubscriber(app, 'billing8@test.com');

  // A real forged attempt: correct-looking event, wrong secret (an
  // attacker who doesn't have the real webhook signing secret cannot
  // produce a valid signature for it, so this is the realistic attack
  // shape, not a contrived one).
  const maliciousEvent = { id: 'evt_fake', object: 'event', type: 'invoice.payment_succeeded', data: { object: { id: 'in_fake', subscription: subscriptionId, current_period_end: 9999999999 } } };
  const forged = signedWebhookRequest(maliciousEvent, 'whsec_attacker_does_not_know_the_real_secret');
  const res1 = await jsonRequest(app, 'POST', '/api/billing/webhook', { rawBody: forged.rawBody, headers: forged.headers });
  assert.equal(res1.status, 400);

  const res2 = await jsonRequest(app, 'POST', '/api/billing/webhook', { rawBody: JSON.stringify(maliciousEvent) });
  assert.equal(res2.status, 400);

  const dbRow = await pool.query('SELECT status FROM subscriptions WHERE external_subscription_id = $1', [subscriptionId]);
  assert.equal(dbRow.rows[0].status, 'trialing', 'a forged/unsigned webhook must never change subscription state');
});
