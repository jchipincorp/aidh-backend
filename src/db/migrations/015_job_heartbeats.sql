-- 015_job_heartbeats.sql
--
-- A heartbeat for scheduled jobs. The consultation job frees unpaid holds and RELEASES PAYOUTS; if the scheduler stops,
-- practitioners are not paid and held payments sit, silently. Each pass records when it started, when it finished and
-- whether it succeeded, so GET /api/ready can report the job as 'ok', 'stale' (not finished recently) or 'failing'
-- and a monitor can alert on it. last_result is TEXT (a JSON summary), deliberately holding no personal data.

CREATE TABLE job_heartbeats (
    job_name         TEXT PRIMARY KEY,
    last_started_at  TIMESTAMPTZ,
    last_finished_at TIMESTAMPTZ,
    last_ok          BOOLEAN,
    last_error       TEXT,
    last_result      TEXT
);
