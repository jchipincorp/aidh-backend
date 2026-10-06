// tests/consultations_directory.test.js
// The fee-deducting refund, the public directory (consent, name, credentials, location, headshot),
// the terms and quote endpoints.
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshApp, request, rawGet, register, bookablePractitioner, slot, bookIt, pay, paidBooking, row, H } = require('./consultation_helpers');
const L = require('../src/lib/consultationLogic');

const TINY = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCaiiiuU+NP/9k=', 'base64');
const EXIF = Buffer.concat([Buffer.from([0xFF, 0xE1, 0x00, 0x0E]), Buffer.from('Exif\0\0GPSDAT')]);
const withExif = () => Buffer.concat([TINY.slice(0, 2), EXIF, TINY.slice(2)]);
const setStart = (ctx, id, hrs) => ctx.pool.query('UPDATE consultation_bookings SET starts_at = $1, ends_at = $2 WHERE id = $3', [new Date(Date.now() + hrs * H), new Date(Date.now() + hrs * H + 1800000), id]);

// ---------------- refunds minus the processing fee ----------------
test('the refund preview tells each person what cancelling now would do', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const b = await paidBooking(ctx, sub, prac, 0);
  await setStart(ctx, b.bookingId, 72);
  const s = (await request(ctx.app, 'GET', `/api/consultations/${b.bookingId}`, { token: sub.token })).body;
  assert.deepEqual(s.cancellation, { canCancel: true, refund: { type: 'full_minus_fee', amountCents: 3854, withheldCents: 146 } });
  const p = (await request(ctx.app, 'GET', `/api/consultations/${b.bookingId}`, { token: prac.token })).body;
  assert.deepEqual(p.cancellation, { canCancel: true, refund: { type: 'full', amountCents: 4000, withheldCents: 0 } });
  await setStart(ctx, b.bookingId, 2);
  assert.equal((await request(ctx.app, 'GET', `/api/consultations/${b.bookingId}`, { token: sub.token })).body.cancellation.refund.type, 'none');
  await setStart(ctx, b.bookingId, -1);
  assert.deepEqual((await request(ctx.app, 'GET', `/api/consultations/${b.bookingId}`, { token: sub.token })).body.cancellation, { canCancel: false, refund: null });
});

test('the cancellation email states the refund and the fee withheld', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const b = await paidBooking(ctx, sub, prac, 0); await setStart(ctx, b.bookingId, 72); ctx.mailer.outbox.length = 0;
  await request(ctx.app, 'POST', `/api/consultations/${b.bookingId}/cancel`, { token: sub.token });
  const mail = ctx.mailer.outbox.find((m) => m.to === sub.email).text;
  assert.match(mail, /38\.54 USD/); assert.match(mail, /1\.46 USD/); assert.match(mail, /less/);
});

test('CONSULTATION_REFUND_DEDUCTS_FEE=false switches back to a full refund', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const b = await paidBooking(ctx, sub, prac, 0); await setStart(ctx, b.bookingId, 72);
  process.env.CONSULTATION_REFUND_DEDUCTS_FEE = 'false';
  try {
    assert.equal((await request(ctx.app, 'GET', `/api/consultations/${b.bookingId}`, { token: sub.token })).body.cancellation.refund.type, 'full');
    const c = await request(ctx.app, 'POST', `/api/consultations/${b.bookingId}/cancel`, { token: sub.token });
    assert.deepEqual([c.body.refundCents, c.body.withheldCents], [4000, 0]);
  } finally { delete process.env.CONSULTATION_REFUND_DEDUCTS_FEE; }
});

