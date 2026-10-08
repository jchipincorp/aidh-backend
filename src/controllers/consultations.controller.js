// src/controllers/consultations.controller.js
//
// Instant-booking consultations. Flow (hold-and-release, decided with the product owner):
//   1. The subscriber picks a time from the practitioner's published availability.
//   2. The slot is HELD for a few minutes (a UNIQUE slot_key makes double-booking impossible)
//      and a Stripe Checkout session is created. The charge goes to AIDH, not the practitioner.
//   3. Stripe's webhook confirms the payment: the booking becomes CONFIRMED, and both people
//      are emailed. The page the subscriber lands on is NOT the source of truth.
//   4. The practitioner's standing video link is revealed only to the booked subscriber and
//      that practitioner, only once the booking is confirmed.
//   5. 24 hours after the session ends, unless the subscriber reported a problem, a job
//      releases the practitioner's share: 75% of the gross MINUS Stripe's processing fee.
//      AIDH's 25% of the gross is never reduced.
// Money, slot and cancellation rules live in lib/consultationLogic.js and are tested there.

const db = require('../config/db');
const stripe = require('../lib/stripeClient');
const { logAudit } = require('../lib/audit');
const { sendMail } = require('../lib/mailer');
const L = require('../lib/consultationLogic');
const E = require('../lib/consultationEmails');
const { DISPUTE_REASON_CODES, DISPUTE_REASONS } = require('../lib/disputeReasons');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const intEnv = (n, d) => parseInt(process.env[n] || String(d), 10);
const holdMinutes = () => intEnv('CONSULTATION_HOLD_MINUTES', 15);
const releaseDelayHours = () => intEnv('CONSULTATION_RELEASE_DELAY_HOURS', 24);
const freeCancelHours = () => intEnv('CONSULTATION_FREE_CANCEL_HOURS', 24);
const reconfirmDays = () => intEnv('CONSULTATION_LINK_RECONFIRM_DAYS', 90);
// The practitioner needs to recognise who is asking to join their room. Default: they see the
// booked subscriber's email for that booking only. Set SHARE_SUBSCRIBER_EMAIL=false to withhold.
const shareEmail = () => process.env.SHARE_SUBSCRIBER_EMAIL !== 'false';
const returnBase = () => process.env.CONSULTATION_RETURN_URL || 'http://localhost:4002/aidh_book.html';
const connectReturn = () => process.env.CONNECT_RETURN_URL || 'http://localhost:4002/aidh_practitioner_console.html';

const ref = (id) => String(id).slice(0, 8).toUpperCase();
const isUniqueViolation = (e) => !!e && (e.code === '23505' || /duplicate key|unique constraint/i.test(e.message || ''));
const paymentsNotConfigured = (res) => res.status(500).json({ error: 'Payments are not configured on this server yet.' });

const SETTINGS_COLS = `s.session_price_cents, s.premium_price_cents, s.currency, s.session_minutes, s.timezone, s.video_link,
  s.video_link_confirmed_at, s.host_admits_ack, s.accepting_bookings, s.stripe_account_id, s.stripe_payouts_enabled, s.stripe_details_submitted,
  s.directory_consent_at, s.agreement_version, s.agreement_accepted_at`;
const PROFILE_COLS = `p.id, p.user_id, p.practitioner_code, p.bio, p.verification_status, p.first_name, p.last_name, p.city, p.country,
  p.qualifications, p.registration_body`;
// The Practitioner Agreement version that counts as "accepted". 'DRAFT-1' is a clearly marked placeholder until
// counsel's final text exists. Changing it makes every practitioner accept again before they can be booked.
const agreementVersion = () => process.env.PRACTITIONER_AGREEMENT_VERSION || 'DRAFT-1';
const deductsFee = () => process.env.CONSULTATION_REFUND_DEDUCTS_FEE !== 'false';
const nameOf = (r) => [r.first_name, r.last_name].filter(Boolean).join(' ');
const credentialsOf = (r) => [r.qualifications ? String(r.qualifications).slice(0, 240) : '', r.registration_body ? `Registered with ${r.registration_body}` : ''].filter(Boolean).join(' \u00b7 ');
const locationOf = (r) => [r.city, r.country].filter(Boolean).join(', ');
const CB = `cb.id, cb.subscriber_id, cb.practitioner_id, cb.starts_at, cb.ends_at, cb.status, cb.amount_cents, cb.currency, cb.price_basis,
  cb.platform_fee_cents, cb.practitioner_share_cents, cb.stripe_fee_cents, cb.practitioner_payout_cents, cb.slot_key, cb.hold_expires_at,
  cb.stripe_checkout_session_id, cb.stripe_payment_intent_id, cb.stripe_charge_id, cb.stripe_transfer_id, cb.confirmed_at, cb.completed_at,
  cb.release_after, cb.released_at, cb.cancelled_at, cb.cancelled_by, cb.refund_cents, cb.issue_reported_at, cb.issue_resolved_at, cb.issue_reason`;

async function practitionerFor(userId) {
  const r = await db.query('SELECT id FROM practitioner_profiles WHERE user_id = $1', [userId]);
  return r.rows[0] || null;
}
async function subscriberFor(userId) {
  const r = await db.query('SELECT id, plan FROM subscriber_profiles WHERE user_id = $1', [userId]);
  return r.rows[0] || null;
}
async function loadPractitioner(practitionerId) {
  const r = await db.query(
    `SELECT ${PROFILE_COLS}, ${SETTINGS_COLS}
     FROM practitioner_profiles p LEFT JOIN practitioner_booking_settings s ON s.practitioner_id = p.id WHERE p.id = $1`, [practitionerId]);
  return r.rows[0] || null;
}

/** Why a practitioner cannot be booked right now. Empty list = bookable. */
function eligibility(row, nowMs) {
  const reasons = [];
  if (row.verification_status !== 'verified') reasons.push('not_verified');
  if (!row.first_name || !row.last_name) reasons.push('profile_incomplete');
  if (row.agreement_version !== agreementVersion()) reasons.push('agreement_not_accepted');
  if (!row.directory_consent_at) reasons.push('no_directory_consent');
  if (!row.accepting_bookings) reasons.push('not_accepting_bookings');
  if (!row.session_price_cents) reasons.push('no_price');
  if (!row.video_link || !row.host_admits_ack) reasons.push('no_video_link');
  else if (!row.video_link_confirmed_at || nowMs - new Date(row.video_link_confirmed_at).getTime() > reconfirmDays() * 86400000) reasons.push('video_link_needs_reconfirmation');
  if (!row.stripe_account_id || !row.stripe_payouts_enabled) reasons.push('payouts_not_ready');
  return reasons;
}

