// scripts/upgrade-free-plan.js
//
// ONE-TIME upgrade for a database that was created BEFORE the free tier existed.
// (A brand-new database needs nothing: `npm run migrate` already creates the
// schema with 'free'.)
//
// What it does:
//   1. adds 'free' to the subscriber_plan enum (safe to repeat)
//   2. makes 'free' the column default for new subscriber profiles
//   3. converts accounts that are wrongly labeled 'trial' -- registered but never
//      subscribed, so nothing is trialing or ending -- to 'free', clearing the
//      placeholder trial_ends_at that registration used to write
//   4. converts accounts whose subscription has been canceled to 'free' (cancel
//      used to leave them labeled 'monthly'/'annual')
// Accounts with a live subscription are left exactly as they are.
//
// Usage:  DATABASE_URL=postgres://... node scripts/upgrade-free-plan.js
// Safe to run more than once (a second run changes nothing).
const { Pool } = require('pg');

async function upgrade(pool) {
  // Separate queries, on purpose: Postgres will not let a NEW enum value be used
  // in the same transaction that adds it, and a multi-statement pool.query() is
  // one transaction. (This is also why it is not a numbered migration: the
  // migration runner applies each file as a single batch.)
  await pool.query(`ALTER TYPE subscriber_plan ADD VALUE IF NOT EXISTS 'free'`);
  await pool.query(`ALTER TABLE subscriber_profiles ALTER COLUMN plan SET DEFAULT 'free'`);
  const neverSubscribed = await pool.query(
    `UPDATE subscriber_profiles sp SET plan = 'free', trial_ends_at = NULL, updated_at = now()
     WHERE sp.plan = 'trial' AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.subscriber_id = sp.id)`);
  const canceled = await pool.query(
    `UPDATE subscriber_profiles sp SET plan = 'free', trial_ends_at = NULL, updated_at = now()
     WHERE sp.plan <> 'free' AND sp.id IN (SELECT subscriber_id FROM subscriptions WHERE status = 'canceled')`);
  return { neverSubscribed: neverSubscribed.rowCount, canceled: canceled.rowCount };
}

if (require.main === module) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  upgrade(pool)
    .then((r) => { console.log(`Upgraded. Converted to 'free': ${r.neverSubscribed} never-subscribed 'trial' account(s), ${r.canceled} canceled-subscription account(s).`); return pool.end(); })
    .catch((err) => { console.error(err); process.exit(1); });
}
module.exports = { upgrade };
