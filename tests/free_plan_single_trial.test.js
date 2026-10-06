// tests/free_plan_single_trial.test.js
//
// Two product decisions, tested against the REAL controllers, a real pg-mem
// database and a stateful fake Stripe (same harness as billing.test.js):
//
//  1. A new account is labeled 'free' -- not 'trial', and with no trial_ends_at.
//     (Until now every registration wrote plan='trial' plus a 7-day
//     trial_ends_at, a leftover from when every account got a trial. Nothing
//     enforced it, but admin views and getStatus() reported it.)
//
//  2. ONE free trial per account. A first subscribe gets the 7-day trial. Anyone
//     who has subscribed before (i.e. a canceled subscription row exists) and
//     starts again is charged immediately, with no trial. Also: you cannot
//     subscribe a second time while a subscription is already live.
//
// Unlike billing.test.js's fake, the subscriptions.create fake here behaves like
// Stripe on the one point that matters: no trial_period_days => the first invoice
// is charged NOW, and can fail.

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

function freshApp(stripeResponses) {
  Object.keys(require.cache).forEach((key) => { if (key.includes('/src/')) delete require.cache[key]; });
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

/** Stateful, Stripe-like fake. opts.declineNextCharge makes the next NO-TRIAL
 * subscriptions.create fail the way Stripe does with payment_behavior
 * 'error_if_incomplete' and a bad card. subscriptionCreates records every
 * subscriptions.create argument object. */
function buildStripe(opts = {}) {
  const customers = {};
  let seq = 0, subSeq = 0;
  const subscriptionCreates = [];
  const state = { decline: !!opts.declineNextCharge };
  const responses = {
    'customers.create': (args) => { const id = `cus_fx_${++seq}`; customers[id] = { id, email: args.email, metadata: args.metadata || {} }; return customers[id]; },
    'customers.retrieve': (id) => customers[id] || null,
    'customers.update': (id, args) => { Object.assign(customers[id], args); return customers[id]; },
    'setupIntents.create': (args) => ({ id: `seti_${args.customer}`, client_secret: `seti_${args.customer}_secret`, customer: args.customer }),
    'paymentMethods.attach': (pm, args) => ({ id: pm, customer: args.customer }),
    'subscriptions.create': (args) => {
      subscriptionCreates.push(args);
      const now = Math.floor(Date.now() / 1000);
      if (args.trial_period_days) {
        return { id: `sub_fx_${++subSeq}`, customer: args.customer, status: 'trialing', trial_end: now + args.trial_period_days * 86400, current_period_end: now + args.trial_period_days * 86400 };
      }
      if (state.decline) {
        state.decline = false;
        const e = new Error('Your card was declined.');
        e.type = 'StripeCardError'; e.code = 'card_declined'; e.statusCode = 402;
        throw e;
      }
      return { id: `sub_fx_${++subSeq}`, customer: args.customer, status: 'active', trial_end: null, current_period_end: now + 30 * 86400 };
    },
    'subscriptions.cancel': (id) => ({ id, status: 'canceled' }),
  };
  return { responses, subscriptionCreates, state };
}

let n = 0;
async function newSubscriber(app) {
  const email = `single-trial-${++n}-${Date.now()}@test.com`;
  const reg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email, password: 'correct-horse-battery-9', role: 'subscriber' } });
  return { email, token: reg.body.token };
}
async function subscribe(app, token, plan = 'monthly') {
  const si = await jsonRequest(app, 'POST', '/api/billing/setup-intent', { token });
  return jsonRequest(app, 'POST', '/api/billing/subscribe', { token, body: { plan, customerId: si.body.customerId, paymentMethodId: 'pm_fx' } });
}
const profileOf = (pool, email) => pool.query(
  `SELECT sp.plan, sp.trial_ends_at FROM subscriber_profiles sp JOIN users u ON u.id = sp.user_id WHERE u.email = $1`, [email]);

test('FREE LABEL: a new subscriber account is plan "free" with no trial end date, and getStatus says so', async () => {
  const s = buildStripe();
  const { app, pool } = freshApp(s.responses);
  const u = await newSubscriber(app);
  const row = (await profileOf(pool, u.email)).rows[0];
  assert.equal(row.plan, 'free');
  assert.equal(row.trial_ends_at, null, 'a free account has no trial end date -- nothing is ending');
  const st = await jsonRequest(app, 'GET', '/api/billing/status', { token: u.token });
  assert.equal(st.status, 200);
  assert.equal(st.body.plan, 'free');
  assert.equal(st.body.subscription, null);
  assert.equal(st.body.trialAvailable, true, 'a brand-new account still has its one free trial available');
});

test('ONE TRIAL: the first subscribe gets the 7-day trial', async () => {
  const s = buildStripe();
  const { app, pool } = freshApp(s.responses);
  const u = await newSubscriber(app);
  const res = await subscribe(app, u.token);
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'trialing');
  assert.equal(s.subscriptionCreates.length, 1);
  assert.equal(s.subscriptionCreates[0].trial_period_days, 7);
  assert.equal((await profileOf(pool, u.email)).rows[0].plan, 'monthly');
  const st = await jsonRequest(app, 'GET', '/api/billing/status', { token: u.token });
  assert.equal(st.body.trialAvailable, false, 'once subscribed, the free trial is used');
});

