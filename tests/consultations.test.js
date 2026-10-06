// tests/consultations.test.js -- see tests/consultation_helpers.js for the shared setup.
// The real controllers, the real SQL (in-memory Postgres), the real webhook signature check, and a FAKE
// Stripe for everything that would call Stripe's servers. What this proves: our logic -- the slot guard,
// the money split, link visibility, cancellation, late payment, release, disputes. What it cannot prove:
// that Stripe's real API accepts these exact calls (that needs a Stripe test account; see the README).
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshApp, request, register, practitionerId, bookablePractitioner, slot, bookIt, signed, pay, paidBooking, row, H } = require('./consultation_helpers');

test('a practitioner is not bookable until verified, priced, linked, acknowledged and payout-ready', async () => {
  const ctx = freshApp();
  const p = await register(ctx, 'practitioner'); const id = await practitionerId(ctx, p.email);
  assert.equal((await request(ctx.app, 'GET', `/api/consultations/practitioners/${id}/slots`)).status, 409);
  const s = await request(ctx.app, 'GET', '/api/consultations/settings', { token: p.token });
  assert.equal(s.body.bookable, false);
  for (const reason of ['not_verified', 'profile_incomplete', 'agreement_not_accepted', 'no_directory_consent', 'not_accepting_bookings', 'no_price', 'no_video_link', 'payouts_not_ready']) assert.ok(s.body.notBookableBecause.includes(reason), reason);
  const ready = await bookablePractitioner(ctx);
  assert.equal((await request(ctx.app, 'GET', `/api/consultations/practitioners/${ready.id}/slots`)).status, 200);
  const list = await request(ctx.app, 'GET', '/api/consultations/practitioners');
  assert.deepEqual(list.body.practitioners.map((x) => x.id), [ready.id], 'only the bookable practitioner is listed');
});

test('shared-link safeguards: http, embedded credentials and a missing acknowledgement are refused; any https provider is accepted', async () => {
  const ctx = freshApp(); const p = await register(ctx, 'practitioner');
  const put = (body) => request(ctx.app, 'PUT', '/api/consultations/settings', { token: p.token, body });
  assert.equal((await put({ videoLink: 'http://meet.google.com/abc', hostAdmitsAck: true })).status, 400);
  assert.equal((await put({ videoLink: 'https://user:pw@meet.google.com/abc', hostAdmitsAck: true })).status, 400);
  assert.equal((await put({ videoLink: 'https://meet.google.com/abc-defg-hij' })).status, 400, 'no acknowledgement');
  assert.equal((await put({ videoLink: 'https://meet.google.com/abc-defg-hij', hostAdmitsAck: false })).status, 400);
  const ok = await put({ videoLink: 'https://us02web.zoom.us/j/123456789', hostAdmitsAck: true });
  assert.equal(ok.status, 200); assert.equal(ok.body.videoLink, 'https://us02web.zoom.us/j/123456789');
  assert.ok(ok.body.videoLinkReconfirmDueAt, 'a re-confirmation date is set');
});

test('a stale link confirmation makes the practitioner unbookable until it is re-confirmed', async () => {
  const ctx = freshApp(); const p = await bookablePractitioner(ctx);
  await ctx.pool.query('UPDATE practitioner_booking_settings SET video_link_confirmed_at = $1 WHERE practitioner_id = $2', [new Date(Date.now() - 100 * 24 * H), p.id]);
  assert.equal((await request(ctx.app, 'GET', `/api/consultations/practitioners/${p.id}/slots`)).status, 409);
  const re = await request(ctx.app, 'PUT', '/api/consultations/settings', { token: p.token, body: { hostAdmitsAck: true } });
  assert.equal(re.status, 200);
  assert.equal((await request(ctx.app, 'GET', `/api/consultations/practitioners/${p.id}/slots`)).status, 200);
});

test('settings and availability are validated', async () => {
  const ctx = freshApp(); const p = await register(ctx, 'practitioner');
  const put = (body) => request(ctx.app, 'PUT', '/api/consultations/settings', { token: p.token, body });
  assert.equal((await put({ sessionPriceCents: 50 })).status, 400);
  assert.equal((await put({ sessionPriceCents: 4000, premiumPriceCents: 5000 })).status, 400, 'Premium cannot cost more than standard');
  assert.equal((await put({ timezone: 'Not/AZone' })).status, 400);
  assert.equal((await put({ sessionMinutes: 17 })).status, 400);
  const av = (windows) => request(ctx.app, 'PUT', '/api/consultations/availability', { token: p.token, body: { windows } });
  assert.equal((await av([{ weekday: 1, startMinute: 600, endMinute: 540 }])).status, 400);
  assert.equal((await av([{ weekday: 9, startMinute: 0, endMinute: 60 }])).status, 400);
  assert.equal((await av('nope')).status, 400);
  assert.equal((await av([{ weekday: 1, startMinute: 540, endMinute: 720 }])).status, 200);
});

