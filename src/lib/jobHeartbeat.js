// src/lib/jobHeartbeat.js -- records and reads the heartbeat of scheduled jobs (migration 015).
// Writing a heartbeat must never break the job it describes, so recordHeartbeat swallows its own errors.
const db = require('../config/db');

async function recordHeartbeat(name, { startedAt, ok, error = null, result = null }) {
  try {
    await db.query(
      `INSERT INTO job_heartbeats (job_name, last_started_at, last_finished_at, last_ok, last_error, last_result)
       VALUES ($1, $2, now(), $3, $4, $5)
       ON CONFLICT (job_name) DO UPDATE SET last_started_at = EXCLUDED.last_started_at, last_finished_at = now(),
         last_ok = EXCLUDED.last_ok, last_error = EXCLUDED.last_error, last_result = EXCLUDED.last_result`,
      [name, startedAt || new Date(), !!ok, error, result ? JSON.stringify(result) : null]);
  } catch (e) { console.error('could not record the job heartbeat:', e.message); }
}

/** 'never-run' | 'ok' | 'stale' (nothing has finished within JOBS_STALE_AFTER_SECONDS, default 900) | 'failing'. */
async function jobStatus(name = 'consultations', nowMs = Date.now()) {
  const r = await db.query('SELECT last_finished_at, last_ok FROM job_heartbeats WHERE job_name = $1', [name]);
  if (!r.rows.length || !r.rows[0].last_finished_at) return 'never-run';
  const staleAfterMs = (parseInt(process.env.JOBS_STALE_AFTER_SECONDS, 10) || 900) * 1000;
  if (nowMs - new Date(r.rows[0].last_finished_at).getTime() > staleAfterMs) return 'stale';
  return r.rows[0].last_ok ? 'ok' : 'failing';
}

module.exports = { recordHeartbeat, jobStatus };
