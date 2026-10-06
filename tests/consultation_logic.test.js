// tests/consultation_logic.test.js -- the money, policy, link and time-zone rules, tested directly.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/lib/consultationLogic');

test('AIDH keeps 25% of the gross and the two parts always add back to the amount charged', () => {
  for (const amt of [100, 999, 2000, 4000, 4001, 12345]) {
    const s = L.splitAmount(amt);
    assert.equal(s.platformFeeCents + s.practitionerShareCents, amt);
    assert.equal(s.platformFeeCents, Math.round(amt * 0.25));
  }
  assert.deepEqual(L.splitAmount(4000), { platformFeeCents: 1000, practitionerShareCents: 3000 });
});

test("Stripe's fee comes out of the practitioner's share only, never below zero", () => {
  assert.equal(L.practitionerPayout(3000, 146), 2854);
  assert.equal(L.practitionerPayout(3000, null), 3000);
  assert.equal(L.practitionerPayout(50, 146), 0);
});

test('cancellation policy: free until 24h before, none after, always full for practitioner/system, never after start', () => {
  const start = Date.UTC(2026, 9, 10, 12, 0);
  const H = 3600000;
  assert.deepEqual(L.cancellationOutcome({ by: 'subscriber', nowMs: start - 48 * H, startsAtMs: start, freeHours: 24 }), { allowed: true, refundFull: true });
  assert.deepEqual(L.cancellationOutcome({ by: 'subscriber', nowMs: start - 24 * H, startsAtMs: start, freeHours: 24 }), { allowed: true, refundFull: true });
  assert.deepEqual(L.cancellationOutcome({ by: 'subscriber', nowMs: start - 2 * H, startsAtMs: start, freeHours: 24 }), { allowed: true, refundFull: false });
  assert.deepEqual(L.cancellationOutcome({ by: 'practitioner', nowMs: start - 1 * H, startsAtMs: start, freeHours: 24 }), { allowed: true, refundFull: true });
  assert.equal(L.cancellationOutcome({ by: 'subscriber', nowMs: start + 1, startsAtMs: start, freeHours: 24 }).allowed, false);
});

test('video link rules: https only, no credentials, real hostname, any provider', () => {
  assert.equal(L.isValidVideoLink('https://meet.google.com/abc-defg-hij'), true);
  assert.equal(L.isValidVideoLink('https://us02web.zoom.us/j/123456789?pwd=x'), true);
  for (const bad of ['http://meet.google.com/abc', 'javascript:alert(1)', 'https://user:pw@meet.google.com/x', 'https://localhost/x', 'https://10.0.0.5/x', 'https://[::1]/x', 'ftp://meet.google.com/x', '', '   ', 'meet.google.com/abc', 'https://nodot/x', 'https://' + 'a'.repeat(300) + '.com'])
    assert.equal(L.isValidVideoLink(bad), false, 'should reject: ' + bad);
  assert.equal(L.isValidVideoLink(null), false);
});

test('timezones are validated', () => {
  assert.equal(L.isValidTimezone('Asia/Kolkata'), true);
  assert.equal(L.isValidTimezone('America/Los_Angeles'), true);
  assert.equal(L.isValidTimezone('Not/AZone'), false);
  assert.equal(L.isValidTimezone(''), false);
});

test('local wall-clock time converts to the right UTC instant, including across daylight saving', () => {
  assert.equal(L.zonedLocalToUtcMs(2026, 10, 5, 600, 'Asia/Kolkata'), Date.UTC(2026, 9, 5, 4, 30), 'Mon 10:00 IST = 04:30Z');
  assert.equal(L.zonedLocalToUtcMs(2026, 10, 5, 540, 'America/Los_Angeles'), Date.UTC(2026, 9, 5, 16, 0), 'Mon 09:00 PDT (UTC-7) = 16:00Z');
  assert.equal(L.zonedLocalToUtcMs(2026, 11, 2, 540, 'America/Los_Angeles'), Date.UTC(2026, 10, 2, 17, 0), 'Mon 09:00 PST (UTC-8, after the Nov 1 change) = 17:00Z');
});

test('slots follow the practitioner\'s own timezone, step by session length, and respect lead time and busy slots', () => {
  const windows = [{ weekday: 1, start_minute: 600, end_minute: 720 }]; // Mondays 10:00-12:00 local
  const now = Date.UTC(2026, 9, 3, 0, 0); // Sat 3 Oct 2026
  const slots = L.generateSlots({ windows, timezone: 'Asia/Kolkata', sessionMinutes: 30, nowMs: now, leadHours: 12, horizonDays: 10 });
  assert.equal(slots.length, 8, 'two Mondays x four half-hour slots');
  assert.equal(slots[0], Date.UTC(2026, 9, 5, 4, 30));
  assert.equal(slots[3], Date.UTC(2026, 9, 5, 6, 0));
  assert.equal(slots[4], Date.UTC(2026, 9, 12, 4, 30));
  const busy = L.generateSlots({ windows, timezone: 'Asia/Kolkata', sessionMinutes: 30, nowMs: now, leadHours: 12, horizonDays: 10, busy: new Set([slots[0]]) });
  assert.equal(busy.length, 7); assert.ok(!busy.includes(slots[0]));
  const nearNow = L.generateSlots({ windows, timezone: 'Asia/Kolkata', sessionMinutes: 30, nowMs: Date.UTC(2026, 9, 5, 4, 0), leadHours: 12, horizonDays: 10 });
  assert.ok(nearNow.every((s) => s >= Date.UTC(2026, 9, 5, 16, 0)), 'nothing inside the 12h lead time');
  const sixty = L.generateSlots({ windows, timezone: 'Asia/Kolkata', sessionMinutes: 60, nowMs: now, leadHours: 12, horizonDays: 10 });
  assert.equal(sixty.length, 4);
});

test('the practitioner\'s Monday starts at the right UTC moment (Sunday evening UTC for a +5:30 zone)', () => {
  const windows = [{ weekday: 1, start_minute: 600, end_minute: 660 }];
  const slots = L.generateSlots({ windows, timezone: 'Asia/Kolkata', sessionMinutes: 30, nowMs: Date.UTC(2026, 9, 4, 19, 0), leadHours: 0, horizonDays: 2 });
  assert.equal(slots[0], Date.UTC(2026, 9, 5, 4, 30));
});
