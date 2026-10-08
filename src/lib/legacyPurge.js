// src/lib/legacyPurge.js
//
// Deletes the old request-based booking records for good. Decided with the product owner and counsel: the
// free-text notes on those requests could hold health details, and the flow that created them is retired.
// Default is a DRY RUN that only counts. Nothing is deleted unless confirm is true.
//   booking requests (and their orders, which cascade): always, when confirmed
//   match requests (specialist type + urgent flag, which also cascade to any consent records tied to them):
//     only when includeMatches is true, because they hold no free text and are a separate decision
const { logAudit } = require('./audit');

async function purgeLegacyBookingRequests(db, { confirm = false, includeMatches = false } = {}) {
  const br = (await db.query('SELECT COUNT(*)::int AS n FROM booking_requests')).rows[0].n;
  const od = (await db.query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n;
  const mt = (await db.query('SELECT COUNT(*)::int AS n FROM practitioner_matches')).rows[0].n;
  const summary = { bookingRequests: br, orders: od, matchRequests: mt, matchRequestsIncluded: !!includeMatches, deleted: false };
  if (!confirm) return summary;
  await db.query('DELETE FROM booking_requests');                       // cascades to orders
  if (includeMatches) await db.query('DELETE FROM practitioner_matches'); // cascades to consent records tied to them
  await logAudit(db, {
    actorType: 'system', actionCategory: 'PRIVACY', action: 'LEGACY_REQUESTS_PURGED',
    description: `${br} booking requests and ${od} orders deleted` + (includeMatches ? `; ${mt} match requests deleted` : ''),
  });
  return { ...summary, deleted: true };
}

module.exports = { purgeLegacyBookingRequests };
