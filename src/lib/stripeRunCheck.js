// src/lib/stripeRunCheck.js
//
// Two READ-ONLY helpers for the Stripe TEST-mode acceptance run (see STRIPE_TEST_RUN.md).
//
//  checkEnvironment  -- before the run: are the keys test keys, can this machine reach Stripe, is Connect
//                       enabled, is the database ready, and what will trip the run up?
//  verifyBookings    -- after the run: for every booking that has a Stripe payment, compare OUR records with
//                       STRIPE'S: the amount, the fee we recorded vs the fee Stripe charged, the refund, the
//                       transfer to the practitioner. Nothing is created, changed or deleted, at Stripe or here.
//
// Neither helper has been run against the real Stripe API from the build environment (it cannot reach Stripe).
// They are tested against a simulated Stripe; the first real run is what shows whether they and the product
// agree with Stripe. A mismatch is information, not necessarily a product bug: read the detail.

async function checkEnvironment({ env = process.env, stripe, db }) {
  const checks = [];
  const add = (name, ok, detail, level) => checks.push({ name, ok, level: level || (ok ? 'ok' : 'error'), detail: detail || '' });
  const key = env.STRIPE_SECRET_KEY || '';

  if (!key || /dummy|fixture|NOT_CONFIGURED|placeholder/i.test(key)) {
    add('Stripe secret key is set', false, 'STRIPE_SECRET_KEY is missing or is a placeholder. Use your TEST secret key (sk_test_...).');
  } else if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) {
    add('Stripe key is a TEST key', false, 'This is a LIVE key. This run is for test mode only. Nothing further was checked, and nothing was sent to Stripe.');
    return summarize(checks);
  } else if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) {
    add('Stripe key is a TEST key', true, 'sk_test_...');
  } else {
    add('Stripe key looks like a Stripe secret key', false, 'Expected it to start with sk_test_.');
  }
  add('Webhook signing secret is set', /^whsec_/.test(env.STRIPE_WEBHOOK_SECRET || ''), 'STRIPE_WEBHOOK_SECRET should start with whsec_. The Stripe CLI prints it when you run "stripe listen".');

  if (checks.every((c) => c.ok)) {
    try {
      const bal = await stripe.balance.retrieve();
      add('Stripe is reachable with this key, in test mode', !!bal && bal.livemode === false, bal && bal.livemode ? 'Stripe says this key is LIVE.' : '');
    } catch (e) { add('Stripe is reachable with this key', false, 'Stripe replied: ' + (e && e.message)); }
    try { await stripe.accounts.list({ limit: 1 }); add('Connect is enabled on this Stripe account', true); }
    catch (e) { add('Connect is enabled on this Stripe account', false, 'Stripe replied: ' + (e && e.message) + ' (Connect must be switched on in the Stripe Dashboard first.)'); }
  }

  try { await db.query('SELECT agreement_version, directory_consent_at, stripe_account_id FROM practitioner_booking_settings LIMIT 1'); await db.query('SELECT practitioner_agreement_version, stripe_fee_cents FROM consultation_bookings LIMIT 1'); add('The database has the booking tables and migration 013', true); }
  catch (e) { add('The database has the booking tables and migration 013', false, 'Run "npm run migrate". Detail: ' + (e && e.message)); }

  const warn = (name, detail) => add(name, true, detail, 'warn');
  if (!/^https?:\/\//.test(env.CONSULTATION_RETURN_URL || '')) warn('CONSULTATION_RETURN_URL is not set', 'It defaults to http://localhost:4002/aidh_book.html. Fine for a local run; set the real address before launch.');
  if (!/^https?:\/\//.test(env.CONNECT_RETURN_URL || '')) warn('CONNECT_RETURN_URL is not set', 'It defaults to http://localhost:4002/aidh_practitioner_console.html. Fine for a local run; set the real address before launch.');
  if (String(env.CONSULTATION_RELEASE_DELAY_HOURS) !== '0') warn('CONSULTATION_RELEASE_DELAY_HOURS is not 0', 'To see the practitioner payout during the run without waiting, set it to 0 for the test (the default is 24).');
  if ((env.MAIL_PROVIDER || '').toLowerCase() === 'resend') warn('Emails will really be sent through Resend', 'Use MAIL_PROVIDER=console for the Stripe run if you only want to test payments.');
  warn('Use a US-based test practitioner for the first run', 'As built, a practitioner\'s Stripe account is created WITHOUT a country, so Stripe makes a US account. A practitioner outside the US cannot complete onboarding. Cross-border payouts need extra setup that has not been built; see the runbook.');
  return summarize(checks);
}

function summarize(checks) {
  return { checks, errors: checks.filter((c) => c.level === 'error').length, warnings: checks.filter((c) => c.level === 'warn').length };
}

async function verifyBookings({ db, stripe, limit = 200 }) {
  const rows = (await db.query(
    `SELECT cb.id, cb.status, cb.amount_cents, cb.currency, cb.stripe_fee_cents, cb.practitioner_share_cents, cb.practitioner_payout_cents,
            cb.refund_cents, cb.stripe_payment_intent_id, cb.stripe_charge_id, cb.stripe_transfer_id, cb.released_at, s.stripe_account_id
     FROM consultation_bookings cb LEFT JOIN practitioner_booking_settings s ON s.practitioner_id = cb.practitioner_id
     WHERE cb.stripe_payment_intent_id IS NOT NULL ORDER BY cb.created_at DESC LIMIT $1`, [limit])).rows;
  const findings = [];
  for (const b of rows) {
    const ref = String(b.id).slice(0, 8).toUpperCase();
    const f = (check, ok, detail) => findings.push({ booking: ref, status: b.status, check, ok: !!ok, detail: detail || '' });
    let pi;
    try { pi = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id, { expand: ['latest_charge.balance_transaction'] }); }
    catch (e) { f('the payment exists at Stripe', false, (e && e.message) || 'not found'); continue; }
    f('the payment succeeded at Stripe', pi.status === 'succeeded', `Stripe status: ${pi.status}`);
    f('amount and currency match what we recorded', pi.amount === b.amount_cents && String(pi.currency).toLowerCase() === String(b.currency).toLowerCase(), `Stripe ${pi.amount} ${pi.currency}; ours ${b.amount_cents} ${b.currency}`);
    f('the payment is tied to this booking (metadata)', !!pi.metadata && pi.metadata.bookingId === b.id, `Stripe metadata bookingId: ${pi.metadata && pi.metadata.bookingId}`);
    const ch = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
    f('the charge we recorded is the charge Stripe shows', !!ch && ch.id === b.stripe_charge_id, `Stripe ${ch && ch.id}; ours ${b.stripe_charge_id}`);
    const bt = ch && ch.balance_transaction && typeof ch.balance_transaction === 'object' ? ch.balance_transaction : null;
    f('the processing fee we recorded equals the fee Stripe charged', !!bt && Number.isInteger(bt.fee) && b.stripe_fee_cents === bt.fee, `Stripe ${bt && bt.fee}; ours ${b.stripe_fee_cents}`);
    const rf = await stripe.refunds.list({ payment_intent: b.stripe_payment_intent_id, limit: 100 });
    const refunded = ((rf && rf.data) || []).filter((r) => r.status !== 'failed' && r.status !== 'canceled').reduce((a, r) => a + r.amount, 0);
    f('the amount refunded at Stripe equals what we recorded', refunded === b.refund_cents, `Stripe ${refunded}; ours ${b.refund_cents}`);
    if (b.stripe_transfer_id) {
      const expected = Math.max(0, b.practitioner_share_cents - (b.stripe_fee_cents || 0));
      let t;
      try { t = await stripe.transfers.retrieve(b.stripe_transfer_id); } catch (e) { f('the transfer exists at Stripe', false, (e && e.message) || 'not found'); continue; }
      f('the transfer is the practitioner\'s 75% share minus the processing fee', t.amount === b.practitioner_payout_cents && t.amount === expected, `Stripe ${t.amount}; ours ${b.practitioner_payout_cents}; expected ${expected}`);
      f('the transfer went to the practitioner\'s connected account', t.destination === b.stripe_account_id, `Stripe ${t.destination}; ours ${b.stripe_account_id}`);
      f('the transfer is tied to the original charge', t.source_transaction === b.stripe_charge_id, `Stripe ${t.source_transaction}; ours ${b.stripe_charge_id}`);
      f('the transfer has not been reversed', !t.reversed && !t.amount_reversed, `reversed: ${t.reversed}, amount reversed: ${t.amount_reversed}`);
      f('a booking that was refunded was never also paid out', b.refund_cents === 0, `refund recorded: ${b.refund_cents}`);
    } else if (b.released_at) {
      f('a released booking without a transfer has a zero payout', b.practitioner_payout_cents === 0, `payout recorded: ${b.practitioner_payout_cents}`);
    }
  }
  return { bookingsChecked: rows.length, findings, mismatches: findings.filter((x) => !x.ok).length };
}

module.exports = { checkEnvironment, verifyBookings };
