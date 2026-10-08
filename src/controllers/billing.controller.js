// src/controllers/billing.controller.js
//
// Real Stripe integration for the 7-day-trial-then-charge flow described
// in the onboarding UI (aidh_onboarding.html Step 7) and in
// AIDH_Frontend_Final's README. Uses Stripe's own trial primitive
// (trial_period_days on a subscription) rather than a hand-rolled "day
// 8" scheduler -- Stripe's own infrastructure handles the actual charge
// timing, retries, and "don't charge if canceled before trial end"
// behavior correctly; this code's job is to create the right Stripe
// objects and stay in sync with what Stripe reports back, not to
// reimplement billing state machines Stripe already solves.
//
// Flow: createSetupIntent (collect card via Stripe Elements, no charge)
// -> subscribe (create the real trialing subscription once the payment
// method is attached) -> Stripe handles the 7-day wait and the day-8
// charge itself -> handleWebhook keeps our own `subscriptions` table in
// sync with whatever actually happened on Stripe's side.

const db = require('../config/db');
const stripe = require('../lib/stripeClient');
const { logAudit } = require('../lib/audit');
const consultations = require('./consultations.controller');

// Read fresh on every call, not captured once as a module-level
// constant -- an earlier version captured process.env.STRIPE_PRICE_ID_*
// at require time, which is fine in a real deployment (env vars don't
// change mid-process) but meant a test could never actually exercise
// the "price id missing" error path by deleting the env var after the
// module had already loaded -- found by that exact test failing in a
// confusing way (a generic 500 instead of the specific configured
// error), not by inspection.
function priceIdFor(plan) {
  return { monthly: process.env.STRIPE_PRICE_ID_MONTHLY, annual: process.env.STRIPE_PRICE_ID_ANNUAL }[plan];
}

function billingNotConfiguredError(res) {
  // Never let a missing/placeholder Stripe key surface as a confusing
  // Stripe-side authentication error -- fail with a clear, specific
  // message instead. This is the exact situation this code will be in
  // until real STRIPE_SECRET_KEY / STRIPE_PRICE_ID_* values are set --
  // see the README's "Final activation checklist".
  return res.status(500).json({ error: 'Billing is not fully configured on this server yet.' });
}

/** Creates (or reuses) a Stripe customer for the calling subscriber and
 * a SetupIntent -- the object Stripe Elements needs client-side to
 * securely collect and attach a card WITHOUT charging it. No charge of
 * any kind happens here; a SetupIntent's entire purpose is collecting a
 * payment method for later use. */
async function createSetupIntent(req, res) {
  if (!process.env.STRIPE_SECRET_KEY) return billingNotConfiguredError(res);

  const profile = await db.query('SELECT id FROM subscriber_profiles WHERE user_id = $1', [req.user.sub]);
  if (profile.rows.length === 0) return res.status(404).json({ error: 'No subscriber profile found' });
  const subscriberId = profile.rows[0].id;

  // Reuse an existing Stripe customer if this subscriber already has one
  // on file (e.g. a previous attempt that didn't finish subscribing) --
  // avoids creating duplicate Stripe customer objects for the same person.
  const existing = await db.query('SELECT external_customer_id FROM subscriptions WHERE subscriber_id = $1', [subscriberId]);
  let customerId = existing.rows[0] && existing.rows[0].external_customer_id;

  if (!customerId) {
    const userRow = await db.query('SELECT email FROM users WHERE id = $1', [req.user.sub]);
    const customer = await stripe.customers.create({
      email: userRow.rows[0].email,
      metadata: { subscriber_id: subscriberId },
    });
    customerId = customer.id;
  }

  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    usage: 'off_session', // will be charged later, automatically, with no customer present -- exactly the day-8 trial-end charge
  });

  return res.status(201).json({ clientSecret: setupIntent.client_secret, customerId });
}

/** Creates the real trialing Stripe subscription once the frontend has
 * confirmed the SetupIntent (attached a real payment method). This is
 * the call that actually starts the 7-day trial -- Stripe will not
 * create an invoice or attempt a charge until trial_period_days elapses,
 * and canceling before then (see cancelSubscription below) means Stripe
 * never creates one at all. */
