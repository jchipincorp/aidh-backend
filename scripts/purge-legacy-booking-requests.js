// scripts/purge-legacy-booking-requests.js
//
// Deletes the old request-based booking records (contact details, preferred times and free-text notes) for
// good. This is IRREVERSIBLE, so it is a dry run unless you pass --confirm.
//   node scripts/purge-legacy-booking-requests.js                      shows what would be deleted
//   node scripts/purge-legacy-booking-requests.js --confirm            deletes booking requests and their orders
//   node scripts/purge-legacy-booking-requests.js --confirm --include-matches
//                                                                      also deletes match requests
// Take a database backup first if you may ever need the old records.
require('dotenv').config();
const db = require('../src/config/db');
const { purgeLegacyBookingRequests } = require('../src/lib/legacyPurge');
const confirm = process.argv.includes('--confirm'), includeMatches = process.argv.includes('--include-matches');
purgeLegacyBookingRequests(db, { confirm, includeMatches })
  .then(async (r) => {
    console.log(JSON.stringify(r, null, 2));
    console.log(r.deleted ? 'DONE: the records above were deleted.' : 'DRY RUN: nothing was deleted. Re-run with --confirm to delete.');
    if (db.end) await db.end();
  })
  .catch(async (e) => { console.error('FAILED:', e.message); if (db.end) await db.end(); process.exit(1); });