async function availableSlots(row, nowMs) {
  const w = await db.query('SELECT weekday, start_minute, end_minute FROM practitioner_availability WHERE practitioner_id = $1', [row.id]);
  // Derived from slot_key, the very value the database's UNIQUE guard uses, so the list of busy times
  // and the double-booking protection can never disagree ("<practitioner id>|<start ms>").
  const held = await db.query('SELECT slot_key FROM consultation_bookings WHERE practitioner_id = $1 AND slot_key IS NOT NULL', [row.id]);
  const busy = new Set(held.rows.map((r) => parseInt(String(r.slot_key).split('|')[1], 10)));
  return L.generateSlots({
    windows: w.rows, timezone: row.timezone, sessionMinutes: row.session_minutes, nowMs,
    leadHours: intEnv('CONSULTATION_LEAD_HOURS', 12), horizonDays: intEnv('CONSULTATION_HORIZON_DAYS', 30), busy,
  });
}

// ───────────────────────── practitioner: settings, availability, Connect ─────────────────────────

async function getSettings(req, res) {
  const p = await practitionerFor(req.user.sub);
  if (!p) return res.status(404).json({ error: 'No practitioner profile found' });
  const row = await loadPractitioner(p.id);
  const w = await db.query('SELECT weekday, start_minute, end_minute FROM practitioner_availability WHERE practitioner_id = $1', [p.id]);
  const photo = await db.query('SELECT 1 FROM practitioner_photos WHERE practitioner_id = $1', [p.id]);
  const reasons = eligibility(row, Date.now());
  const confirmedAt = row.video_link_confirmed_at ? new Date(row.video_link_confirmed_at).getTime() : null;
  return res.json({
    sessionPriceCents: row.session_price_cents, premiumPriceCents: row.premium_price_cents, currency: row.currency || 'usd',
    sessionMinutes: row.session_minutes || 30, timezone: row.timezone || 'UTC',
    videoLink: row.video_link, hostAdmitsAck: !!row.host_admits_ack, acceptingBookings: !!row.accepting_bookings,
    videoLinkReconfirmDueAt: confirmedAt ? new Date(confirmedAt + reconfirmDays() * 86400000).toISOString() : null,
    directoryConsent: !!row.directory_consent_at, hasPhoto: photo.rows.length > 0,
    agreement: {
      currentVersion: agreementVersion(), isDraft: /^DRAFT/i.test(agreementVersion()),
      acceptedVersion: row.agreement_version || null, acceptedAt: row.agreement_accepted_at ? new Date(row.agreement_accepted_at).toISOString() : null,
      accepted: row.agreement_version === agreementVersion(),
    },
    profilePreview: { displayName: nameOf(row), credentials: credentialsOf(row), location: locationOf(row) },
    availability: w.rows.map((x) => ({ weekday: x.weekday, startMinute: x.start_minute, endMinute: x.end_minute })),
    stripe: { accountCreated: !!row.stripe_account_id, payoutsEnabled: !!row.stripe_payouts_enabled, detailsSubmitted: !!row.stripe_details_submitted },
    bookable: reasons.length === 0, notBookableBecause: reasons,
  });
}

async function putSettings(req, res) {
  const p = await practitionerFor(req.user.sub);
  if (!p) return res.status(404).json({ error: 'No practitioner profile found' });
  const b = req.body || {};
  const existing = (await loadPractitioner(p.id)) || {};
  const set = {};
  const bad = (m) => res.status(400).json({ error: m });
  const okPrice = (v) => Number.isInteger(v) && v >= 100 && v <= 1000000;

  if ('sessionPriceCents' in b) { if (!okPrice(b.sessionPriceCents)) return bad('sessionPriceCents must be a whole number of cents between 100 and 1,000,000'); set.session_price_cents = b.sessionPriceCents; }
  if ('premiumPriceCents' in b) {
    if (b.premiumPriceCents === null) set.premium_price_cents = null;
    else { if (!okPrice(b.premiumPriceCents)) return bad('premiumPriceCents must be null or a whole number of cents between 100 and 1,000,000'); set.premium_price_cents = b.premiumPriceCents; }
  }
  const std = 'session_price_cents' in set ? set.session_price_cents : existing.session_price_cents;
  const prem = 'premium_price_cents' in set ? set.premium_price_cents : existing.premium_price_cents;
  if (prem != null && std != null && prem > std) return bad('The Premium price cannot be higher than the standard price');
  if ('sessionMinutes' in b) { if (!Number.isInteger(b.sessionMinutes) || b.sessionMinutes < 15 || b.sessionMinutes > 120 || b.sessionMinutes % 5 !== 0) return bad('sessionMinutes must be a multiple of 5 between 15 and 120'); set.session_minutes = b.sessionMinutes; }
  if ('timezone' in b) { if (!L.isValidTimezone(b.timezone)) return bad('timezone must be a valid IANA time zone, e.g. Asia/Kolkata'); set.timezone = b.timezone; }
  if ('acceptingBookings' in b) { if (typeof b.acceptingBookings !== 'boolean') return bad('acceptingBookings must be true or false'); set.accepting_bookings = b.acceptingBookings; }
  // Public directory: an explicit, timestamped agreement. No timestamp, no listing and no public photo.
  if ('directoryConsent' in b) {
    if (typeof b.directoryConsent !== 'boolean') return bad('directoryConsent must be true or false');
    set.directory_consent_at = b.directoryConsent ? (existing.directory_consent_at || new Date()) : null;
  }

  // Shared-link safeguards. Setting or changing the link requires the practitioner to confirm
  // they admit each person individually; that confirmation is timestamped and expires.
  if ('videoLink' in b) {
    if (b.videoLink === null) { set.video_link = null; set.host_admits_ack = false; set.video_link_confirmed_at = null; set.accepting_bookings = false; }
    else {
      if (!L.isValidVideoLink(b.videoLink)) return bad('videoLink must be a secure https link, e.g. your Google Meet or Zoom room');
      if (b.hostAdmitsAck !== true) return bad('Please confirm that you set your meeting so you admit each person individually (hostAdmitsAck: true)');
      set.video_link = b.videoLink.trim(); set.host_admits_ack = true; set.video_link_confirmed_at = new Date();
    }
  } else if (b.hostAdmitsAck === true && existing.video_link) {
    set.host_admits_ack = true; set.video_link_confirmed_at = new Date();   // re-confirmation of the same link
  }

  if (!existing.session_minutes && !('session_minutes' in set) && existing.video_link === undefined && existing.currency === undefined) {
    // no settings row yet (LEFT JOIN returned nulls) -- handled below by creating it
  }
  const has = await db.query('SELECT 1 FROM practitioner_booking_settings WHERE practitioner_id = $1', [p.id]);
  if (!has.rows.length) await db.query('INSERT INTO practitioner_booking_settings (practitioner_id) VALUES ($1)', [p.id]);
  const cols = Object.keys(set);
  if (cols.length) {
    const sets = cols.map((c, i) => `${c} = $${i + 2}`).concat('updated_at = now()');
    await db.query(`UPDATE practitioner_booking_settings SET ${sets.join(', ')} WHERE practitioner_id = $1`, [p.id, ...cols.map((c) => set[c])]);
  }
  await logAudit(db, { actorUserId: req.user.sub, actorType: 'practitioner', actionCategory: 'CONSULTATION', action: 'SETTINGS_UPDATED', description: `fields: ${cols.join(', ') || 'none'}` });
  return getSettings(req, res);
}