async function subscribe(req, res) {
  if (!process.env.STRIPE_SECRET_KEY) return billingNotConfiguredError(res);

  const { plan, customerId, paymentMethodId } = req.body;
  if (!['monthly', 'annual'].includes(plan)) {
    return res.status(400).json({ error: 'plan must be "monthly" or "annual"' });
  }
  const priceId = priceIdFor(plan);
  if (!priceId) {
    return res.status(500).json({ error: `Billing is not fully configured: no Stripe price id set for the ${plan} plan.` });
  }
  if (!customerId || !paymentMethodId) {
    return res.status(400).json({ error: 'customerId and paymentMethodId are required (from a completed SetupIntent confirmation)' });
  }

  const profile = await db.query('SELECT id FROM subscriber_profiles WHERE user_id = $1', [req.user.sub]);
  if (profile.rows.length === 0) return res.status(404).json({ error: 'No subscriber profile found' });
  const subscriberId = profile.rows[0].id;

  // ONE free trial per account, and never two live subscriptions.
  // Every subscription this app has ever created started with a trial, so a
  // subscriptions row existing at all means this account has used its trial.
  //  - a row that is still live (trialing / active / past_due): refuse. Before
  //    this check, calling subscribe() again created a SECOND Stripe
  //    subscription and billed the person twice.
  //  - a canceled row: allowed (restarting Premium), but WITHOUT a trial.
  const prior = await db.query('SELECT status FROM subscriptions WHERE subscriber_id = $1', [subscriberId]);
  const priorRow = prior.rows[0] || null;
  if (priorRow && priorRow.status !== 'canceled') {
    return res.status(409).json({ error: 'You already have a Premium subscription on this account.' });
  }
  const trialUsed = !!priorRow;

  // IDOR guard: verify this customerId genuinely belongs to the calling
  // subscriber. A DB-only check isn't enough on its own -- the FIRST
  // time a subscriber ever calls subscribe(), no subscriptions row
  // exists for ANYONE yet (createSetupIntent doesn't write one; see its
  // own comment), so a check that only compares against an EXISTING row
  // would catch a mismatch against the caller's own prior record but
  // not a first-time claim of someone ELSE's customer id -- an earlier
  // version of this check did exactly that, and a real test caught it:
  // an attacker successfully subscribed themselves using a victim's
  // customerId before this fix, live-proven, not theorized. Stripe
  // itself is the authoritative source instead: createSetupIntent
  // stamps metadata.subscriber_id on the customer object the moment
  // it's created, so retrieving it and checking that metadata proves
  // ownership regardless of what (if anything) exists in our own
  // database yet.
  const customer = await stripe.customers.retrieve(customerId);
  if (!customer || !customer.metadata || customer.metadata.subscriber_id !== subscriberId) {
    return res.status(403).json({ error: 'This customer id does not belong to your account' });
  }

  // Attach the confirmed payment method as this customer's default --
  // Stripe Elements' confirmCardSetup already attaches it to the
  // customer as a side effect, but setting it as the invoicing default
  // explicitly is what makes the automatic day-8 charge actually use it.
  await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId }).catch((err) => {
    // Already attached (e.g. a retried request) is not a real error --
    // Stripe returns a specific error type for this; anything else
    // should still surface.
    if (err.code !== 'resource_already_attached') throw err;
  });
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });

  const subscriptionParams = {
    customer: customerId,
    items: [{ price: priceId }],
    payment_settings: { save_default_payment_method: 'on_subscription' },
  };
  if (trialUsed) {
    // No trial: the first invoice is charged right now. 'error_if_incomplete'
    // makes Stripe REFUSE to create the subscription if that first payment
    // fails or needs extra bank verification. Without it Stripe creates the
    // subscription anyway in an 'incomplete' state -- a status our
    // subscription_status enum has no value for, so we would write an error
    // AFTER a live Stripe subscription already existed.
    subscriptionParams.payment_behavior = 'error_if_incomplete';
  } else {
    subscriptionParams.trial_period_days = 7;
  }

  let subscription;
  try {
    subscription = await stripe.subscriptions.create(subscriptionParams);
  } catch (err) {
    if (trialUsed && err && err.type === 'StripeCardError') {
      return res.status(402).json({ error: err.message || 'Your card could not be charged.' });
    }
    if (trialUsed && err && err.code === 'subscription_payment_intent_requires_action') {
      return res.status(402).json({ error: 'Your bank needs extra verification for this payment, which cannot be completed here yet. Please try a different card.' });
    }
    throw err;
  }

  const trialEnd = subscription.trial_end ? new Date(subscription.trial_end * 1000) : null;
  // With a trial, the first period ends when the trial does; without one, it is
  // the ordinary billing period Stripe reports.
  const periodEnd = subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : trialEnd;

  await db.query(
    `INSERT INTO subscriptions (subscriber_id, external_processor, external_customer_id, external_subscription_id, status, current_period_end)
     VALUES ($1, 'stripe', $2, $3, $4, $5)
     ON CONFLICT (subscriber_id) DO UPDATE SET
       external_customer_id = $2, external_subscription_id = $3, status = $4, current_period_end = $5, canceled_at = NULL`,
    [subscriberId, customerId, subscription.id, subscription.status, periodEnd]
  );
  // Keep subscriber_profiles' own plan/trial_ends_at in sync too -- the
  // fast, simple summary fields other parts of the app may read, now
  // corrected to the REAL Stripe-computed trial end rather than the
  // 14-day-then-7-day placeholder register() sets before any real
  // subscription exists (see that file's own comment).
  await db.query(`UPDATE subscriber_profiles SET plan = $1, trial_ends_at = $2, updated_at = now() WHERE id = $3`, [plan, trialEnd, subscriberId]);

  await logAudit(db, {
    actorUserId: req.user.sub, actorType: 'subscriber', actionCategory: 'BILLING',
    action: trialUsed ? 'SUBSCRIPTION_STARTED_NO_TRIAL' : 'TRIAL_STARTED', description: `plan=${plan}`,
  });

  return res.status(201).json({
    subscriptionId: subscription.id, status: subscription.status,
    trialEnd: trialEnd ? trialEnd.toISOString() : null, plan, trialUsed,
  });
}

