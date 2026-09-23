// src/controllers/subscriber.controller.js
const db = require('../config/db');
const { logAudit } = require('../lib/audit');
const { computeAll } = require('../lib/scoring');
const { encryptField } = require('../lib/fieldEncryption');

async function recordSliders(req, res) {
  const { en, rf, ft, md, sl } = req.body;
  const values = [en, rf, ft, md, sl];
  if (values.some((v) => typeof v !== 'number' || v < 0 || v > 100)) {
    return res.status(400).json({ error: 'All five slider values must be numbers between 0 and 100' });
  }

  const profile = await db.query('SELECT id FROM subscriber_profiles WHERE user_id = $1', [req.user.sub]);
  if (profile.rows.length === 0) return res.status(404).json({ error: 'No subscriber profile found' });
  const subscriberId = profile.rows[0].id;

  // Insert-only -- never UPDATE an existing row. This is what makes
  // historical score reconstruction possible without a schema change.
  const inserted = await db.query(
    `INSERT INTO slider_snapshots (subscriber_id, en_value, rf_value, ft_value, md_value, sl_value)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, recorded_at`,
    [subscriberId, en, rf, ft, md, sl]
  );

  const snapshot = inserted.rows[0];
  const scores = computeAll({ en, rf, ft, md, sl });

  // Optional cache -- explicitly tied to this snapshot's id, never edited independently.
  await db.query(
    `INSERT INTO computed_scores_cache (slider_snapshot_id, scores_json) VALUES ($1, $2)`,
    [snapshot.id, JSON.stringify(scores)]
  );

  return res.status(201).json({ snapshotId: snapshot.id, recordedAt: snapshot.recorded_at, scores });
}

async function getLatestSnapshot(req, res) {
  const profile = await db.query('SELECT id FROM subscriber_profiles WHERE user_id = $1', [req.user.sub]);
  if (profile.rows.length === 0) return res.status(404).json({ error: 'No subscriber profile found' });

  const result = await db.query(
    `SELECT * FROM slider_snapshots WHERE subscriber_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
    [profile.rows[0].id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'No slider data recorded yet' });

  const snap = result.rows[0];
  const scores = computeAll({ en: snap.en_value, rf: snap.rf_value, ft: snap.ft_value, md: snap.md_value, sl: snap.sl_value });
  return res.json({ snapshot: snap, scores });
}

/** The reconciliation field discussed and intentionally not yet wired
 * into the frontend. Hard rule enforced here, not just documented:
 * this handler only ever INSERTs into lab_results -- no code path in
 * this file reads lab_results back into a scoring calculation. */
async function recordLabResult(req, res) {
  const { biomarkerCode, value, unit, resultDate } = req.body;
  const profile = await db.query('SELECT id FROM subscriber_profiles WHERE user_id = $1', [req.user.sub]);
  if (profile.rows.length === 0) return res.status(404).json({ error: 'No subscriber profile found' });

  // value is encrypted at rest (see migration 006 / fieldEncryption.js). unit
  // stays plaintext -- a unit label like "mg/L" isn't identifying on its own.
  const result = await db.query(
    `INSERT INTO lab_results (subscriber_id, biomarker_code, value, unit, result_date, source)
     VALUES ($1, $2, $3, $4, $5, 'self_reported') RETURNING id`,
    [profile.rows[0].id, biomarkerCode, encryptField(value), unit, resultDate]
  );
  return res.status(201).json({ id: result.rows[0].id });
}

/** GDPR/CCPA deletion. Health data is hard-deleted via ON DELETE CASCADE
 * from users -> subscriber_profiles -> slider_snapshots/lab_results.
 * audit_log is deliberately NOT cascaded -- the actor reference is kept
 * for compliance retention, per AIDH_Database_Design.docx Section 7. */
async function deleteMyAccount(req, res) {
  await db.query(`INSERT INTO data_deletion_requests (subscriber_id) VALUES ($1)`, [req.user.sub]);
  await logAudit(db, {
    actorUserId: req.user.sub, actorType: 'subscriber', actionCategory: 'ACCOUNT', action: 'DELETION_REQUESTED', sensitivity: 'sensitive',
  });

  await db.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [req.user.sub]);
  await db.query(`DELETE FROM users WHERE id = $1`, [req.user.sub]); // cascades to health data

  await db.query(`UPDATE data_deletion_requests SET completed_at = now() WHERE subscriber_id = $1`, [req.user.sub]);
  return res.json({ deleted: true });
}

module.exports = { recordSliders, getLatestSnapshot, recordLabResult, deleteMyAccount };