test('ONE TRIAL: cancel, then start again -> NO trial, charged immediately, and the plan label returns to free in between', async () => {
  const s = buildStripe();
  const { app, pool } = freshApp(s.responses);
  const u = await newSubscriber(app);
  await subscribe(app, u.token);

  const cancel = await jsonRequest(app, 'POST', '/api/billing/cancel', { token: u.token });
  assert.equal(cancel.status, 200);
  assert.equal((await profileOf(pool, u.email)).rows[0].plan, 'free', 'a canceled subscriber is back on the free plan');
  const st = await jsonRequest(app, 'GET', '/api/billing/status', { token: u.token });
  assert.equal(st.body.trialAvailable, false, 'canceling does not give the trial back');

  const again = await subscribe(app, u.token, 'annual');
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(s.subscriptionCreates.length, 2);
  const second = s.subscriptionCreates[1];
  assert.equal(second.trial_period_days, undefined, 'the second subscription must NOT carry a trial');
  assert.equal(second.payment_behavior, 'error_if_incomplete', 'an immediate charge that fails must not leave a half-created subscription');
  assert.equal(again.body.status, 'active');
  assert.equal(again.body.trialUsed, true);
  assert.equal(again.body.trialEnd, null);

  const row = (await profileOf(pool, u.email)).rows[0];
  assert.equal(row.plan, 'annual');
  assert.equal(row.trial_ends_at, null);
  const sub = await pool.query(`SELECT s.status, s.canceled_at, s.current_period_end FROM subscriptions s JOIN subscriber_profiles sp ON sp.id = s.subscriber_id JOIN users u ON u.id = sp.user_id WHERE u.email = $1`, [u.email]);
  assert.equal(sub.rows[0].status, 'active');
  assert.equal(sub.rows[0].canceled_at, null);
  assert.ok(sub.rows[0].current_period_end, 'billing period end comes from Stripe, not from a trial end');
});

test('ONE TRIAL: a declined card on a no-trial restart is reported clearly and leaves NOTHING recorded', async () => {
  const s = buildStripe();
  const { app, pool } = freshApp(s.responses);
  const u = await newSubscriber(app);
  await subscribe(app, u.token);
  await jsonRequest(app, 'POST', '/api/billing/cancel', { token: u.token });

  s.state.decline = true;
  const res = await subscribe(app, u.token);
  assert.equal(res.status, 402, JSON.stringify(res.body));
  assert.match(res.body.error, /declined/i);
  const sub = await pool.query(`SELECT s.status FROM subscriptions s JOIN subscriber_profiles sp ON sp.id = s.subscriber_id JOIN users u ON u.id = sp.user_id WHERE u.email = $1`, [u.email]);
  assert.equal(sub.rows[0].status, 'canceled', 'the failed restart must not flip the record to active');
  assert.equal((await profileOf(pool, u.email)).rows[0].plan, 'free');

  const retry = await subscribe(app, u.token);
  assert.equal(retry.status, 201, 'after the failure the person can simply try again with another card');
});

test('NO DOUBLE SUBSCRIBE: subscribing while a subscription is live is refused and creates nothing at Stripe', async () => {
  const s = buildStripe();
  const { app } = freshApp(s.responses);
  const u = await newSubscriber(app);
  assert.equal((await subscribe(app, u.token)).status, 201);
  assert.equal(s.subscriptionCreates.length, 1);
  const dup = await subscribe(app, u.token);
  assert.equal(dup.status, 409, JSON.stringify(dup.body));
  assert.match(dup.body.error, /already/i);
  assert.equal(s.subscriptionCreates.length, 1, 'no second Stripe subscription (that would bill the person twice)');
});

test('WEBHOOK: Stripe ending a subscription on its side also returns the plan label to free', async () => {
  const s = buildStripe();
  const { app, pool } = freshApp(s.responses);
  const u = await newSubscriber(app);
  const sub = await subscribe(app, u.token);
  assert.equal(sub.status, 201);
  const subId = (await pool.query(`SELECT external_subscription_id AS id FROM subscriptions LIMIT 1`)).rows[0].id;

  const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'customer.subscription.deleted', data: { object: { id: subId, status: 'canceled' } } });
  const header = realStripeWebhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  const res = await jsonRequest(app, 'POST', '/api/billing/webhook', { rawBody: payload, headers: { 'stripe-signature': header } });
  assert.equal(res.status, 200);
  const st = await jsonRequest(app, 'GET', '/api/billing/status', { token: u.token });
  assert.equal(st.body.subscription.status, 'canceled');
  assert.equal(st.body.plan, 'free');
  assert.equal(st.body.trialAvailable, false);
});