/** Cancels the calling subscriber's OWN subscription -- never a
 * client-supplied id, derived entirely from req.user.sub, the same
 * ownership pattern used throughout this codebase. Canceling a
 * still-trialing Stripe subscription immediately (not
 * cancel_at_period_end) means Stripe never creates an invoice for it at
 * all -- this is what makes "canceled within the trial = genuinely
 * never charged" true, not just a UI promise. */
async function cancelSubscription(req, res) {
  if (!process.env.STRIPE_SECRET_KEY) return billingNotConfiguredError(res);

  const profile = await db.query('SELECT id FROM subscriber_profiles WHERE user_id = $1', [req.user.sub]);
  if (profile.rows.length === 0) return res.status(404).json({ error: 'No subscriber profile found' });

  const subRow = await db.query(
    'SELECT external_subscription_id, status FROM subscriptions WHERE subscriber_id = $1',
    [profile.rows[0].id]
  );
  if (subRow.rows.length === 0 || !subRow.rows[0].external_subscription_id) {
    return res.status(404).json({ error: 'No active subscription found for your account' });
  }
  if (subRow.rows[0].status === 'canceled') {
    return res.status(400).json({ error: 'Your subscription is already canceled' });
  }

  const wasTrialing = subRow.rows[0].status === 'trialing';
  await stripe.subscriptions.cancel(subRow.rows[0].external_subscription_id);

  await db.query(
    `UPDATE subscriptions SET status = 'canceled', canceled_at = now() WHERE subscriber_id = $1`,
    [profile.rows[0].id]
  );
  // Back to the free plan -- otherwise the account keeps saying 'monthly'/'annual'
  // after Premium has ended.
  await db.query(`UPDATE subscriber_profiles SET plan = 'free', trial_ends_at = NULL, updated_at = now() WHERE id = $1`, [profile.rows[0].id]);

  await logAudit(db, {
    actorUserId: req.user.sub, actorType: 'subscriber', actionCategory: 'BILLING',
    action: wasTrialing ? 'TRIAL_CANCELED_NO_CHARGE' : 'SUBSCRIPTION_CANCELED',
  });

  return res.json({ canceled: true, wasTrialing, chargedDuringTrial: false });
}