test('booking holds the slot, creates one Checkout session with the right amount, and a second subscriber cannot take the same time', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx);
  const a = await register(ctx, 'subscriber'); const b = await register(ctx, 'subscriber');
  const when = await slot(ctx, prac.id);
  const r = await bookIt(ctx, a, prac.id, when);
  assert.equal(r.status, 201); assert.equal(r.body.amountCents, 4000); assert.equal(r.body.priceBasis, 'standard');
  assert.match(r.body.checkoutUrl, /^https:\/\/checkout\.stripe\.test/);
  const call = ctx.fake._calls.find((c) => c.resource === 'checkout.sessions' && c.method === 'create').args[0];
  assert.equal(call.mode, 'payment'); assert.equal(call.line_items[0].price_data.unit_amount, 4000);
  assert.equal(call.metadata.bookingId, r.body.bookingId); assert.equal(call.payment_intent_data.transfer_group, r.body.bookingId);
  const dup = await bookIt(ctx, b, prac.id, when);
  assert.equal(dup.status, 409, 'the held slot is no longer offered');
  assert.notEqual(await slot(ctx, prac.id, 0), when, 'the held time is no longer the first offered');
});

test('two subscribers racing for the same slot: exactly one wins, the database guard decides', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx);
  const a = await register(ctx, 'subscriber'); const b = await register(ctx, 'subscriber');
  const when = await slot(ctx, prac.id);
  const [x, y] = await Promise.all([bookIt(ctx, a, prac.id, when), bookIt(ctx, b, prac.id, when)]);
  assert.deepEqual([x.status, y.status].sort(), [201, 409]);
  const n = await ctx.pool.query(`SELECT COUNT(*)::int AS n FROM consultation_bookings WHERE slot_key IS NOT NULL`);
  assert.equal(n.rows[0].n, 1);
});

test('a time the practitioner does not offer cannot be booked', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const a = await register(ctx, 'subscriber');
  const odd = new Date(Date.now() + 5 * 24 * H); odd.setUTCMinutes(7, 0, 0);
  assert.equal((await bookIt(ctx, a, prac.id, odd.toISOString())).status, 409);
});

test('a Premium subscriber is charged the practitioner\'s Premium price', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const prem = await register(ctx, 'subscriber', 'monthly');
  const r = await bookIt(ctx, prem, prac.id, await slot(ctx, prac.id));
  assert.equal(r.body.amountCents, 3000); assert.equal(r.body.priceBasis, 'premium');
  const b = await row(ctx, r.body.bookingId);
  assert.equal(b.platform_fee_cents, 750); assert.equal(b.practitioner_share_cents, 2250);
});

test('a checkout failure at Stripe frees the slot again', async () => {
  const ctx = freshApp({ 'checkout.sessions.create': () => { throw new Error('stripe down'); } });
  const prac = await bookablePractitioner(ctx); const a = await register(ctx, 'subscriber');
  const when = await slot(ctx, prac.id);
  assert.equal((await bookIt(ctx, a, prac.id, when)).status, 502);
  assert.equal(await slot(ctx, prac.id), when, 'the same first slot is offered again');
});

test('an unpaid hold expires, frees the slot, and asks Stripe to close the session', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const a = await register(ctx, 'subscriber');
  const when = await slot(ctx, prac.id); const r = await bookIt(ctx, a, prac.id, when);
  await ctx.pool.query('UPDATE consultation_bookings SET hold_expires_at = $1 WHERE id = $2', [new Date(Date.now() - 60000), r.body.bookingId]);
  const out = await ctx.jobs.runConsultationJobs(Date.now());
  assert.equal(out.expiredHolds, 1);
  assert.equal((await row(ctx, r.body.bookingId)).status, 'expired');
  assert.ok(ctx.fake._calls.some((c) => c.resource === 'checkout.sessions' && c.method === 'expire'));
  assert.equal(await slot(ctx, prac.id), when);
});

