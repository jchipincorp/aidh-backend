// tests/consultation_helpers.js -- shared setup for the consultation tests (real controllers and SQL, fake Stripe).
// tests/consultations.test.js
//
// The real controllers, the real SQL (in-memory Postgres), the real webhook signature check, and
// a FAKE Stripe for everything that would call Stripe's servers. What this proves: our logic --
// the slot guard, the money split, link visibility, cancellation, late payment, release, disputes.
// What it cannot prove: that Stripe's real API accepts these exact calls. That needs a Stripe test
// account and is listed as an open item in the README.
const assert = require('node:assert/strict');
const path = require('path');
const { buildTestDb } = require('./setup');
const { buildFakeStripeClient, realStripeWebhooks } = require('./fakeStripeClient');

process.env.JWT_SECRET = 'test-secret-not-for-production';
process.env.FIELD_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.STRIPE_SECRET_KEY = 'sk_test_fixture_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_consultations';
process.env.MAIL_PROVIDER = 'outbox';
process.env.CONSULTATION_RETURN_URL = 'https://app.test/aidh_marketplace.html';
delete process.env.AIDH_STORE_HEALTH_DATA;

const dbConfigPath = path.join(__dirname, '..', 'src', 'config', 'db.js');
const stripePath = path.join(__dirname, '..', 'src', 'lib', 'stripeClient.js');

