// scripts/verify-consultations-real-postgres.js
//
// The consultation flow's critical paths against REAL PostgreSQL (the test suite uses an in-memory
// engine, which can differ on exactly the things this flow depends on: the UNIQUE slot guard and how
// it treats NULLs, constraints, joins). Stripe is still the fake -- this proves our SQL and logic on
// a real database, not Stripe's API.
// Usage: DATABASE_URL=postgres://... npm run migrate && npm run seed && node scripts/verify-consultations-real-postgres.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'pg-verify-secret-not-for-production';
process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || 'c'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fixture_key'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_pg_verify';
process.env.MAIL_PROVIDER = 'outbox'; delete process.env.AIDH_STORE_HEALTH_DATA;
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/aidh_test';
const path = require('path'); const http = require('http'); const { Pool } = require('pg');
const { buildFakeStripeClient, realStripeWebhooks } = require('../tests/fakeStripeClient');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let n = 0;
const fake = buildFakeStripeClient({
  'checkout.sessions.create': () => { n += 1; return { id: `cs_pg_${Date.now()}_${n}`, url: 'https://checkout.stripe.test/x' }; },
  'checkout.sessions.expire': () => ({}), 'accounts.create': () => ({ id: 'acct_pg_1' }), 'accountLinks.create': () => ({ url: 'https://connect.stripe.test/x' }),
  'accounts.retrieve': () => ({ id: 'acct_pg_1', details_submitted: true, payouts_enabled: true, capabilities: { transfers: 'active' } }),
  'paymentIntents.retrieve': () => ({ id: 'pi_pg_1', latest_charge: { id: 'ch_pg_1', balance_transaction: { fee: 146 } } }),
  'refunds.create': () => ({ id: 're_pg_1' }), 'transfers.create': () => ({ id: 'tr_pg_1' }),
});
require.cache[require.resolve('../src/config/db.js')] = { id: 'db', filename: 'db', loaded: true, exports: pool };
require.cache[require.resolve('../src/lib/stripeClient.js')] = { id: 'sc', filename: 'sc', loaded: true, exports: fake };
const app = require('../src/server.js').createApp();
const jobs = require('../src/lib/consultationJobs');
let pass = 0, fail = 0; const check = (name, ok) => { ok ? pass++ : fail++; console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name); };
const R = (method, url, { body, token, rawBody, headers = {} } = {}) => new Promise((resolve, reject) => {
  const server = app.listen(0, () => {
    const payload = rawBody != null ? rawBody : (body ? JSON.stringify(body) : null);
    const req = http.request({ method, port: server.address().port, path: url, headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }); }); });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
});
const run = Date.now();
const reg = async (role, tag) => { const email = `${tag}-${run}@pg.test`; const r = await R('POST', '/api/auth/register', { body: { email, password: 'correct-horse-battery-9', role } }); return { email, token: r.body.token }; };
const pay = (bookingId) => { const payload = JSON.stringify({ id: 'evt_' + (++n), type: 'checkout.session.completed', data: { object: { id: 'cs_x', payment_intent: 'pi_pg_1', metadata: { bookingId } } } });
  return R('POST', '/api/billing/webhook', { rawBody: payload, headers: { 'stripe-signature': realStripeWebhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET }) } }); };