async function putAvailability(req, res) {
  const p = await practitionerFor(req.user.sub);
  if (!p) return res.status(404).json({ error: 'No practitioner profile found' });
  const windows = (req.body || {}).windows;
  if (!Array.isArray(windows) || windows.length > 40) return res.status(400).json({ error: 'windows must be a list of at most 40 entries' });
  for (const w of windows) {
    if (!w || !Number.isInteger(w.weekday) || w.weekday < 0 || w.weekday > 6 || !Number.isInteger(w.startMinute) || !Number.isInteger(w.endMinute)
        || w.startMinute < 0 || w.endMinute > 1440 || w.endMinute <= w.startMinute)
      return res.status(400).json({ error: 'Each window needs weekday 0-6, startMinute >= 0, endMinute <= 1440, and endMinute > startMinute' });
  }
  const has = await db.query('SELECT 1 FROM practitioner_booking_settings WHERE practitioner_id = $1', [p.id]);
  if (!has.rows.length) await db.query('INSERT INTO practitioner_booking_settings (practitioner_id) VALUES ($1)', [p.id]);
  await db.query('DELETE FROM practitioner_availability WHERE practitioner_id = $1', [p.id]);
  for (const w of windows)
    await db.query('INSERT INTO practitioner_availability (practitioner_id, weekday, start_minute, end_minute) VALUES ($1, $2, $3, $4)', [p.id, w.weekday, w.startMinute, w.endMinute]);
  return res.json({ saved: windows.length });
}

async function connectOnboard(req, res) {
  if (!process.env.STRIPE_SECRET_KEY) return paymentsNotConfigured(res);
  const p = await practitionerFor(req.user.sub);
  if (!p) return res.status(404).json({ error: 'No practitioner profile found' });
  const has = await db.query('SELECT stripe_account_id FROM practitioner_booking_settings WHERE practitioner_id = $1', [p.id]);
  if (!has.rows.length) await db.query('INSERT INTO practitioner_booking_settings (practitioner_id) VALUES ($1)', [p.id]);
  let accountId = has.rows[0] && has.rows[0].stripe_account_id;
  if (!accountId) {
    const u = await db.query('SELECT email FROM users WHERE id = $1', [req.user.sub]);
    // Express account: Stripe's own screens collect identity, bank and tax details. None of it touches AIDH.
    const acct = await stripe.accounts.create({ type: 'express', email: u.rows[0] && u.rows[0].email, capabilities: { transfers: { requested: true } }, metadata: { practitionerId: p.id } });
    accountId = acct.id;
    await db.query('UPDATE practitioner_booking_settings SET stripe_account_id = $2, updated_at = now() WHERE practitioner_id = $1', [p.id, accountId]);
  }
  const link = await stripe.accountLinks.create({ account: accountId, refresh_url: connectReturn() + '?connect=refresh', return_url: connectReturn() + '?connect=done', type: 'account_onboarding' });
  return res.json({ url: link.url });
}

async function connectStatus(req, res) {
  if (!process.env.STRIPE_SECRET_KEY) return paymentsNotConfigured(res);
  const p = await practitionerFor(req.user.sub);
  if (!p) return res.status(404).json({ error: 'No practitioner profile found' });
  const r = await db.query('SELECT stripe_account_id FROM practitioner_booking_settings WHERE practitioner_id = $1', [p.id]);
  const accountId = r.rows[0] && r.rows[0].stripe_account_id;
  if (!accountId) return res.json({ accountCreated: false, payoutsEnabled: false, detailsSubmitted: false });
  const acct = await stripe.accounts.retrieve(accountId);
  const payoutsEnabled = !!(acct.payouts_enabled && acct.capabilities && acct.capabilities.transfers === 'active');
  await db.query('UPDATE practitioner_booking_settings SET stripe_payouts_enabled = $2, stripe_details_submitted = $3, updated_at = now() WHERE practitioner_id = $1', [p.id, payoutsEnabled, !!acct.details_submitted]);
  return res.json({ accountCreated: true, payoutsEnabled, detailsSubmitted: !!acct.details_submitted });
}

// ───────────────────────── public: listing and slots ─────────────────────────

async function listPractitioners(req, res) {
  const r = await db.query(
    `SELECT ${PROFILE_COLS}, ${SETTINGS_COLS}
     FROM practitioner_profiles p JOIN practitioner_booking_settings s ON s.practitioner_id = p.id WHERE p.verification_status = 'verified'`);
  const now = Date.now();
  const ok = r.rows.filter((row) => eligibility(row, now).length === 0).slice(0, 100);
  const photos = await db.query('SELECT practitioner_id FROM practitioner_photos');
  const has = new Set(photos.rows.map((x) => x.practitioner_id));
  return res.json({ practitioners: ok.map((row) => ({
    id: row.id, practitionerCode: row.practitioner_code, displayName: nameOf(row), credentials: credentialsOf(row), location: locationOf(row),
    bio: row.bio ? String(row.bio).slice(0, 400) : '', photoPath: has.has(row.id) ? `/consultations/practitioners/${row.id}/photo` : null,
    sessionMinutes: row.session_minutes, priceCents: row.session_price_cents, premiumPriceCents: row.premium_price_cents, currency: row.currency, timezone: row.timezone,
  })) });
}

async function getSlots(req, res) {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  await expireStaleHolds(Date.now());
  const row = await loadPractitioner(req.params.id);
  if (!row || eligibility(row, Date.now()).length) return res.status(409).json({ error: 'This practitioner is not available for booking right now.', code: 'NOT_BOOKABLE' });
  const slots = await availableSlots(row, Date.now());
  return res.json({
    practitionerId: row.id, timezone: row.timezone, sessionMinutes: row.session_minutes, currency: row.currency,
    priceCents: row.session_price_cents, premiumPriceCents: row.premium_price_cents,
    slots: slots.map((ms) => new Date(ms).toISOString()),
  });
}

// ───────────────────────── subscriber: book, view, cancel, report ─────────────────────────

