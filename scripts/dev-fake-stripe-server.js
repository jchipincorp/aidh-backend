// scripts/dev-fake-stripe-server.js
//
// DEVELOPMENT ONLY. Runs the real backend with a PRETEND Stripe, so the whole booking journey (a
// practitioner connecting payouts, a subscriber paying, a cancellation refund, the release of the
// practitioner's share) can be clicked through in a browser with no Stripe account and no real money.
// It adds a few /dev/* pages: a fake Stripe Checkout page with a Pay button, a fake Connect onboarding
// step, and a button to run the scheduled jobs "N hours in the future".
//
// This proves the screens and our logic. It does NOT prove Stripe's real API accepts our calls: that
// needs one run against a Stripe test account (see the README).
//   Usage: DATABASE_URL=... JWT_SECRET=... FIELD_ENCRYPTION_KEY=... node scripts/dev-fake-stripe-server.js
if (process.env.NODE_ENV === 'production') { console.error('Refusing to start: this server pretends to be Stripe.'); process.exit(1); }
const PORT = parseInt(process.env.PORT || '4001', 10);
const BASE = process.env.DEV_PUBLIC_BASE || `http://localhost:${PORT}`;
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dev_fake';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_dev_fake';
process.env.MAIL_PROVIDER = process.env.MAIL_PROVIDER || 'console';
const express = require('express');
const { buildFakeStripeClient } = require('../tests/fakeStripeClient');

const sessions = new Map();          // bookingId -> { amount, success, cancel }
const onboarded = new Set(); let accountSeq = 0;
const fake = buildFakeStripeClient({
  'checkout.sessions.create': (p) => { const id = p.metadata.bookingId; sessions.set(id, { amount: p.line_items[0].price_data.unit_amount, success: p.success_url, cancel: p.cancel_url }); return { id: 'cs_dev_' + id, url: `${BASE}/dev/checkout/${id}` }; },
  'checkout.sessions.expire': () => ({}),
  'accounts.create': () => { accountSeq += 1; return { id: 'acct_dev_' + accountSeq }; },
  'accountLinks.create': (p) => ({ url: `${BASE}/dev/connect/onboard?account=${p.account}&return=${encodeURIComponent(p.return_url)}` }),
  'accounts.retrieve': (id) => ({ id, details_submitted: onboarded.has(id), payouts_enabled: onboarded.has(id), capabilities: { transfers: onboarded.has(id) ? 'active' : 'inactive' } }),
  'paymentIntents.retrieve': (pi) => { const id = String(pi).replace('pi_dev_', ''); const s = sessions.get(id) || { amount: 0 }; return { id: pi, latest_charge: { id: 'ch_dev_' + id, balance_transaction: { fee: Math.round(s.amount * 0.029) + 30 } } }; },
  'refunds.create': (p) => ({ id: 're_dev_' + Date.now(), amount: p.amount }),
  'transfers.create': (p) => ({ id: 'tr_dev_' + Date.now(), amount: p.amount }),
});
require.cache[require.resolve('../src/lib/stripeClient.js')] = { id: 'dev-stripe', filename: 'dev-stripe', loaded: true, exports: fake };
const { createApp } = require('../src/server');
const consultations = require('../src/controllers/consultations.controller');
const { runConsultationJobs } = require('../src/lib/consultationJobs');

const dev = express.Router();
const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:460px;margin:60px auto;padding:0 20px;background:#f6f7f9;color:#111"><div style="background:#fff3cd;border:1px solid #e6c200;padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:22px"><b>DEV ONLY.</b> This is a pretend Stripe page. No card is charged and no real money moves.</div>${body}</body>`;
dev.get('/checkout/:id', (req, res) => {
  const s = sessions.get(req.params.id); if (!s) return res.status(404).send(page('Not found', '<p>Unknown checkout session.</p>'));
  res.send(page('Pretend Stripe Checkout', `<h2>Pretend Stripe Checkout</h2><p style="font-size:30px;margin:8px 0">$${(s.amount / 100).toFixed(2)}</p><form method="post" action="/dev/pay/${req.params.id}"><button id="dev-pay" style="width:100%;padding:14px;font-size:16px;border:0;border-radius:8px;background:#635bff;color:#fff;cursor:pointer">Pay $${(s.amount / 100).toFixed(2)}</button></form><p style="margin-top:16px"><a id="dev-cancel" href="${s.cancel}">Cancel and go back</a></p>`));
});
dev.post('/pay/:id', async (req, res, next) => {
  try {
    const s = sessions.get(req.params.id); if (!s) return res.status(404).send('unknown');
    await consultations.onCheckoutCompleted({ metadata: { bookingId: req.params.id }, payment_intent: 'pi_dev_' + req.params.id });   // what Stripe's webhook would do
    res.redirect(303, s.success);
  } catch (e) { next(e); }
});
dev.get('/connect/onboard', (req, res) => {
  const ret = String(req.query.return || ''); if (!/^https?:\/\/localhost[:/]/.test(ret)) return res.status(400).send('bad return url');
  res.send(page('Pretend Stripe onboarding', `<h2>Pretend Stripe payout setup</h2><p>In the real flow, Stripe's own screens collect identity, bank and tax details. Nothing is collected here.</p><form method="post" action="/dev/connect/finish"><input type="hidden" name="account" value="${String(req.query.account).replace(/[^\w]/g, '')}"><input type="hidden" name="return" value="${ret.replace(/"/g, '')}"><button id="dev-finish" style="width:100%;padding:14px;font-size:16px;border:0;border-radius:8px;background:#635bff;color:#fff;cursor:pointer">Finish setup</button></form>`));
});
dev.post('/connect/finish', express.urlencoded({ extended: false }), (req, res) => {
  const ret = String(req.body.return || ''); if (!/^https?:\/\/localhost[:/]/.test(ret)) return res.status(400).send('bad return url');
  onboarded.add(String(req.body.account)); res.redirect(303, ret);
});
dev.post('/run-jobs', async (req, res, next) => { try { res.json(await runConsultationJobs(Date.now() + Number(req.query.advanceHours || 0) * 3600000)); } catch (e) { next(e); } });
dev.get('/calls', (req, res) => res.json(fake._calls.map((c) => ({ resource: c.resource, method: c.method, args: c.args }))));

const outer = express();
outer.use('/dev', dev);
outer.use(createApp());
outer.listen(PORT, () => console.log(`AIDH backend with a PRETEND Stripe listening on :${PORT} (dev only)`));
