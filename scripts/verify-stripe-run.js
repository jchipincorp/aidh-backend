// scripts/verify-stripe-run.js -- after the Stripe TEST-mode run: compare our database with Stripe's records. Read-only.
require('dotenv').config();
const db = require('../src/config/db');
const stripe = require('../src/lib/stripeClient');
const { verifyBookings } = require('../src/lib/stripeRunCheck');
if (/^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY || '')) { console.error('Refusing to run with a LIVE key. This check is for the test-mode run.'); process.exit(2); }
verifyBookings({ db, stripe }).then(async (r) => {
  if (!r.bookingsChecked) console.log('No booking with a Stripe payment yet. Make a test booking first.');
  let last = '';
  r.findings.forEach((f) => { if (f.booking !== last) { console.log(`\nBooking ${f.booking} (${f.status})`); last = f.booking; } console.log(`  ${f.ok ? ' OK ' : 'FAIL'}  ${f.check}${f.ok ? '' : '\n          ' + f.detail}`); });
  console.log(`\n${r.bookingsChecked} booking(s) checked, ${r.mismatches} mismatch(es). ${r.mismatches ? 'Send this output back: a mismatch is information, and may be the script or the product.' : 'Our records agree with Stripe\'s.'}`);
  if (db.end) await db.end(); process.exit(r.mismatches ? 1 : 0);
}).catch(async (e) => { console.error('FAILED:', e.message); if (db.end) await db.end(); process.exit(1); });