/** Read-only status from OUR OWN table -- deliberately does not make a
 * live call to Stripe on every check (that would be slow and
 * unnecessary for a simple "what does my account currently show"
 * query). Our table is kept in sync by subscribe() and by
 * handleWebhook() below, which is the actual source of truth for
 * anything that changes on Stripe's side outside of this app's own
 * direct API calls (a failed automatic charge, a dispute, etc.). */
async function getStatus(req, res) {
  const profile = await db.query('SELECT id, plan, trial_ends_at FROM subscriber_profiles WHERE user_id = $1', [req.user.sub]);
  if (profile.rows.length === 0) return res.status(404).json({ error: 'No subscriber profile found' });

  const subRow = await db.query(
    'SELECT status, current_period_end, canceled_at FROM subscriptions WHERE subscriber_id = $1',
    [profile.rows[0].id]
  );

  return res.json({
    plan: profile.rows[0].plan,
    trialEndsAt: profile.rows[0].trial_ends_at,
    subscription: subRow.rows[0] || null,
    // One free trial per account: once any subscription row exists (even a
    // canceled one) the trial has been used. The UI uses this to say "billed
    // today" instead of "7 days free".
    trialAvailable: subRow.rows.length === 0,
  });
}

/** Stripe webhook receiver. Requires the RAW request body (see
 * billing.routes.js / server.js -- this route is mounted with
 * express.raw(), not the global express.json(), specifically so
 * stripe.webhooks.constructEvent can verify the signature against the
 * exact bytes Stripe sent, not a re-serialized JSON.parse/stringify
 * round-trip of them, which would not match). No requireAuth on this
 * route -- Stripe calls it directly, authenticated by the signature
 * instead of a bearer token. */
async function handleWebhook(req, res) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).json({ error: 'Billing webhooks are not fully configured on this server yet.' });
  }

  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    // A failed signature check means this request did NOT genuinely
    // come from Stripe (or the body was tampered with in transit) --
    // reject outright, never process it as if it were real.
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  const obj = event.data.object;

  switch (event.type) {
    case 'customer.subscription.updated': {
      await db.query(
        `UPDATE subscriptions SET status = $1, current_period_end = $2 WHERE external_subscription_id = $3`,
        [obj.status, obj.current_period_end ? new Date(obj.current_period_end * 1000) : null, obj.id]
      );
      break;
    }
    case 'customer.subscription.deleted': {
      const gone = await db.query(
        `UPDATE subscriptions SET status = 'canceled', canceled_at = now() WHERE external_subscription_id = $1 RETURNING subscriber_id`,
        [obj.id]
      );
      if (gone.rows[0]) {
        await db.query(`UPDATE subscriber_profiles SET plan = 'free', trial_ends_at = NULL, updated_at = now() WHERE id = $1`, [gone.rows[0].subscriber_id]);
      }
      break;
    }
    case 'invoice.payment_failed': {
      if (obj.subscription) {
        await db.query(`UPDATE subscriptions SET status = 'past_due' WHERE external_subscription_id = $1`, [obj.subscription]);
      }
      break;
    }
    case 'invoice.payment_succeeded': {
      // This is what fires when Stripe's own day-8 automatic charge
      // actually succeeds -- the real end of the "not charged during
      // the trial" period, driven by Stripe's own billing engine, not
      // a cron job this codebase has to get right on its own.
      if (obj.subscription) {
        await db.query(`UPDATE subscriptions SET status = 'active' WHERE external_subscription_id = $1`, [obj.subscription]);
      }
      break;
    }
    // One-off consultation payments (Stripe Checkout). Subscriptions above never use Checkout, so
    // these cannot collide with them; the booking id in the session metadata is what ties them.
    case 'checkout.session.completed': {
      if (obj.metadata && obj.metadata.bookingId) await consultations.onCheckoutCompleted(obj);
      break;
    }
    case 'checkout.session.expired': {
      if (obj.metadata && obj.metadata.bookingId) await consultations.onCheckoutExpired(obj);
      break;
    }
    default:
      // Unhandled event types are fine to ignore -- Stripe sends many
      // more event types than this app currently acts on.
      break;
  }

  return res.json({ received: true });
}

module.exports = { createSetupIntent, subscribe, cancelSubscription, getStatus, handleWebhook };
