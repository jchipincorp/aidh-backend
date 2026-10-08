// src/lib/consultationJobs.js
// Scheduled work for consultations: free unpaid holds, release practitioner shares that are
// due. Run from a scheduler (cron, a hosting platform's scheduled task) via
// scripts/run-consultation-jobs.js, or in-process by setting CONSULTATION_JOBS_INTERVAL_MS.
// Every pass records a heartbeat (migration 015) so a stalled or failing payout job is visible at GET /api/ready.
const c = require('../controllers/consultations.controller');
const { recordHeartbeat } = require('./jobHeartbeat');

async function runConsultationJobs(nowMs = Date.now()) {
  const startedAt = new Date();
  try {
    const expiredHolds = await c.expireStaleHolds(nowMs);
    const release = await c.releaseDueBookings(nowMs);
    const result = { expiredHolds, ...release };
    const failed = release && release.failures && release.failures.length;
    await recordHeartbeat('consultations', { startedAt, ok: !failed, error: failed ? `${failed} release failure(s)` : null, result });
    return result;
  } catch (e) {
    await recordHeartbeat('consultations', { startedAt, ok: false, error: e.message });
    throw e;
  }
}
module.exports = { runConsultationJobs };