test('the webhook confirms the booking, records Stripe\'s fee, emails both people, and a replay changes nothing', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const r = await bookIt(ctx, sub, prac.id, await slot(ctx, prac.id));
  assert.equal((await pay(ctx, r.body.bookingId)).status, 200);
  const b = await row(ctx, r.body.bookingId);
  assert.equal(b.status, 'confirmed'); assert.equal(b.stripe_fee_cents, 146); assert.equal(b.platform_fee_cents, 1000);
  assert.equal(b.practitioner_share_cents, 3000); assert.equal(b.practitioner_payout_cents, 2854, '75% of the gross minus Stripe\'s fee');
  assert.equal(b.stripe_charge_id, 'ch_test_1');
  assert.equal(new Date(b.release_after).getTime(), new Date(b.ends_at).getTime() + 24 * H);
  assert.equal(ctx.mailer.outbox.length, 2);
  const toSub = ctx.mailer.outbox.find((m) => m.to === sub.email); const toPrac = ctx.mailer.outbox.find((m) => m.to === prac.email);
  assert.match(toSub.text, /meet\.google\.com\/abc-defg-hij/); assert.match(toSub.text, new RegExp(r.body.ref));
  assert.match(toPrac.text, /meet\.google\.com\/abc-defg-hij/); assert.match(toPrac.text, new RegExp(sub.email.replace('.', '\\.')));
  assert.doesNotMatch(toSub.text + toPrac.text, /sliders?|score|diagnos|medication/i, 'booking emails carry no health information');
  assert.equal((await pay(ctx, r.body.bookingId)).status, 200, 'replay is accepted');
  assert.equal(ctx.mailer.outbox.length, 2, 'no duplicate emails'); assert.equal((await row(ctx, r.body.bookingId)).status, 'confirmed');
});

test('a webhook with a bad signature is rejected and confirms nothing', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const r = await bookIt(ctx, sub, prac.id, await slot(ctx, prac.id));
  const forged = signed({ id: 'evt_forged', type: 'checkout.session.completed', data: { object: { id: 'cs_x', payment_intent: 'pi_test_1', metadata: { bookingId: r.body.bookingId } } } }, 'whsec_wrong_secret');
  assert.equal((await request(ctx.app, 'POST', '/api/billing/webhook', forged)).status, 400);
  assert.equal((await row(ctx, r.body.bookingId)).status, 'held');
});

test('the video link is shown only to the booked subscriber and that practitioner, and only after payment', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const other = await bookablePractitioner(ctx);
  const sub = await register(ctx, 'subscriber'); const stranger = await register(ctx, 'subscriber');
  const r = await bookIt(ctx, sub, prac.id, await slot(ctx, prac.id)); const id = r.body.bookingId;
  assert.equal((await request(ctx.app, 'GET', `/api/consultations/${id}`, { token: sub.token })).body.videoLink, null, 'not before payment');
  await pay(ctx, id);
  assert.equal((await request(ctx.app, 'GET', `/api/consultations/${id}`, { token: sub.token })).body.videoLink, 'https://meet.google.com/abc-defg-hij');
  assert.equal((await request(ctx.app, 'GET', `/api/consultations/${id}`, { token: prac.token })).body.videoLink, 'https://meet.google.com/abc-defg-hij');
  assert.equal((await request(ctx.app, 'GET', `/api/consultations/${id}`, { token: stranger.token })).status, 404);
  assert.equal((await request(ctx.app, 'GET', `/api/consultations/${id}`, { token: other.token })).status, 404);
  assert.equal((await request(ctx.app, 'GET', `/api/consultations/${id}`)).status, 401);
  const everywhere = JSON.stringify([
    (await request(ctx.app, 'GET', '/api/consultations/practitioners')).body,
    (await request(ctx.app, 'GET', `/api/consultations/practitioners/${prac.id}/slots`)).body,
    (await request(ctx.app, 'GET', '/api/consultations/mine', { token: sub.token })).body,
    (await request(ctx.app, 'GET', '/api/consultations/mine', { token: stranger.token })).body,
  ]);
  assert.doesNotMatch(everywhere, /meet\.google\.com/, 'no listing endpoint ever includes the link');
});