test('if Stripe could not report the fee at confirmation, it is fetched at cancellation and stored', async () => {
  let calls = 0;
  const ctx = freshApp({ 'paymentIntents.retrieve': () => { calls += 1; return calls === 1 ? { id: 'pi', latest_charge: { id: 'ch_late' } } : { id: 'pi', latest_charge: { id: 'ch_late', balance_transaction: { fee: 146 } } }; } });
  const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const b = await paidBooking(ctx, sub, prac, 0); await setStart(ctx, b.bookingId, 72);
  assert.equal((await row(ctx, b.bookingId)).stripe_fee_cents, null);
  const c = await request(ctx.app, 'POST', `/api/consultations/${b.bookingId}/cancel`, { token: sub.token });
  assert.deepEqual([c.status, c.body.refundCents], [200, 3854]);
  assert.equal((await row(ctx, b.bookingId)).stripe_fee_cents, 146);
});

test('if Stripe cannot say what the fee was, nothing is cancelled and no refund is attempted', async () => {
  const ctx = freshApp({ 'paymentIntents.retrieve': () => ({ id: 'pi', latest_charge: { id: 'ch_x' } }) });
  const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const b = await paidBooking(ctx, sub, prac, 0); await setStart(ctx, b.bookingId, 72);
  const c = await request(ctx.app, 'POST', `/api/consultations/${b.bookingId}/cancel`, { token: sub.token });
  assert.equal(c.status, 502);
  assert.equal((await row(ctx, b.bookingId)).status, 'confirmed');
  assert.equal(ctx.fake._calls.filter((x) => x.resource === 'refunds').length, 0);
  // the practitioner can still cancel: that refunds everything and needs no fee
  assert.equal((await request(ctx.app, 'POST', `/api/consultations/${b.bookingId}/cancel`, { token: prac.token })).body.refundCents, 4000);
});


test('the practitioner\'s list says whether a cancellation was refunded, so a late cancellation still shows their share', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const a = await register(ctx, 'subscriber'); const b = await register(ctx, 'subscriber');
  const early = await paidBooking(ctx, a, prac, 0); const late = await paidBooking(ctx, b, prac, 1);
  await setStart(ctx, early.bookingId, 72); await setStart(ctx, late.bookingId, 2);
  await request(ctx.app, 'POST', `/api/consultations/${early.bookingId}/cancel`, { token: a.token });
  await request(ctx.app, 'POST', `/api/consultations/${late.bookingId}/cancel`, { token: b.token });
  const list = (await request(ctx.app, 'GET', '/api/consultations/practitioner/bookings', { token: prac.token })).body.bookings;
  const e = list.find((x) => x.id === early.bookingId), l = list.find((x) => x.id === late.bookingId);
  assert.deepEqual([e.status, e.refundCents], ['cancelled', 3854]);
  assert.deepEqual([l.status, l.refundCents, l.yourShareCents, l.payoutCents], ['cancelled', 0, 3000, 2854], 'no refund: the practitioner is still owed their share, less the fee');
});

// ---------------- the public directory ----------------
test('only practitioners who consent (and have a name) are listed, with name, credentials and location', async () => {
  const ctx = freshApp();
  const a = await bookablePractitioner(ctx, { first: 'Asha', last: 'Rao' });
  const b = await bookablePractitioner(ctx, { first: 'Ben', last: 'Cole', consent: false });
  let list = (await request(ctx.app, 'GET', '/api/consultations/practitioners')).body.practitioners;
  assert.deepEqual(list.map((x) => x.id), [a.id], 'the practitioner who did not consent is not listed');
  assert.equal(list[0].displayName, 'Asha Rao'); assert.match(list[0].credentials, /ND, 8 years in practice/); assert.equal(list[0].location, 'Pune, India'); assert.equal(list[0].photoPath, null);
  assert.equal((await request(ctx.app, 'GET', `/api/consultations/practitioners/${b.id}/slots`)).status, 409, 'and cannot be booked');
  assert.ok((await request(ctx.app, 'GET', '/api/consultations/settings', { token: b.token })).body.notBookableBecause.includes('no_directory_consent'));
  // withdrawing consent removes the listing; agreeing again restores it
  await request(ctx.app, 'PUT', '/api/consultations/settings', { token: a.token, body: { directoryConsent: false } });
  assert.deepEqual((await request(ctx.app, 'GET', '/api/consultations/practitioners')).body.practitioners, []);
  await request(ctx.app, 'PUT', '/api/consultations/settings', { token: a.token, body: { directoryConsent: true } });
  assert.equal((await request(ctx.app, 'GET', '/api/consultations/practitioners')).body.practitioners.length, 1);
  // no name, no listing
  await ctx.pool.query('UPDATE practitioner_profiles SET first_name = NULL WHERE id = $1', [a.id]);
  assert.deepEqual((await request(ctx.app, 'GET', '/api/consultations/practitioners')).body.practitioners, []);
  assert.ok((await request(ctx.app, 'GET', '/api/consultations/settings', { token: a.token })).body.notBookableBecause.includes('profile_incomplete'));
  assert.equal((await request(ctx.app, 'PUT', '/api/consultations/settings', { token: a.token, body: { directoryConsent: 'yes' } })).status, 400);
});

