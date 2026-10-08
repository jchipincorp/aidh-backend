// src/lib/consultationLogic.js
//
// Pure functions (no database, no Stripe, no clock of their own) for the consultation
// booking flow, kept separate so the money maths, the cancellation policy, the link rules
// and the time-zone slot generation can each be tested directly.

const PLATFORM_FEE_RATE = 0.25;

/** AIDH keeps 25% of the gross; the practitioner's share is the rest. Rounded once, on the
 *  platform side, so the two always add back up to exactly the amount charged. */
function splitAmount(amountCents) {
  const platformFeeCents = Math.round(amountCents * PLATFORM_FEE_RATE);
  return { platformFeeCents, practitionerShareCents: amountCents - platformFeeCents };
}

/** Stripe's processing fee comes out of the PRACTITIONER'S share (product decision), so
 *  AIDH's 25% of the gross is never reduced by it. Never negative. */
function practitionerPayout(shareCents, stripeFeeCents) {
  return Math.max(0, shareCents - (stripeFeeCents || 0));
}

/** What a subscriber gets back for an early cancellation: their payment minus the card-processing fee
 *  Stripe charged and does not return. Never negative. (Practitioner and system cancellations refund
 *  the full amount; this is only for the subscriber's own early cancellation.) */
function refundAfterFee(amountCents, stripeFeeCents) {
  return Math.max(0, amountCents - (stripeFeeCents || 0));
}

/** Cancellation policy. Practitioner or system cancellations always refund in full. A
 *  subscriber gets a full refund when cancelling at least `freeHours` before the start, and
 *  no refund after that (the practitioner still receives their share: the slot was held for
 *  this subscriber). Nobody can cancel once the session has started. */
function cancellationOutcome({ by, nowMs, startsAtMs, freeHours }) {
  if (nowMs >= startsAtMs) return { allowed: false, reason: 'started' };
  if (by === 'practitioner' || by === 'system') return { allowed: true, refundFull: true };
  const hoursBefore = (startsAtMs - nowMs) / 3600000;
  return { allowed: true, refundFull: hoursBefore >= freeHours };
}

/** The practitioner's standing video room. https only, no embedded credentials, a real
 *  hostname (not an IP or localhost). Any provider is fine: Meet, Zoom, Teams, etc. */
function isValidVideoLink(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > 300) return false;
  let u;
  try { u = new URL(raw.trim()); } catch (e) { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h === 'localhost' || h.includes(':') || /^[0-9.]+$/.test(h)) return false;
  return true;
}

/** A headshot must be a real JPEG, and leaves with no hidden data. Walks the JPEG's segments and drops
 *  EXIF/XMP (APP1), ICC (APP2), APP12, IPTC (APP13) and comment segments, keeping everything needed to
 *  display it. Returns a clean Buffer, or null if the bytes are not a well-formed JPEG. */
function sanitizeJpeg(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) return null;
  const DROP = new Set([0xE1, 0xE2, 0xEC, 0xED, 0xFE]);
  const out = [buf.slice(0, 2)];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xFF) return null;
    while (buf[i] === 0xFF) i++;
    const marker = buf[i]; i++;
    if (marker === 0xD9) { out.push(Buffer.from([0xFF, 0xD9])); return Buffer.concat(out); }
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { out.push(Buffer.from([0xFF, marker])); continue; }
    if (i + 2 > buf.length) return null;
    const len = buf.readUInt16BE(i);
    if (len < 2 || i + len > buf.length) return null;
    const seg = buf.slice(i - 2, i + len);
    if (marker === 0xDA) {
      out.push(seg, buf.slice(i + len));
      const res = Buffer.concat(out);
      return res.length > 4 && res[res.length - 2] === 0xFF && res[res.length - 1] === 0xD9 ? res : null;
    }
    if (!DROP.has(marker)) out.push(seg);
    i += len;
  }
  return null;
}

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

function partsIn(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  dtf.formatToParts(new Date(utcMs)).forEach((x) => { if (x.type !== 'literal') p[x.type] = parseInt(x.value, 10); });
  return p;
}

/** local - UTC, in ms, for the given instant in the given zone. */
function tzOffsetMs(utcMs, tz) {
  const p = partsIn(utcMs, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

/** The UTC instant at which the wall clock in `tz` reads y-mo-d and `minuteOfDay`. Two passes
 *  so the offset is taken at the right side of a daylight-saving change. */
function zonedLocalToUtcMs(y, mo, d, minuteOfDay, tz) {
  const naive = Date.UTC(y, mo - 1, d, Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0);
  let guess = naive - tzOffsetMs(naive, tz);
  guess = naive - tzOffsetMs(guess, tz);
  return guess;
}

/** Bookable start times (UTC ms, ascending) from a weekly schedule. `windows` are in the
 *  practitioner's own timezone; `busy` is a Set of start times (UTC ms) already held or booked. */
function generateSlots({ windows, timezone, sessionMinutes, nowMs, leadHours = 12, horizonDays = 30, busy = new Set() }) {
  const earliest = nowMs + leadHours * 3600000;
  const latest = nowMs + horizonDays * 86400000;
  const localDates = new Map();
  for (let i = -1; i <= horizonDays + 1; i++) {
    const p = partsIn(nowMs + i * 86400000, timezone);
    localDates.set(`${p.year}-${p.month}-${p.day}`, p);
  }
  const out = new Set();
  for (const p of localDates.values()) {
    const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    for (const w of windows) {
      if (w.weekday !== weekday) continue;
      for (let s = w.start_minute; s + sessionMinutes <= w.end_minute; s += sessionMinutes) {
        const ms = zonedLocalToUtcMs(p.year, p.month, p.day, s, timezone);
        if (ms >= earliest && ms <= latest && !busy.has(ms)) out.add(ms);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

module.exports = {
  PLATFORM_FEE_RATE, splitAmount, practitionerPayout, refundAfterFee, cancellationOutcome,
  isValidVideoLink, isValidTimezone, sanitizeJpeg, zonedLocalToUtcMs, generateSlots,
};