test('cancellation: full refund 24h+ ahead, none inside 24h, always full when the practitioner cancels, and the slot is freed', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx);
  const early = await register(ctx, 'subscriber'); const late = await register(ctx, 'subscriber'); const byPrac = await register(ctx, 'subscriber');
  const b1 = await paidBooking(ctx, early, prac, 0); const b2 = await paidBooking(ctx, late, prac, 1); const b3 = await paidBooking(ctx, byPrac, prac, 2);
  const setStart = (id, hrs) => ctx.pool.query('UPDATE consultation_bookings SET starts_at = $1, ends_at = $2 WHERE id = $3', [new Date(Date.now() + hrs * H), new Date(Date.now() + hrs * H + 1800000), id]);
  await setStart(b1.bookingId, 48); await setStart(b2.bookingId, 2); await setStart(b3.bookingId, 2);
  const c1 = await request(ctx.app, 'POST', `/api/consultations/${b1.bookingId}/cancel`, { token: early.token });
  assert.deepEqual([c1.status, c1.body.refundCents, c1.body.withheldCents], [200, 3854, 146]);
  const c2 = await request(ctx.app, 'POST', `/api/consultations/${b2.bookingId}/cancel`, { token: late.token });
  assert.deepEqual([c2.status, c2.body.refundCents], [200, 0]);
  const c3 = await request(ctx.app, 'POST', `/api/consultations/${b3.bookingId}/cancel`, { token: prac.token });
  assert.deepEqual([c3.status, c3.body.refundCents], [200, 4000]);
  const refunds = ctx.fake._calls.filter((c) => c.resource === 'refunds');
  assert.equal(refunds.length, 2, 'the inside-24h cancellation issued no refund');
  assert.equal(refunds[0].args[0].amount, 3854, 'subscriber\'s early cancellation: payment minus the 146-cent processing fee'); assert.equal(refunds[0].args[0].payment_intent, 'pi_test_1'); assert.equal(refunds[1].args[0].amount, 4000, 'a practitioner cancellation refunds everything');
  for (const id of [b1.bookingId, b2.bookingId, b3.bookingId]) { const r = await row(ctx, id); assert.equal(r.status, 'cancelled'); assert.equal(r.slot_key, null); }
  assert.equal((await row(ctx, b2.bookingId)).refund_cents, 0);
});

test('nobody can cancel once the session has started; cancelling an unpaid hold just frees it', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber'); const sub2 = await register(ctx, 'subscriber');
  const b = await paidBooking(ctx, sub, prac, 0);
  await ctx.pool.query('UPDATE consultation_bookings SET starts_at = $1, ends_at = $2 WHERE id = $3', [new Date(Date.now() - 600000), new Date(Date.now() + 1200000), b.bookingId]);
  assert.equal((await request(ctx.app, 'POST', `/api/consultations/${b.bookingId}/cancel`, { token: sub.token })).status, 409);
  const when = await slot(ctx, prac.id); const held = await bookIt(ctx, sub2, prac.id, when);
  const c = await request(ctx.app, 'POST', `/api/consultations/${held.body.bookingId}/cancel`, { token: sub2.token });
  assert.deepEqual([c.status, c.body.refundCents], [200, 0]); assert.equal(await slot(ctx, prac.id), when);
});

test('a late payment after the hold lapsed: confirmed if the slot is still free, automatically refunded if someone else took it', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx);
  const a = await register(ctx, 'subscriber'); const b = await register(ctx, 'subscriber');
  const w0 = await slot(ctx, prac.id, 0); const r0 = await bookIt(ctx, a, prac.id, w0);
  await ctx.pool.query('UPDATE consultation_bookings SET hold_expires_at = $1 WHERE id = $2', [new Date(Date.now() - 60000), r0.body.bookingId]);
  await ctx.jobs.runConsultationJobs(Date.now());
  assert.equal((await pay(ctx, r0.body.bookingId)).status, 200);
  assert.equal((await row(ctx, r0.body.bookingId)).status, 'confirmed', 'slot was free, so the late payment still books it');

  const w1 = await slot(ctx, prac.id, 0); const r1 = await bookIt(ctx, a, prac.id, w1);
  await ctx.pool.query('UPDATE consultation_bookings SET hold_expires_at = $1 WHERE id = $2', [new Date(Date.now() - 60000), r1.body.bookingId]);
  await ctx.jobs.runConsultationJobs(Date.now());
  const taken = await bookIt(ctx, b, prac.id, w1); assert.equal(taken.status, 201);
  const before = ctx.mailer.outbox.length;
  assert.equal((await pay(ctx, r1.body.bookingId)).status, 200);
  const lost = await row(ctx, r1.body.bookingId);
  assert.equal(lost.status, 'cancelled'); assert.equal(lost.refund_cents, 4000);
  assert.ok(ctx.fake._calls.some((c) => c.resource === 'refunds' && c.args[0].metadata.reason === 'slot_taken_after_hold_expired'));
  assert.ok(ctx.mailer.outbox.length > before, 'the subscriber is told');
  assert.equal((await row(ctx, taken.body.bookingId)).status, 'held', 'the other subscriber\'s hold is untouched');
});