function stripeResponses(over = {}) {
  let n = 0;
  return {
    'checkout.sessions.create': () => { n += 1; return { id: `cs_test_${n}`, url: `https://checkout.stripe.test/c/${n}` }; },
    'checkout.sessions.expire': () => ({ id: 'cs_expired' }),
    'accounts.create': () => ({ id: 'acct_test_1' }),
    'accountLinks.create': () => ({ url: 'https://connect.stripe.test/onboard' }),
    'accounts.retrieve': () => ({ id: 'acct_test_1', details_submitted: true, payouts_enabled: true, capabilities: { transfers: 'active' } }),
    'paymentIntents.retrieve': () => ({ id: 'pi_test_1', latest_charge: { id: 'ch_test_1', balance_transaction: { fee: 146 } } }),
    'refunds.create': () => ({ id: 're_test_1' }),
    'transfers.create': () => ({ id: 'tr_test_1' }),
    ...over,
  };
}
function freshApp(over) {
  Object.keys(require.cache).forEach((k) => { if (k.includes('/src/')) delete require.cache[k]; });
  const pool = buildTestDb();
  const fake = buildFakeStripeClient(stripeResponses(over));
  require.cache[require.resolve(dbConfigPath)] = { id: dbConfigPath, filename: dbConfigPath, loaded: true, exports: pool };
  require.cache[require.resolve(stripePath)] = { id: stripePath, filename: stripePath, loaded: true, exports: fake };
  const { createApp } = require('../src/server');
  const mailer = require('../src/lib/mailer'); mailer.outbox.length = 0;
  const jobs = require('../src/lib/consultationJobs');
  return { app: createApp(), pool, fake, mailer, jobs };
}
function request(app, method, url, { body, token, rawBody, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = rawBody != null ? rawBody : (body ? JSON.stringify(body) : null);
      const req = http.request({ method, port, path: url, headers: {
        'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }, (res) => {
        let d = ''; res.on('data', (c) => (d += c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }); });
      });
      req.on('error', reject); if (payload) req.write(payload); req.end();
    });
  });
}
let seq = 0;
async function register(ctx, role, plan) {
  seq += 1; const email = `${role}${seq}@test.com`;
  const r = await request(ctx.app, 'POST', '/api/auth/register', { body: { email, password: 'correct-horse-battery-9', role } });
  assert.equal(r.status, 201, 'register: ' + JSON.stringify(r.body));
  if (plan) {
    const u = await ctx.pool.query('SELECT id FROM users WHERE email = $1', [email]);
    await ctx.pool.query('UPDATE subscriber_profiles SET plan = $1 WHERE user_id = $2', [plan, u.rows[0].id]);
  }
  return { token: r.body.token, email };
}
async function practitionerId(ctx, email) {
  const u = await ctx.pool.query('SELECT id FROM users WHERE email = $1', [email]);
  const r = await ctx.pool.query('SELECT id FROM practitioner_profiles WHERE user_id = $1', [u.rows[0].id]);
  return r.rows[0].id;
}
async function bookablePractitioner(ctx, opts = {}) {
  const p = await register(ctx, 'practitioner'); const id = await practitionerId(ctx, p.email);
  await ctx.pool.query(`UPDATE practitioner_profiles SET verification_status = 'verified', first_name = $2, last_name = $3, city = 'Pune', country = 'India', qualifications = 'ND, 8 years in practice' WHERE id = $1`, [id, opts.first || 'Asha', opts.last || 'Rao']);
  const s = await request(ctx.app, 'PUT', '/api/consultations/settings', { token: p.token, body: {
    sessionPriceCents: opts.price || 4000, premiumPriceCents: opts.premium || 3000, sessionMinutes: 30, timezone: 'Asia/Kolkata',
    videoLink: 'https://meet.google.com/abc-defg-hij', hostAdmitsAck: true, acceptingBookings: true, directoryConsent: opts.consent !== false } });
  assert.equal(s.status, 200, 'settings: ' + JSON.stringify(s.body));
  if (opts.agreement !== false) {
    const ag = await request(ctx.app, 'GET', '/api/consultations/agreement');
    const ac = await request(ctx.app, 'POST', '/api/consultations/agreement/accept', { token: p.token, body: { version: ag.body.version, accept: true } });
    assert.equal(ac.status, 200, 'agreement: ' + JSON.stringify(ac.body));
  }
  const windows = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, startMinute: 540, endMinute: 720 }));
  assert.equal((await request(ctx.app, 'PUT', '/api/consultations/availability', { token: p.token, body: { windows } })).status, 200);
  await request(ctx.app, 'POST', '/api/consultations/connect/onboard', { token: p.token });
  const st = await request(ctx.app, 'GET', '/api/consultations/connect/status', { token: p.token });
  assert.equal(st.body.payoutsEnabled, true);
  return { ...p, id };
}
async function slot(ctx, pid, n = 0) {
  const r = await request(ctx.app, 'GET', `/api/consultations/practitioners/${pid}/slots`);
  assert.equal(r.status, 200, 'slots: ' + JSON.stringify(r.body)); return r.body.slots[n];
}
async function bookIt(ctx, sub, pid, startsAt) {
  const r = await request(ctx.app, 'POST', '/api/consultations/book', { token: sub.token, body: { practitionerId: pid, startsAt } });
  return r;
}
function signed(event, secret = process.env.STRIPE_WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  return { rawBody: payload, headers: { 'stripe-signature': realStripeWebhooks.generateTestHeaderString({ payload, secret }) } };
}
async function pay(ctx, bookingId) {
  seq += 1;
  return request(ctx.app, 'POST', '/api/billing/webhook', signed({ id: 'evt_' + seq, type: 'checkout.session.completed',
    data: { object: { id: 'cs_x', payment_intent: 'pi_test_1', metadata: { bookingId } } } }));
}
async function paidBooking(ctx, sub, prac, n = 0) {
  const b = await bookIt(ctx, sub, prac.id, await slot(ctx, prac.id, n)); assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal((await pay(ctx, b.body.bookingId)).status, 200); return b.body;
}
const row = async (ctx, id) => (await ctx.pool.query('SELECT * FROM consultation_bookings WHERE id = $1', [id])).rows[0];
const H = 3600000;

function rawGet(app, url, { token } = {}) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const server = app.listen(0, () => {
      const req = http.request({ method: 'GET', port: server.address().port, path: url, headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
        const chunks = []; res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
      });
      req.on('error', reject); req.end();
    });
  });
}
module.exports = { freshApp, request, rawGet, register, practitionerId, bookablePractitioner, slot, bookIt, signed, pay, paidBooking, row, H, buildFakeStripeClient };