async function book(req, res) {
  if (!process.env.STRIPE_SECRET_KEY) return paymentsNotConfigured(res);
  const { practitionerId, startsAt } = req.body || {};
  if (!UUID_RE.test(practitionerId || '') || typeof startsAt !== 'string' || Number.isNaN(Date.parse(startsAt)))
    return res.status(400).json({ error: 'practitionerId and a valid startsAt are required' });
  const sub = await subscriberFor(req.user.sub);
  if (!sub) return res.status(404).json({ error: 'No subscriber profile found' });
  await expireStaleHolds(Date.now());
  const row = await loadPractitioner(practitionerId);
  if (!row || eligibility(row, Date.now()).length) return res.status(409).json({ error: 'This practitioner is not available for booking right now.', code: 'NOT_BOOKABLE' });
  const startsMs = Date.parse(startsAt);
  const slots = await availableSlots(row, Date.now());
  if (!slots.includes(startsMs)) return res.status(409).json({ error: 'That time is not available.', code: 'SLOT_UNAVAILABLE' });

  const premium = sub.plan !== 'free' && row.premium_price_cents;
  const amount = premium ? row.premium_price_cents : row.session_price_cents;
  const { platformFeeCents, practitionerShareCents } = L.splitAmount(amount);
  const endsMs = startsMs + row.session_minutes * 60000;
  const holdExpires = new Date(Date.now() + holdMinutes() * 60000);
  let bookingId;
  try {
    const ins = await db.query(
      `INSERT INTO consultation_bookings (subscriber_id, practitioner_id, starts_at, ends_at, status, amount_cents, currency, price_basis,
         platform_fee_cents, practitioner_share_cents, slot_key, hold_expires_at, practitioner_agreement_version)
       VALUES ($1, $2, $3, $4, 'held', $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [sub.id, row.id, new Date(startsMs), new Date(endsMs), amount, row.currency, premium ? 'premium' : 'standard', platformFeeCents, practitionerShareCents, `${row.id}|${startsMs}`, holdExpires, row.agreement_version]);
    bookingId = ins.rows[0].id;
  } catch (e) {
    if (isUniqueViolation(e)) return res.status(409).json({ error: 'That time was just taken. Please choose another.', code: 'SLOT_TAKEN' });
    throw e;
  }
  const u = await db.query('SELECT email FROM users WHERE id = $1', [req.user.sub]);
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      client_reference_id: bookingId,
      customer_email: u.rows[0] && u.rows[0].email,
      line_items: [{ quantity: 1, price_data: { currency: row.currency, unit_amount: amount, product_data: { name: `Video consultation (${row.session_minutes} min)`, description: 'With an independent AIDH Marketplace practitioner' } } }],
      payment_intent_data: { transfer_group: bookingId, metadata: { bookingId } },
      metadata: { bookingId },
      success_url: `${returnBase()}?booking=${bookingId}&paid=1`,
      cancel_url: `${returnBase()}?booking=${bookingId}&paid=0`,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,   // Stripe's minimum; our own shorter hold governs the slot
    });
  } catch (err) {
    await db.query(`UPDATE consultation_bookings SET status = 'expired', slot_key = NULL, hold_expires_at = NULL, updated_at = now() WHERE id = $1`, [bookingId]);
    return res.status(502).json({ error: 'Could not start checkout. Please try again.' });
  }
  await db.query('UPDATE consultation_bookings SET stripe_checkout_session_id = $2, updated_at = now() WHERE id = $1', [bookingId, session.id]);
  return res.status(201).json({
    bookingId, ref: ref(bookingId), checkoutUrl: session.url, holdExpiresAt: holdExpires.toISOString(),
    amountCents: amount, currency: row.currency, priceBasis: premium ? 'premium' : 'standard',
    startsAt: new Date(startsMs).toISOString(), endsAt: new Date(endsMs).toISOString(),
  });
}

async function loadBookingWithParties(id) {
  const r = await db.query(
    `SELECT ${CB}, sp.user_id AS subscriber_user_id, pp.user_id AS practitioner_user_id, pp.practitioner_code, pp.first_name, pp.last_name,
            s.video_link, s.timezone, su.email AS subscriber_email, pu.email AS practitioner_email, s.stripe_account_id
     FROM consultation_bookings cb
     JOIN subscriber_profiles sp ON sp.id = cb.subscriber_id
     JOIN practitioner_profiles pp ON pp.id = cb.practitioner_id
     JOIN users su ON su.id = sp.user_id
     JOIN users pu ON pu.id = pp.user_id
     LEFT JOIN practitioner_booking_settings s ON s.practitioner_id = cb.practitioner_id
     WHERE cb.id = $1`, [id]);
  return r.rows[0] || null;
}
const partyOf = (b, userId) => (userId === b.subscriber_user_id ? 'subscriber' : userId === b.practitioner_user_id ? 'practitioner' : null);

/** What cancelling right now would do, for the person about to press the button. */
function refundPreview(b, party, nowMs) {
  const startsMs = new Date(b.starts_at).getTime();
  const canCancel = (b.status === 'held' || b.status === 'confirmed') && nowMs < startsMs;
  if (!canCancel) return { canCancel: false, refund: null };
  if (b.status === 'held') return { canCancel: true, refund: { type: 'none', amountCents: 0, withheldCents: 0, unpaid: true } };
  const out = L.cancellationOutcome({ by: party, nowMs, startsAtMs: startsMs, freeHours: freeCancelHours() });
  if (!out.refundFull) return { canCancel: true, refund: { type: 'none', amountCents: 0, withheldCents: 0 } };
  if (party === 'subscriber' && deductsFee()) {
    const fee = Number.isInteger(b.stripe_fee_cents) ? b.stripe_fee_cents : null;
    return { canCancel: true, refund: { type: 'full_minus_fee', amountCents: fee == null ? null : L.refundAfterFee(b.amount_cents, fee), withheldCents: fee } };
  }
  return { canCancel: true, refund: { type: 'full', amountCents: b.amount_cents, withheldCents: 0 } };
}

function shapeBooking(b, party) {
  const nowMs = Date.now();
  const linkVisible = (b.status === 'confirmed' || b.status === 'completed') && b.refund_cents === 0 && !!b.stripe_charge_id;
  return {
    id: b.id, ref: ref(b.id), status: b.status, startsAt: new Date(b.starts_at).toISOString(), endsAt: new Date(b.ends_at).toISOString(),
    amountCents: b.amount_cents, currency: b.currency, priceBasis: b.price_basis, refundCents: b.refund_cents,
    practitioner: { code: b.practitioner_code, name: nameOf(b) }, timezone: b.timezone, role: party,
    videoLink: linkVisible ? b.video_link : null,
    releaseAfter: b.release_after ? new Date(b.release_after).toISOString() : null,
    cancellation: refundPreview(b, party, nowMs),
    subscriberEmail: party === 'practitioner' && shareEmail() && linkVisible ? b.subscriber_email : undefined,
    // The subscriber sees the reason they gave; the practitioner is not shown it (the admin contacts both).
    issueReason: party === 'subscriber' && b.issue_reason ? b.issue_reason : undefined,
  };
}

async function getBooking(req, res) {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const b = await loadBookingWithParties(req.params.id);
  const party = b && partyOf(b, req.user.sub);
  if (!party) return res.status(404).json({ error: 'Not found' });
  return res.json(shapeBooking(b, party));
}

async function myBookings(req, res) {
  const r = await db.query(
    `SELECT cb.id, cb.starts_at, cb.ends_at, cb.status, cb.amount_cents, cb.currency, cb.refund_cents, pp.practitioner_code, pp.first_name, pp.last_name
     FROM consultation_bookings cb JOIN subscriber_profiles sp ON sp.id = cb.subscriber_id JOIN practitioner_profiles pp ON pp.id = cb.practitioner_id
     WHERE sp.user_id = $1 ORDER BY cb.starts_at DESC LIMIT 100`, [req.user.sub]);
  return res.json({ bookings: r.rows.map((x) => ({ id: x.id, ref: ref(x.id), status: x.status, startsAt: new Date(x.starts_at).toISOString(), endsAt: new Date(x.ends_at).toISOString(), amountCents: x.amount_cents, currency: x.currency, refundCents: x.refund_cents, practitioner: { code: x.practitioner_code, name: nameOf(x) } })) });
}

async function practitionerBookings(req, res) {
  const r = await db.query(
    `SELECT ${CB}, su.email AS subscriber_email
     FROM consultation_bookings cb JOIN practitioner_profiles pp ON pp.id = cb.practitioner_id
     JOIN subscriber_profiles sp ON sp.id = cb.subscriber_id JOIN users su ON su.id = sp.user_id
     WHERE pp.user_id = $1 AND cb.status IN ('confirmed','completed','cancelled','disputed') ORDER BY cb.starts_at DESC LIMIT 100`, [req.user.sub]);
  return res.json({ bookings: r.rows.map((x) => ({
    id: x.id, ref: ref(x.id), status: x.status, startsAt: new Date(x.starts_at).toISOString(), endsAt: new Date(x.ends_at).toISOString(),
    amountCents: x.amount_cents, currency: x.currency, refundCents: x.refund_cents, yourShareCents: x.practitioner_share_cents, payoutCents: x.practitioner_payout_cents,
    released: !!x.released_at, subscriberEmail: shareEmail() && (x.status === 'confirmed' || x.status === 'completed') ? x.subscriber_email : undefined,
  })) });
}

/** Refund the full amount and cancel. Used for early cancellations, practitioner cancellations,
 *  admin-resolved disputes, and a late payment whose slot was already re-booked. */
async function refundAndCancel(b, paymentIntentId, by, reason, amountCents) {
  const pi = paymentIntentId || b.stripe_payment_intent_id;
  const refund = amountCents === undefined ? b.amount_cents : amountCents;
  if (refund > 0) {
    await stripe.refunds.create({ payment_intent: pi, amount: refund, metadata: { bookingId: b.id, reason, withheldCents: String(b.amount_cents - refund) } }, { idempotencyKey: `aidh-booking-${b.id}-refund` });
  }
  await db.query(
    `UPDATE consultation_bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, refund_cents = $3, slot_key = NULL,
       hold_expires_at = NULL, stripe_payment_intent_id = $4, updated_at = now() WHERE id = $1`, [b.id, by, refund, pi]);
  await logAudit(db, { actorType: by === 'system' ? 'system' : by, actionCategory: 'CONSULTATION', action: 'REFUNDED', description: `ref ${ref(b.id)} (${reason}; ${refund} of ${b.amount_cents} cents)` });
}

/** The card-processing fee Stripe charged on this booking's payment. Known from the webhook; fetched (and
 *  stored) here if that lookup failed earlier. Throws if Stripe cannot say, so a refund is never guessed. */
async function feeFor(b) {
  if (Number.isInteger(b.stripe_fee_cents)) return b.stripe_fee_cents;
  const pi = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id, { expand: ['latest_charge.balance_transaction'] });
  const bt = pi && pi.latest_charge && pi.latest_charge.balance_transaction;
  if (!bt || typeof bt !== 'object' || !Number.isInteger(bt.fee)) throw new Error('Stripe fee unavailable');
  await db.query('UPDATE consultation_bookings SET stripe_fee_cents = $2, practitioner_payout_cents = $3, updated_at = now() WHERE id = $1',
    [b.id, bt.fee, L.practitionerPayout(b.practitioner_share_cents, bt.fee)]);
  return bt.fee;
}

async function notifyCancelled(b, by, refundCents, withheldCents) {
  const ctx = { ref: ref(b.id), startsAtMs: new Date(b.starts_at).getTime(), timezone: b.timezone || 'UTC', currency: b.currency, amountCents: b.amount_cents, refundCents, withheldCents: withheldCents || 0, by };
  try { await sendMail({ to: b.subscriber_email, ...E.cancelled(ctx) }); } catch (e) { console.error('consultations: email failed', e.message); }
  try { await sendMail({ to: b.practitioner_email, ...E.cancelled({ ...ctx, forPractitioner: true }) }); } catch (e) { console.error('consultations: email failed', e.message); }
}

/** Both people are told a dispute was decided, in one dedicated email each (this replaces the generic cancellation
 *  email a refund used to send, which never said a dispute had been decided). Neutral and factual: the outcome and
 *  the amount, never the reason given or anything either person said. A failed email never undoes the decision. */
async function notifyDisputeDecided(b, action) {
  const ctx = { ref: ref(b.id), startsAtMs: new Date(b.starts_at).getTime(), timezone: b.timezone || 'UTC', currency: b.currency,
    amountCents: b.amount_cents, payoutCents: b.practitioner_payout_cents, outcome: action === 'refund' ? 'refunded' : 'released',
    supportEmail: process.env.SUPPORT_EMAIL || null };
  const replyTo = ctx.supportEmail || undefined;
  try { await sendMail({ to: b.subscriber_email, replyTo, ...E.disputeDecided(ctx) }); } catch (e) { console.error('consultations: email failed', e.message); }
  try { await sendMail({ to: b.practitioner_email, replyTo, ...E.disputeDecided({ ...ctx, forPractitioner: true }) }); } catch (e) { console.error('consultations: email failed', e.message); }
}

async function cancelBooking(req, res) {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const b = await loadBookingWithParties(req.params.id);
  const by = b && partyOf(b, req.user.sub);
  if (!by) return res.status(404).json({ error: 'Not found' });
  if (b.status === 'held') {
    await db.query(`UPDATE consultation_bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, slot_key = NULL, hold_expires_at = NULL, updated_at = now() WHERE id = $1`, [b.id, by]);
    if (b.stripe_checkout_session_id) { try { await stripe.checkout.sessions.expire(b.stripe_checkout_session_id); } catch (e) { /* best effort */ } }
    return res.json({ status: 'cancelled', refundCents: 0, withheldCents: 0 });
  }
  if (b.status !== 'confirmed') return res.status(409).json({ error: 'This booking can no longer be cancelled.' });
  const out = L.cancellationOutcome({ by, nowMs: Date.now(), startsAtMs: new Date(b.starts_at).getTime(), freeHours: freeCancelHours() });
  if (!out.allowed) return res.status(409).json({ error: 'The session has already started. If something went wrong, report it instead.' });
  if (out.refundFull) {
    // A subscriber's own early cancellation refunds the payment minus the card-processing fee Stripe keeps.
    // A practitioner's cancellation refunds everything: the subscriber did nothing wrong.
    let refund = b.amount_cents;
    if (by === 'subscriber' && deductsFee()) {
      let fee;
      try { fee = await feeFor(b); }
      catch (e) { return res.status(502).json({ error: 'We could not confirm your refund amount just now. Nothing has been cancelled. Please try again in a moment.' }); }
      refund = L.refundAfterFee(b.amount_cents, fee);
    }
    await refundAndCancel(b, b.stripe_payment_intent_id, by, `${by}_cancelled`, refund);
    await notifyCancelled(b, by, refund, b.amount_cents - refund);
    return res.json({ status: 'cancelled', refundCents: refund, withheldCents: b.amount_cents - refund });
  }
  // Inside the no-refund window: the slot is freed, but the practitioner is still paid at release time.
  await db.query(`UPDATE consultation_bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, refund_cents = 0, slot_key = NULL, updated_at = now() WHERE id = $1`, [b.id, by]);
  await logAudit(db, { actorUserId: req.user.sub, actorType: by, actionCategory: 'CONSULTATION', action: 'CANCELLED_NO_REFUND', description: `ref ${ref(b.id)}` });
  await notifyCancelled(b, by, 0, 0);
  return res.json({ status: 'cancelled', refundCents: 0, withheldCents: 0 });
}

/** The subscriber reports a problem, choosing one reason from the fixed list (required; no free text). */
async function reportIssue(req, res) {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const b = await loadBookingWithParties(req.params.id);
  if (!b || partyOf(b, req.user.sub) !== 'subscriber') return res.status(404).json({ error: 'Not found' });
  const nowMs = Date.now();
  if (!['confirmed', 'completed'].includes(b.status) || b.released_at || nowMs < new Date(b.starts_at).getTime() || nowMs > new Date(b.release_after).getTime())
    return res.status(409).json({ error: 'A problem can be reported from the start of the session until 24 hours after it ends.' });
  const reason = (req.body || {}).reason;
  if (!DISPUTE_REASON_CODES.includes(reason)) {
    return res.status(400).json({ error: 'Please choose what went wrong.', code: 'REASON_REQUIRED', reasons: DISPUTE_REASONS });
  }
  await db.query(`UPDATE consultation_bookings SET status = 'disputed', issue_reported_at = now(), issue_reason = $2, updated_at = now() WHERE id = $1`, [b.id, reason]);
  await logAudit(db, { actorUserId: req.user.sub, actorType: 'subscriber', actionCategory: 'CONSULTATION', action: 'ISSUE_REPORTED', description: `ref ${ref(b.id)} (${reason})` });
  return res.json({ status: 'disputed', issueReason: reason });
}

async function markComplete(req, res) {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const b = await loadBookingWithParties(req.params.id);
  if (!b || partyOf(b, req.user.sub) !== 'practitioner') return res.status(404).json({ error: 'Not found' });
  if (b.status !== 'confirmed' || Date.now() < new Date(b.ends_at).getTime()) return res.status(409).json({ error: 'A booking can be marked complete once it has ended.' });
  await db.query(`UPDATE consultation_bookings SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1`, [b.id]);
  return res.json({ status: 'completed', note: 'Your share is released after the subscriber\'s 24-hour window, unless a problem is reported.' });
}

/** An admin decides a disputed booking: refund the subscriber in full, or release the practitioner's share.
 *  The decision is CLAIMED first with a conditional update (status still 'disputed' and not yet resolved), so
 *  two admins acting at the same moment cannot both act: before this, one could refund while the other
 *  flipped the booking back to 'completed', and the release job would then pay the practitioner as well.
 *  If the refund itself fails, the claim is undone so the dispute can be decided again. */
async function adminResolve(req, res) {
  const action = (req.body || {}).action;
  if (!UUID_RE.test(req.params.id) || !['refund', 'release'].includes(action)) return res.status(400).json({ error: 'action must be "refund" or "release"' });
  const b = await loadBookingWithParties(req.params.id);
  if (!b || b.status !== 'disputed') return res.status(409).json({ error: 'Only a disputed booking can be resolved here.' });
  const claim = await db.query(
    `UPDATE consultation_bookings SET issue_resolved_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'disputed' AND issue_resolved_at IS NULL RETURNING id`, [b.id]);
  if (claim.rows.length === 0) return res.status(409).json({ error: 'This dispute has already been decided, or another admin is deciding it now. Reload to see its current state.' });
  if (action === 'refund') {
    try {
      await refundAndCancel(b, b.stripe_payment_intent_id, 'system', 'admin_resolved_refund');
    } catch (err) {
      await db.query(`UPDATE consultation_bookings SET issue_resolved_at = NULL, updated_at = now() WHERE id = $1 AND status = 'disputed'`, [b.id]);
      throw err;
    }
  } else {
    await db.query(`UPDATE consultation_bookings SET status = 'completed', release_after = now(), completed_at = COALESCE(completed_at, now()), updated_at = now()
                    WHERE id = $1 AND status = 'disputed'`, [b.id]);
  }
  await logAudit(db, { actorUserId: req.user.sub, actorType: 'admin', actionCategory: 'CONSULTATION', action: 'DISPUTE_RESOLVED', description: `ref ${ref(b.id)} -> ${action}` });
  await notifyDisputeDecided(b, action);
  return res.json({ resolved: action });
}

// ───────────────────────── Stripe webhook handlers (called from billing.controller) ─────────────────────────

async function notifyConfirmed(bookingId) {
  const b = await loadBookingWithParties(bookingId);
  if (!b) return;
  const ctx = { ref: ref(b.id), practitionerCode: b.practitioner_code, practitionerName: nameOf(b), startsAtMs: new Date(b.starts_at).getTime(), endsAtMs: new Date(b.ends_at).getTime(),
    timezone: b.timezone || 'UTC', videoLink: b.video_link, amountCents: b.amount_cents, currency: b.currency,
    freeCancelHours: freeCancelHours(), releaseDelayHours: releaseDelayHours(), deductsFee: deductsFee() };
  try { await sendMail({ to: b.subscriber_email, ...E.confirmedForSubscriber(ctx) }); } catch (e) { console.error('consultations: email failed', e.message); }
  try { await sendMail({ to: b.practitioner_email, ...E.confirmedForPractitioner({ ...ctx, subscriberEmail: shareEmail() ? b.subscriber_email : null }) }); } catch (e) { console.error('consultations: email failed', e.message); }
}

async function onCheckoutCompleted(session) {
  const bookingId = session.metadata && session.metadata.bookingId;
  if (!bookingId) return;
  const r = await db.query('SELECT * FROM consultation_bookings WHERE id = $1', [bookingId]);
  const b = r.rows[0];
  if (!b) return;
  // Idempotent: Stripe may deliver the same event more than once.
  if (['confirmed', 'completed', 'disputed'].includes(b.status) || (b.status === 'cancelled' && b.stripe_payment_intent_id)) return;
  const piId = typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent && session.payment_intent.id);
  const slotKey = `${b.practitioner_id}|${new Date(b.starts_at).getTime()}`;
  if (b.status !== 'held') {
    // The hold lapsed before payment arrived. Take the slot back if it is still free; if someone
    // else has it, refund automatically rather than leave money taken for no booking.
    try { await db.query('UPDATE consultation_bookings SET slot_key = $2 WHERE id = $1', [b.id, slotKey]); }
    catch (e) {
      if (isUniqueViolation(e)) {
        const full = await loadBookingWithParties(b.id);
        await refundAndCancel(full, piId, 'system', 'slot_taken_after_hold_expired');
        await notifyCancelled(full, 'system', full.amount_cents);
        return;
      }
      throw e;
    }
  }
  let chargeId = null, fee = null;
  try {
    const pi = await stripe.paymentIntents.retrieve(piId, { expand: ['latest_charge.balance_transaction'] });
    const ch = pi && pi.latest_charge;
    chargeId = ch && (typeof ch === 'string' ? ch : ch.id);
    const bt = ch && typeof ch === 'object' ? ch.balance_transaction : null;
    if (bt && typeof bt === 'object' && Number.isInteger(bt.fee)) fee = bt.fee;
  } catch (e) { console.error('consultations: could not read the Stripe fee yet; will retry at release', e.message); }
  const payout = fee == null ? null : L.practitionerPayout(b.practitioner_share_cents, fee);
  const releaseAfter = new Date(new Date(b.ends_at).getTime() + releaseDelayHours() * 3600000);
  const upd = await db.query(
    `UPDATE consultation_bookings SET status = 'confirmed', confirmed_at = now(), stripe_payment_intent_id = $2, stripe_charge_id = $3,
       stripe_fee_cents = $4, practitioner_payout_cents = $5, release_after = $6, hold_expires_at = NULL, slot_key = $7, updated_at = now()
     WHERE id = $1 AND status IN ('held', 'expired') RETURNING id`, [b.id, piId, chargeId, fee, payout, releaseAfter, slotKey]);
  if (!upd.rows.length) return;                       // another delivery already handled it
  await logAudit(db, { actorType: 'system', actionCategory: 'CONSULTATION', action: 'BOOKING_CONFIRMED', description: `ref ${ref(b.id)}` });
  await notifyConfirmed(b.id);
}

async function onCheckoutExpired(session) {
  const bookingId = session.metadata && session.metadata.bookingId;
  if (!bookingId) return;
  await db.query(`UPDATE consultation_bookings SET status = 'expired', slot_key = NULL, hold_expires_at = NULL, updated_at = now() WHERE id = $1 AND status = 'held'`, [bookingId]);
}

// ───────────────────────── scheduled work ─────────────────────────

/** Free slots whose payment never arrived. Safe to run as often as you like. */
async function expireStaleHolds(nowMs) {
  const r = await db.query(
    `UPDATE consultation_bookings SET status = 'expired', slot_key = NULL, hold_expires_at = NULL, updated_at = now()
     WHERE status = 'held' AND hold_expires_at < $1 RETURNING id, stripe_checkout_session_id`, [new Date(nowMs)]);
  for (const row of r.rows) {
    if (row.stripe_checkout_session_id) { try { await stripe.checkout.sessions.expire(row.stripe_checkout_session_id); } catch (e) { /* already expired or completed */ } }
  }
  return r.rows.length;
}

async function releaseOne(b) {
  let fee = b.stripe_fee_cents;
  if (fee == null) {
    const pi = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id, { expand: ['latest_charge.balance_transaction'] });
    const bt = pi && pi.latest_charge && pi.latest_charge.balance_transaction;
    fee = bt && Number.isInteger(bt.fee) ? bt.fee : 0;
  }
  const payout = L.practitionerPayout(b.practitioner_share_cents, fee);
  let transferId = null;
  if (payout > 0) {
    // The idempotency key means a retry after a crash cannot pay the practitioner twice.
    const t = await stripe.transfers.create(
      { amount: payout, currency: b.currency, destination: b.stripe_account_id, transfer_group: b.id, source_transaction: b.stripe_charge_id,
        description: `AIDH consultation ${ref(b.id)}`, metadata: { bookingId: b.id } },
      { idempotencyKey: `aidh-booking-${b.id}-release` });
    transferId = t.id;
  }
  const newStatus = b.status === 'confirmed' ? 'completed' : b.status;
  await db.query(
    `UPDATE consultation_bookings SET released_at = now(), stripe_transfer_id = $2, stripe_fee_cents = $3, practitioner_payout_cents = $4,
       status = $5, completed_at = COALESCE(completed_at, now()), updated_at = now() WHERE id = $1 AND released_at IS NULL`,
    [b.id, transferId, fee, payout, newStatus]);
  await logAudit(db, { actorType: 'system', actionCategory: 'CONSULTATION', action: 'SHARE_RELEASED', description: `ref ${ref(b.id)}` });
}

/** Releases every practitioner share that is due: past its window, not under dispute, not refunded. */
async function releaseDueBookings(nowMs) {
  const due = await db.query(
    `SELECT ${CB}, s.stripe_account_id FROM consultation_bookings cb JOIN practitioner_booking_settings s ON s.practitioner_id = cb.practitioner_id
     WHERE cb.released_at IS NULL AND cb.stripe_charge_id IS NOT NULL AND cb.release_after <= $1
       AND (cb.status IN ('confirmed','completed') OR (cb.status = 'cancelled' AND cb.refund_cents = 0))
       AND (cb.issue_reported_at IS NULL OR cb.issue_resolved_at IS NOT NULL)`, [new Date(nowMs)]);
  let released = 0; const failures = [];
  for (const b of due.rows) {
    try { await releaseOne(b); released += 1; } catch (e) { failures.push({ id: b.id, error: e.message }); console.error('consultations: release failed for', ref(b.id), e.message); }
  }
  return { released, failures };
}


// ───────────────────────── terms, quote, headshots ─────────────────────────

/** The numbers the booking screens show, straight from the server's own settings, so the page can never
 *  promise something the server does not do. */
async function getTerms(req, res) {
  return res.json({
    currency: 'usd', freeCancelHours: freeCancelHours(), refundDeductsFee: deductsFee(), releaseDelayHours: releaseDelayHours(),
    holdMinutes: holdMinutes(), shareSubscriberEmail: shareEmail(), videoLinkReconfirmDays: reconfirmDays(),
  });
}

/** The price this signed-in subscriber will actually pay, shown before they commit. */
async function getQuote(req, res) {
  if (!UUID_RE.test(req.params.practitionerId)) return res.status(404).json({ error: 'Not found' });
  const sub = await subscriberFor(req.user.sub);
  if (!sub) return res.status(404).json({ error: 'No subscriber profile found' });
  const row = await loadPractitioner(req.params.practitionerId);
  if (!row || eligibility(row, Date.now()).length) return res.status(409).json({ error: 'This practitioner is not available for booking right now.', code: 'NOT_BOOKABLE' });
  const premium = sub.plan !== 'free' && row.premium_price_cents;
  return res.json({ practitionerId: row.id, amountCents: premium ? row.premium_price_cents : row.session_price_cents, currency: row.currency,
    priceBasis: premium ? 'premium' : 'standard', sessionMinutes: row.session_minutes, displayName: nameOf(row) });
}

const MAX_PHOTO_BYTES = 100000;
async function putPhoto(req, res) {
  const p = await practitionerFor(req.user.sub);
  if (!p) return res.status(404).json({ error: 'No practitioner profile found' });
  const b64 = (req.body || {}).imageBase64;
  if (typeof b64 !== 'string' || b64.length > 150000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return res.status(400).json({ error: 'imageBase64 must be a base64-encoded JPEG.' });
  const raw = Buffer.from(b64, 'base64');
  const clean = raw.length <= MAX_PHOTO_BYTES ? L.sanitizeJpeg(raw) : null;
  if (!clean || clean.length > MAX_PHOTO_BYTES) return res.status(400).json({ error: 'The headshot must be a valid JPEG under 100 KB. Photos are resized in your browser before upload.' });
  const has = await db.query('SELECT 1 FROM practitioner_photos WHERE practitioner_id = $1', [p.id]);
  if (has.rows.length) await db.query('UPDATE practitioner_photos SET data_base64 = $2, byte_size = $3, updated_at = now() WHERE practitioner_id = $1', [p.id, clean.toString('base64'), clean.length]);
  else await db.query(`INSERT INTO practitioner_photos (practitioner_id, content_type, data_base64, byte_size) VALUES ($1, 'image/jpeg', $2, $3)`, [p.id, clean.toString('base64'), clean.length]);
  await logAudit(db, { actorUserId: req.user.sub, actorType: 'practitioner', actionCategory: 'CONSULTATION', action: 'HEADSHOT_UPDATED', description: `${clean.length} bytes` });
  return res.json({ saved: true, bytes: clean.length });
}
async function deletePhoto(req, res) {
  const p = await practitionerFor(req.user.sub);
  if (!p) return res.status(404).json({ error: 'No practitioner profile found' });
  await db.query('DELETE FROM practitioner_photos WHERE practitioner_id = $1', [p.id]);
  return res.json({ deleted: true });
}
async function getMyPhoto(req, res) {
  const p = await practitionerFor(req.user.sub);
  if (!p) return res.status(404).json({ error: 'No practitioner profile found' });
  const r = await db.query('SELECT data_base64 FROM practitioner_photos WHERE practitioner_id = $1', [p.id]);
  return res.json({ hasPhoto: r.rows.length > 0, imageBase64: r.rows[0] ? r.rows[0].data_base64 : null });
}
/** Public. Served only for a verified practitioner who has agreed to be listed. */
async function getPublicPhoto(req, res) {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const r = await db.query(
    `SELECT ph.data_base64 FROM practitioner_photos ph
     JOIN practitioner_profiles p ON p.id = ph.practitioner_id
     JOIN practitioner_booking_settings s ON s.practitioner_id = p.id
     WHERE ph.practitioner_id = $1 AND p.verification_status = 'verified' AND s.directory_consent_at IS NOT NULL`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff',
            'Cross-Origin-Resource-Policy': 'cross-origin' });   // the pages live on another origin than the API
  return res.status(200).send(Buffer.from(r.rows[0].data_base64, 'base64'));
}


// ───────────────────────── Practitioner Agreement ─────────────────────────

/** Public: which agreement version is current, and whether it is still a draft placeholder. */
async function getAgreement(req, res) {
  const v = agreementVersion();
  return res.json({ version: v, isDraft: /^DRAFT/i.test(v), page: 'aidh_practitioner_agreement.html' });
}

/** A practitioner accepts the CURRENT agreement. The version they send must match the server's, so nobody can
 *  accept a stale or invented version, and accepting is idempotent (it never overwrites an earlier acceptance of
 *  the same version, so the original time is kept). */
async function acceptAgreement(req, res) {
  const p = await practitionerFor(req.user.sub);
  if (!p) return res.status(404).json({ error: 'No practitioner profile found' });
  const b = req.body || {};
  if (b.accept !== true) return res.status(400).json({ error: 'Please tick the box to accept the agreement (accept: true).' });
  if (b.version !== agreementVersion())
    return res.status(409).json({ error: 'The agreement has changed. Please reload the page and read the current version.', code: 'AGREEMENT_VERSION_MISMATCH', currentVersion: agreementVersion() });
  const has = await db.query('SELECT agreement_version FROM practitioner_booking_settings WHERE practitioner_id = $1', [p.id]);
  if (!has.rows.length) await db.query('INSERT INTO practitioner_booking_settings (practitioner_id) VALUES ($1)', [p.id]);
  else if (has.rows[0].agreement_version === agreementVersion()) return getSettings(req, res);
  await db.query('UPDATE practitioner_booking_settings SET agreement_version = $2, agreement_accepted_at = now(), updated_at = now() WHERE practitioner_id = $1', [p.id, agreementVersion()]);
  await logAudit(db, { actorUserId: req.user.sub, actorType: 'practitioner', actionCategory: 'CONSULTATION', action: 'AGREEMENT_ACCEPTED', description: `version ${agreementVersion()}` });
  return getSettings(req, res);
}

module.exports = {
  getSettings, putSettings, putAvailability, connectOnboard, connectStatus,
  listPractitioners, getSlots, book, getBooking, myBookings, practitionerBookings,
  cancelBooking, reportIssue, markComplete, adminResolve,
  getTerms, getQuote, putPhoto, deletePhoto, getMyPhoto, getPublicPhoto, getAgreement, acceptAgreement,
  onCheckoutCompleted, onCheckoutExpired, expireStaleHolds, releaseDueBookings,
};