test('release: nothing before the window; then exactly one transfer of the share minus Stripe\'s fee; never twice', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const b = await paidBooking(ctx, sub, prac, 0);
  assert.equal((await ctx.jobs.runConsultationJobs(Date.now())).released, 0, 'too early');
  const future = Date.now() + 60 * 24 * H;
  const first = await ctx.jobs.runConsultationJobs(future); assert.equal(first.released, 1); assert.deepEqual(first.failures, []);
  const transfers = ctx.fake._calls.filter((c) => c.resource === 'transfers');
  assert.equal(transfers.length, 1);
  const [params, opts] = transfers[0].args;
  assert.equal(params.amount, 2854); assert.equal(params.currency, 'usd'); assert.equal(params.destination, 'acct_test_1');
  assert.equal(params.source_transaction, 'ch_test_1'); assert.equal(params.transfer_group, b.bookingId);
  assert.equal(opts.idempotencyKey, `aidh-booking-${b.bookingId}-release`);
  const r = await row(ctx, b.bookingId);
  assert.equal(r.status, 'completed'); assert.equal(r.stripe_transfer_id, 'tr_test_1'); assert.ok(r.released_at);
  assert.equal((await ctx.jobs.runConsultationJobs(future)).released, 0);
  assert.equal(ctx.fake._calls.filter((c) => c.resource === 'transfers').length, 1, 'never paid twice');
});

test('a problem reported by the subscriber blocks the release; an admin then refunds or releases', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx);
  const s1 = await register(ctx, 'subscriber'); const s2 = await register(ctx, 'subscriber');
  const b1 = await paidBooking(ctx, s1, prac, 0); const b2 = await paidBooking(ctx, s2, prac, 1);
  assert.equal((await request(ctx.app, 'POST', `/api/consultations/${b1.bookingId}/report-issue`, { token: s1.token })).status, 409, 'the owner cannot report before the session starts');
  assert.equal((await request(ctx.app, 'POST', `/api/consultations/${b2.bookingId}/report-issue`, { token: s1.token })).status, 404, 'and nobody can report someone else\'s booking');
  for (const [id, who] of [[b1.bookingId, s1], [b2.bookingId, s2]]) {
    await ctx.pool.query('UPDATE consultation_bookings SET starts_at = $1, ends_at = $2, release_after = $3 WHERE id = $4', [new Date(Date.now() - 2 * H), new Date(Date.now() - 1.5 * H), new Date(Date.now() + 22 * H), id]);
    assert.equal((await request(ctx.app, 'POST', `/api/consultations/${id}/report-issue`, { token: who.token })).body.status, 'disputed');
  }
  assert.equal((await ctx.jobs.runConsultationJobs(Date.now() + 60 * 24 * H)).released, 0, 'disputed bookings are never released automatically');
  // admin: register a user, promote them, and sign in again so the token carries the admin role
  const adm = await register(ctx, 'subscriber'); const u = await ctx.pool.query('SELECT id FROM users WHERE email = $1', [adm.email]);
  await ctx.pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [u.rows[0].id]);
  const si = await request(ctx.app, 'POST', '/api/auth/signin', { body: { email: adm.email, password: 'correct-horse-battery-9' } });
  const admin = si.body.token;
  assert.equal((await request(ctx.app, 'POST', `/api/consultations/admin/${b1.bookingId}/resolve`, { token: s1.token, body: { action: 'refund' } })).status, 403);
  assert.equal((await request(ctx.app, 'POST', `/api/consultations/admin/${b1.bookingId}/resolve`, { token: admin, body: { action: 'refund' } })).status, 200);
  assert.equal((await row(ctx, b1.bookingId)).status, 'cancelled');
  assert.equal((await request(ctx.app, 'POST', `/api/consultations/admin/${b2.bookingId}/resolve`, { token: admin, body: { action: 'release' } })).status, 200);
  const out = await ctx.jobs.runConsultationJobs(Date.now() + 1000);
  assert.equal(out.released, 1, 'only the one resolved in the practitioner\'s favour is paid');
  assert.equal((await row(ctx, b1.bookingId)).released_at, null);
  assert.ok((await row(ctx, b2.bookingId)).released_at);
});