test('headshots: only real JPEGs, stripped of hidden data, served publicly only for a listed practitioner', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const put = (body, token = prac.token) => request(ctx.app, 'PUT', '/api/consultations/photo', { token, body });
  assert.equal((await put({ imageBase64: 'not base64!!' })).status, 400);
  assert.equal((await put({ imageBase64: Buffer.from('\x89PNG\r\n\x1a\n-not-a-jpeg-').toString('base64') })).status, 400, 'a PNG is refused');
  assert.equal((await put({ imageBase64: TINY.slice(0, TINY.length - 6).toString('base64') })).status, 400, 'a truncated JPEG is refused');
  assert.equal((await put({ imageBase64: Buffer.concat([TINY.slice(0, 2), Buffer.alloc(110000, 0x41)]).toString('base64') })).status, 400, 'over 100 KB is refused');
  assert.equal((await put({ imageBase64: TINY.toString('base64') }, sub.token)).status, 403, 'a subscriber cannot upload');
  assert.equal((await request(ctx.app, 'PUT', '/api/consultations/photo', { body: {} })).status, 401);
  const ok = await put({ imageBase64: withExif().toString('base64') });
  assert.equal(ok.status, 200);
  const mine = (await request(ctx.app, 'GET', '/api/consultations/photo/mine', { token: prac.token })).body;
  const stored = Buffer.from(mine.imageBase64, 'base64');
  assert.ok(!stored.includes(Buffer.from('Exif')) && !stored.includes(Buffer.from('GPSDAT')), 'EXIF is gone');
  assert.deepEqual([...stored.slice(0, 3)], [0xFF, 0xD8, 0xFF]);
  const pub = await rawGet(ctx.app, `/api/consultations/practitioners/${prac.id}/photo`);
  assert.equal(pub.status, 200); assert.equal(pub.headers['content-type'], 'image/jpeg'); assert.equal(pub.headers['x-content-type-options'], 'nosniff');
  assert.equal(pub.headers['cross-origin-resource-policy'], 'cross-origin'); assert.deepEqual([...pub.body.slice(0, 3)], [0xFF, 0xD8, 0xFF]);
  assert.match((await request(ctx.app, 'GET', '/api/consultations/practitioners')).body.practitioners[0].photoPath, /\/photo$/);
  // withdrawing consent stops the public photo; so does deleting it
  await request(ctx.app, 'PUT', '/api/consultations/settings', { token: prac.token, body: { directoryConsent: false } });
  assert.equal((await rawGet(ctx.app, `/api/consultations/practitioners/${prac.id}/photo`)).status, 404);
  await request(ctx.app, 'PUT', '/api/consultations/settings', { token: prac.token, body: { directoryConsent: true } });
  assert.equal((await rawGet(ctx.app, `/api/consultations/practitioners/${prac.id}/photo`)).status, 200);
  assert.equal((await request(ctx.app, 'DELETE', '/api/consultations/photo', { token: prac.token })).status, 200);
  assert.equal((await rawGet(ctx.app, `/api/consultations/practitioners/${prac.id}/photo`)).status, 404);
  assert.equal((await rawGet(ctx.app, '/api/consultations/practitioners/not-a-uuid/photo')).status, 404);
});

