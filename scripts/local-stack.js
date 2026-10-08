// scripts/local-stack.js
//
// For the Stripe TEST-mode run on your own machine: serves the front-end pages AND the API from ONE address, because
// the pages call the API at the address they are served from. Uses the REAL Stripe client and the keys in your .env
// (unlike dev-fake-stripe-server.js, which pretends to be Stripe). Refuses production and live keys.
//   npm run local-stack -- --frontend /path/to/the/unzipped/frontend
// Then open  http://localhost:4001/aidh_website.html
require('dotenv').config();
const path = require('path'), fs = require('fs'), express = require('express');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const frontend = path.resolve(arg('frontend', process.env.FRONTEND_DIR || ''));
if (process.env.NODE_ENV === 'production' || /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY || '')) { console.error('Refusing: this launcher is for local, TEST-mode use only.'); process.exit(2); }
if (!fs.existsSync(path.join(frontend, 'aidh_website.html'))) { console.error('Point --frontend at the unzipped front-end folder (the one that contains aidh_website.html).'); process.exit(2); }
const PORT = parseInt(process.env.PORT || '4001', 10);
const { createApp } = require('../src/server');
const outer = express();
outer.use(express.static(frontend, { index: 'aidh_website.html' }));
outer.use(createApp());
outer.listen(PORT, () => {
  console.log(`AIDH local stack on http://localhost:${PORT}  (front end from ${frontend})`);
  console.log(`Open http://localhost:${PORT}/aidh_website.html`);
  console.log(`Stripe key: ${(process.env.STRIPE_SECRET_KEY || '').slice(0, 8)}...  (test mode only)`);
});
