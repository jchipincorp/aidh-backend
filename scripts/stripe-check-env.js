// scripts/stripe-check-env.js -- the pre-flight check for the Stripe TEST-mode run. Read-only. Refuses live keys.
require('dotenv').config();
const db = require('../src/config/db');
const stripe = require('../src/lib/stripeClient');
const { checkEnvironment } = require('../src/lib/stripeRunCheck');
checkEnvironment({ stripe, db }).then(async (r) => {
  const tag = { ok: ' OK  ', warn: 'WARN ', error: 'FAIL ' };
  r.checks.forEach((c) => console.log(`${tag[c.level]} ${c.name}${c.detail ? '\n        ' + c.detail : ''}`));
  console.log(`\n${r.errors} problem(s), ${r.warnings} note(s). ${r.errors ? 'Fix the problems above, then run this again.' : 'Ready for the run.'}`);
  if (db.end) await db.end(); process.exit(r.errors ? 1 : 0);
}).catch(async (e) => { console.error('FAILED:', e.message); if (db.end) await db.end(); process.exit(1); });