test('an unverified practitioner\'s photo is never public, even with consent', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx);
  await request(ctx.app, 'PUT', '/api/consultations/photo', { token: prac.token, body: { imageBase64: TINY.toString('base64') } });
  await ctx.pool.query(`UPDATE practitioner_profiles SET verification_status = 'pending' WHERE id = $1`, [prac.id]);
  assert.equal((await rawGet(ctx.app, `/api/consultations/practitioners/${prac.id}/photo`)).status, 404);
});

// ---------------- terms and quote ----------------
test('the terms endpoint reports the numbers the server really applies', async () => {
  const ctx = freshApp();
  const t = (await request(ctx.app, 'GET', '/api/consultations/terms')).body;
  assert.deepEqual([t.freeCancelHours, t.refundDeductsFee, t.releaseDelayHours, t.holdMinutes, t.shareSubscriberEmail], [24, true, 24, 15, true]);
});

test('the quote is the price this subscriber will pay: standard for free, Premium for paid plans', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx);
  const free = await register(ctx, 'subscriber'); const prem = await register(ctx, 'subscriber', 'monthly');
  const q = (who) => request(ctx.app, 'GET', `/api/consultations/quote/${prac.id}`, { token: who.token });
  assert.deepEqual([(await q(free)).body.amountCents, (await q(free)).body.priceBasis], [4000, 'standard']);
  assert.deepEqual([(await q(prem)).body.amountCents, (await q(prem)).body.priceBasis], [3000, 'premium']);
  assert.equal((await request(ctx.app, 'GET', `/api/consultations/quote/${prac.id}`, { token: prac.token })).status, 403);
  assert.equal((await request(ctx.app, 'GET', `/api/consultations/quote/${prac.id}`)).status, 401);
  assert.equal((await request(ctx.app, 'GET', '/api/consultations/quote/not-a-uuid', { token: free.token })).status, 404);
});

test('a booking shows the practitioner\'s name, and the confirmation email uses it', async () => {
  const ctx = freshApp(); const prac = await bookablePractitioner(ctx); const sub = await register(ctx, 'subscriber');
  const b = await paidBooking(ctx, sub, prac, 0);
  assert.equal((await request(ctx.app, 'GET', `/api/consultations/${b.bookingId}`, { token: sub.token })).body.practitioner.name, 'Asha Rao');
  const mail = ctx.mailer.outbox.find((m) => m.to === sub.email).text;
  assert.match(mail, /With: Asha Rao/); assert.match(mail, /refund of the consultation fee paid, less the third-party payment processing fee incurred/);
});

// ---------------- pure logic ----------------
test('refundAfterFee never goes negative', () => {
  assert.equal(L.refundAfterFee(4000, 146), 3854); assert.equal(L.refundAfterFee(4000, null), 4000); assert.equal(L.refundAfterFee(100, 146), 0);
});
test('sanitizeJpeg keeps a valid JPEG, drops EXIF, and rejects everything else', () => {
  const clean = L.sanitizeJpeg(TINY); assert.ok(clean && clean.length > 100);
  const stripped = L.sanitizeJpeg(withExif()); assert.ok(stripped && !stripped.includes(Buffer.from('Exif')));
  assert.equal(stripped.length, clean.length, 'stripping the EXIF segment gives the same bytes as the original');
  assert.equal(L.sanitizeJpeg(Buffer.from('hello world')), null);
  assert.equal(L.sanitizeJpeg(TINY.slice(0, 50)), null);
  assert.equal(L.sanitizeJpeg(TINY.slice(0, TINY.length - 2)), null, 'no end marker');
  assert.equal(L.sanitizeJpeg('nope'), null);
});