(async () => {
  const prac = await reg('practitioner', 'prac');
  const u = await pool.query('SELECT id FROM users WHERE email = $1', [prac.email]);
  const pid = (await pool.query('SELECT id FROM practitioner_profiles WHERE user_id = $1', [u.rows[0].id])).rows[0].id;
  await pool.query(`UPDATE practitioner_profiles SET verification_status = 'verified', first_name = 'Asha', last_name = 'Rao', city = 'Pune', country = 'India', qualifications = 'ND, 8 years in practice' WHERE id = $1`, [pid]);
  const s = await R('PUT', '/api/consultations/settings', { token: prac.token, body: { sessionPriceCents: 4000, premiumPriceCents: 3000, sessionMinutes: 30, timezone: 'Asia/Kolkata', videoLink: 'https://meet.google.com/abc-defg-hij', hostAdmitsAck: true, acceptingBookings: true, directoryConsent: true } });
  check('practitioner settings saved on real Postgres', s.status === 200);
  await R('PUT', '/api/consultations/availability', { token: prac.token, body: { windows: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, startMinute: 540, endMinute: 720 })) } });
  await R('POST', '/api/consultations/connect/onboard', { token: prac.token });
  check('payouts become ready', (await R('GET', '/api/consultations/connect/status', { token: prac.token })).body.payoutsEnabled === true);
  check('with everything else ready but the agreement not accepted, the practitioner is not bookable or listed (real Postgres)', (await R('GET', `/api/consultations/practitioners/${pid}/slots`)).status === 409 && (await R('GET', '/api/consultations/practitioners')).body.practitioners.length === 0);
  const agr = (await R('GET', '/api/consultations/agreement')).body;
  check('the draft agreement is announced as a draft, and accepting the current version works', agr.isDraft === true && (await R('POST', '/api/consultations/agreement/accept', { token: prac.token, body: { version: agr.version, accept: true } })).body.agreement.accepted === true);
  const listed = (await R('GET', '/api/consultations/practitioners')).body.practitioners;
  check('the directory lists the consenting practitioner with name, credentials and location', listed.length === 1 && listed[0].displayName === 'Asha Rao' && /ND, 8 years/.test(listed[0].credentials) && listed[0].location === 'Pune, India');
  const TINY = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCaiiiuU+NP/9k=';
  check('a headshot uploads', (await R('PUT', '/api/consultations/photo', { token: prac.token, body: { imageBase64: TINY } })).status === 200);
  const photo = await new Promise((resolve) => { const server = app.listen(0, () => { http.get({ port: server.address().port, path: `/api/consultations/practitioners/${pid}/photo` }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => { server.close(); resolve({ status: res.statusCode, type: res.headers['content-type'], bytes: Buffer.concat(c) }); }); }); }); });
  check('and is served publicly as a JPEG for the listed practitioner', photo.status === 200 && photo.type === 'image/jpeg' && photo.bytes[0] === 0xFF && photo.bytes[1] === 0xD8);
  const slots = (await R('GET', `/api/consultations/practitioners/${pid}/slots`)).body.slots;
  check('slots are generated from the weekly schedule', Array.isArray(slots) && slots.length > 20);

  const a = await reg('subscriber', 'sa'), b = await reg('subscriber', 'sb'), c = await reg('subscriber', 'sc');
  const book = (who, when) => R('POST', '/api/consultations/book', { token: who.token, body: { practitionerId: pid, startsAt: when } });
  const [x, y] = await Promise.all([book(a, slots[0]), book(b, slots[0])]);
  check('two subscribers racing for one slot: exactly one 201 and one 409 (real UNIQUE index)', [x.status, y.status].sort().join() === '201,409');
  const winner = x.status === 201 ? { who: a, r: x } : { who: b, r: y };
  check('the double-booking guard left exactly one active slot_key', (await pool.query(`SELECT COUNT(*)::int AS n FROM consultation_bookings WHERE practitioner_id = $1 AND slot_key IS NOT NULL`, [pid])).rows[0].n === 1);

  check('webhook (really signed) confirms the booking', (await pay(winner.r.body.bookingId)).status === 200);
  const row = (await pool.query('SELECT status, platform_fee_cents, practitioner_share_cents, stripe_fee_cents, practitioner_payout_cents FROM consultation_bookings WHERE id = $1', [winner.r.body.bookingId])).rows[0];
  check('money: 25% platform, 75% share, share minus Stripe fee = 2854', row.status === 'confirmed' && row.platform_fee_cents === 1000 && row.practitioner_share_cents === 3000 && row.practitioner_payout_cents === 2854);
  check('the link is shown to the booked subscriber after payment', (await R('GET', `/api/consultations/${winner.r.body.bookingId}`, { token: winner.who.token })).body.videoLink === 'https://meet.google.com/abc-defg-hij');
  check('and never to another subscriber', (await R('GET', `/api/consultations/${winner.r.body.bookingId}`, { token: c.token })).status === 404);

  check('account deletion is refused while the paid booking is in flight', (await R('DELETE', '/api/subscriber/me', { token: winner.who.token })).status === 409);
  await pool.query('UPDATE consultation_bookings SET starts_at = $1, ends_at = $2 WHERE id = $3', [new Date(Date.now() + 72 * 3600000), new Date(Date.now() + 72 * 3600000 + 1800000), winner.r.body.bookingId]);
  const cancel = await R('POST', `/api/consultations/${winner.r.body.bookingId}/cancel`, { token: winner.who.token });
  check('cancelling 24h+ ahead refunds the payment minus Stripe\'s fee (4000 - 146 = 3854)', cancel.status === 200 && cancel.body.refundCents === 3854 && cancel.body.withheldCents === 146);
  const again = await book(c, slots[0]);
  check('the freed slot can be booked again (a UNIQUE index lets NULL slot_keys coexist on real Postgres)', again.status === 201);

  check('a second hold is not released before its window', (await jobs.runConsultationJobs(Date.now())).released === 0);
  await pay(again.body.bookingId);
  const out = await jobs.runConsultationJobs(Date.now() + 90 * 24 * 3600000);
  check('release job pays the practitioner exactly once', out.released === 1 && fake._calls.filter((k) => k.resource === 'transfers').length === 1);
  const t = fake._calls.find((k) => k.resource === 'transfers').args[0];
  check('transfer = 2854 to the practitioner account, tied to the charge', t.amount === 2854 && t.destination === 'acct_pg_1' && t.source_transaction === 'ch_pg_1');
  check('running the job again pays nothing more', (await jobs.runConsultationJobs(Date.now() + 90 * 24 * 3600000)).released === 0);

  console.log(`\n${pass} passed, ${fail} failed (against REAL PostgreSQL, Stripe faked)`);
  await pool.end(); process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('CRASHED:', e); process.exit(1); });
