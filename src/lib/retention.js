// src/lib/retention.js
//
// Data-minimization purge helpers. NOT wired to auto-run anywhere in
// this scaffold -- in production this should be invoked by a scheduled
// job (cron, a hosting platform's scheduled task, etc.), not on every
// request. See README "Compliance hardening" for how to wire one up.
//
// Scope is deliberately narrow: expired auth sessions and stale push
// tokens are the only things purged here.
//
// audit_log is intentionally NEVER touched by this module. HIPAA
// generally requires audit-trail retention (commonly 6 years) -- for
// that table, retention is a MINIMUM-keep requirement, not a purge
// target. Do not add audit_log purging here without a documented legal
// basis and sign-off; see AIDH_Database_Design.docx Section 7.
//
// slider_snapshots and lab_results are also deliberately excluded: they
// exist for as long as the subscriber's account does, and are already
// fully removed via ON DELETE CASCADE when a subscriber deletes their
// account (subscriber.controller.js deleteMyAccount). There's no
// separate time-based expiry for active-account health data here --
// that would be a product/legal decision, not a default this module
// should impose.

const db = require('../config/db');

const DEFAULT_SESSION_RETENTION_DAYS = 30;

/** Removes session rows that expired more than `retentionDays` ago.
 * Sessions past expires_at already can't authenticate (see
 * middleware/auth.js) -- this just stops the table, which holds
 * ip_address and user_agent (both personal data under GDPR), from
 * growing forever. */
async function purgeExpiredSessions(retentionDays = DEFAULT_SESSION_RETENTION_DAYS) {
  const result = await db.query(
    `DELETE FROM sessions WHERE expires_at < now() - ($1 || ' days')::interval RETURNING id`,
    [String(retentionDays)]
  );
  return { purged: result.rows.length, table: 'sessions' };
}

/** Removes push tokens that were never refreshed within `retentionDays` --
 * a token this stale almost always belongs to a reinstalled or
 * abandoned app instance, not an active device. */
async function purgeStalePushTokens(retentionDays = 180) {
  const result = await db.query(
    `DELETE FROM push_tokens WHERE created_at < now() - ($1 || ' days')::interval RETURNING id`,
    [String(retentionDays)]
  );
  return { purged: result.rows.length, table: 'push_tokens' };
}

/** Runs all purge routines. Intended entry point for a scheduled job --
 * e.g. a daily cron calling `node -e "require('./src/lib/retention').runAll().then(console.log)"`
 * or the equivalent on whichever host eventually runs this (Render/Fly.io
 * both support scheduled jobs / cron syntax). */
async function runAll(opts = {}) {
  const results = await Promise.all([
    purgeExpiredSessions(opts.sessionRetentionDays),
    purgeStalePushTokens(opts.pushTokenRetentionDays),
  ]);
  return results;
}

module.exports = { purgeExpiredSessions, purgeStalePushTokens, runAll };