test('role checks and ownership: nobody can act on a booking, or an endpoint, that is not theirs', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const other = await register(ctx, 'practitioner');
  const sub = await register(ctx, 'subscriber'); const stranger = await register(ctx, 'subscriber');
  const b = await paidBooking(ctx, sub, prac, 0);
  assert.equal((await request(ctx.app, 'POST', `/api/consultations/${b.bookingId}/cancel`, { token: stranger.token })).status, 404);
  assert.equal((await request(ctx.app, 'POST', `/api/consultations/${b.bookingId}/cancel`, { token: other.token })).status, 404);
  assert.equal((await request(ctx.app, 'POST', `/api/consultations/${b.bookingId}/complete`, { token: other.token })).status, 404);
  assert.equal((await request(ctx.app, 'GET', '/api/consultations/settings', { token: sub.token })).status, 403);
  assert.equal((await request(ctx.app, 'POST', '/api/consultations/book', { token: prac.token, body: { practitionerId: prac.id, startsAt: new Date().toISOString() } })).status, 403);
  assert.equal((await request(ctx.app, 'POST', '/api/consultations/book', { body: {} })).status, 401);
  assert.equal((await request(ctx.app, 'GET', '/api/consultations/not-a-uuid', { token: sub.token })).status, 404);
});

test('a practitioner can mark a booking complete only once it has ended', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const b = await paidBooking(ctx, sub, prac, 0);
  assert.equal((await request(ctx.app, 'POST', `/api/consultations/${b.bookingId}/complete`, { token: prac.token })).status, 409);
  await ctx.pool.query('UPDATE consultation_bookings SET starts_at = $1, ends_at = $2 WHERE id = $3', [new Date(Date.now() - 2 * H), new Date(Date.now() - 1 * H), b.bookingId]);
  assert.equal((await request(ctx.app, 'POST', `/api/consultations/${b.bookingId}/complete`, { token: prac.token })).body.status, 'completed');
});

test('account deletion is refused while a consultation\'s money is in flight, and allowed once it is refunded', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const b = await paidBooking(ctx, sub, prac, 0);
  const refused = await request(ctx.app, 'DELETE', '/api/subscriber/me', { token: sub.token });
  assert.equal(refused.status, 409); assert.equal(refused.body.code, 'OPEN_CONSULTATIONS');
  await ctx.pool.query('UPDATE consultation_bookings SET starts_at = $1, ends_at = $2 WHERE id = $3', [new Date(Date.now() + 72 * H), new Date(Date.now() + 72 * H + 1800000), b.bookingId]);
  assert.equal((await request(ctx.app, 'POST', `/api/consultations/${b.bookingId}/cancel`, { token: sub.token })).body.refundCents, 3854);
  assert.equal((await request(ctx.app, 'DELETE', '/api/subscriber/me', { token: sub.token })).status, 200);
});

test('the practitioner sees the booked subscriber\'s email only for a paid booking, and can withhold it by configuration', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const r = await bookIt(ctx, sub, prac.id, await slot(ctx, prac.id));
  assert.equal(JSON.stringify((await request(ctx.app, 'GET', '/api/consultations/practitioner/bookings', { token: prac.token })).body).includes(sub.email), false, 'unpaid hold: nothing shown');
  await pay(ctx, r.body.bookingId);
  assert.ok(JSON.stringify((await request(ctx.app, 'GET', '/api/consultations/practitioner/bookings', { token: prac.token })).body).includes(sub.email));
  process.env.SHARE_SUBSCRIBER_EMAIL = 'false';
  try { assert.equal(JSON.stringify((await request(ctx.app, 'GET', '/api/consultations/practitioner/bookings', { token: prac.token })).body).includes(sub.email), false); }
  finally { delete process.env.SHARE_SUBSCRIBER_EMAIL; }
});

test('booking never records anything about health: the table has no such column', async () => {
  const ctx = freshApp();
  const cols = await ctx.pool.query(`SELECT * FROM consultation_bookings LIMIT 0`);
  const names = cols.fields.map((f) => f.name).join(',');
  assert.doesNotMatch(names, /note|health|symptom|diagnos|medication|slider|score/i);
});
