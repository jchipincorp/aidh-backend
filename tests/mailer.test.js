// tests/mailer.test.js -- the Resend adapter, against a MOCKED network (this has not been run against
// Resend itself: that needs a Resend account, a verified sender domain and a key).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function load() { Object.keys(require.cache).forEach((k) => { if (k.includes('/src/lib/mailer')) delete require.cache[k]; }); return require('../src/lib/mailer'); }
async function withFetch(impl, fn) {
  const real = global.fetch; const calls = []; global.fetch = async (...a) => { calls.push(a); return impl(...a); };
  const errs = []; const realErr = console.error, realWarn = console.warn; console.error = (...a) => errs.push(a.join(' ')); console.warn = (...a) => errs.push(a.join(' '));
  try { await fn(calls, errs); } finally { global.fetch = real; console.error = realErr; console.warn = realWarn; }
}
const env = (o) => { for (const k of ['MAIL_PROVIDER', 'RESEND_API_KEY', 'MAIL_FROM']) delete process.env[k]; Object.assign(process.env, o); };

test('Resend: sends one authenticated request with from, to, subject and text', async () => {
  env({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key', MAIL_FROM: 'AIDH <bookings@aidynamichealth.com>' });
  await withFetch(async () => ({ ok: true, status: 200, text: async () => '{"id":"x"}' }), async (calls) => {
    const r = await load().sendMail({ to: 'sub@example.com', subject: 'Your consultation', text: 'Join: https://meet.google.com/abc' });
    assert.deepEqual(r, { ok: true, provider: 'resend' });
    assert.equal(calls.length, 1);
    const [url, opts] = calls[0];
    assert.equal(url, 'https://api.resend.com/emails'); assert.equal(opts.method, 'POST');
    assert.equal(opts.headers.Authorization, 'Bearer re_test_key'); assert.equal(opts.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(opts.body), { from: 'AIDH <bookings@aidynamichealth.com>', to: ['sub@example.com'], subject: 'Your consultation', text: 'Join: https://meet.google.com/abc' });
  });
});

test('Resend: a rejection is reported, never thrown, and the log holds no address or body', async () => {
  env({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key', MAIL_FROM: 'bookings@aidynamichealth.com' });
  await withFetch(async () => ({ ok: false, status: 422, text: async () => '{"message":"domain not verified"}' }), async (calls, errs) => {
    const r = await load().sendMail({ to: 'private.person@example.com', subject: 'S', text: 'secret link https://meet.google.com/zzz' });
    assert.deepEqual(r, { ok: false, reason: 'resend_422' });
    assert.ok(errs.some((e) => /422/.test(e)));
    assert.ok(!errs.join(' ').includes('private.person@example.com') && !errs.join(' ').includes('meet.google.com/zzz'), 'no recipient or body in the log');
  });
});

test('Resend: a network failure is reported, never thrown', async () => {
  env({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k', MAIL_FROM: 'a@b.co' });
  await withFetch(async () => { throw new Error('ECONNRESET'); }, async () => {
    assert.deepEqual(await load().sendMail({ to: 'x@y.co', subject: 's', text: 't' }), { ok: false, reason: 'resend_network_error' });
  });
});

test('Resend: missing key or sender sends nothing', async () => {
  env({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k' });
  await withFetch(async () => ({ ok: true, status: 200, text: async () => '' }), async (calls) => {
    assert.deepEqual(await load().sendMail({ to: 'x@y.co', subject: 's', text: 't' }), { ok: false, reason: 'resend_not_configured' });
    assert.equal(calls.length, 0);
  });
});

test('the other providers still behave: outbox keeps, unknown refuses', async () => {
  env({ MAIL_PROVIDER: 'outbox' }); let m = load();
  assert.equal((await m.sendMail({ to: 'a@b.co', subject: 's', text: 't' })).ok, true); assert.equal(m.outbox.length, 1);
  env({ MAIL_PROVIDER: 'carrier-pigeon' });
  await withFetch(async () => ({}), async () => { assert.deepEqual(await load().sendMail({ to: 'a@b.co', subject: 's', text: 't' }), { ok: false, reason: 'not_configured' }); });
  env({ MAIL_PROVIDER: 'outbox' });
});
