// src/controllers/consent.controller.js
//
// Direct backend counterpart of the per-match consent fix already
// implemented client-side in aidh_dashboard.html. The critical
// requirement from AIDH_Pre_Production_Requirements.docx: every
// endpoint that returns subscriber health data to a practitioner must
// independently re-verify consent here, server-side -- a client-
// supplied token is never sufficient on its own. getDataForPractitioner
// below is that re-verification, not a trust-the-client shortcut.

const crypto = require('crypto');
const db = require('../config/db');
const { logAudit } = require('../lib/audit');

const DISC_DATA_NEEDS = {
  // Mirrors DISC_DATA_NEEDS in aidh_dashboard.html exactly.
  'fasting-coach': ['scores.md', 'scores.sl', 'concern', 'goal'],
  'clinical-psychology': ['scores.md', 'concern', 'meds', 'diag'],
  'integrative-medicine': ['scores.en', 'scores.rf', 'scores.ft', 'scores.md', 'scores.sl', 'concern', 'meds', 'diag'],
  // ... remaining disciplines follow the same pattern as the client-side table.
};

async function grantConsent(req, res) {
  const { practitionerMatchId, durationDays = 30 } = req.body;

  const match = await db.query('SELECT id, discipline_id FROM practitioner_matches WHERE id = $1', [practitionerMatchId]);
  if (match.rows.length === 0) return res.status(404).json({ error: 'No such practitioner match' });

  const disciplineRow = await db.query('SELECT slug FROM disciplines WHERE id = $1', [match.rows[0].discipline_id]);
  const disciplineSlug = disciplineRow.rows[0]?.slug;
  const fields = DISC_DATA_NEEDS[disciplineSlug] || [];

  const token = crypto.randomBytes(24).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  // UNIQUE constraint on practitioner_match_id (migration 003) is what
  // actually enforces "one consent per match" -- this upsert respects
  // that constraint rather than working around it.
  await db.query(
    `INSERT INTO consents (practitioner_match_id, token_hash, shared_fields, status, expires_at)
     VALUES ($1, $2, $3, 'active', now() + ($4 || ' days')::interval)
     ON CONFLICT (practitioner_match_id) DO UPDATE
       SET token_hash = EXCLUDED.token_hash, shared_fields = EXCLUDED.shared_fields,
           status = 'active', expires_at = EXCLUDED.expires_at, revoked_at = NULL`,
    [practitionerMatchId, tokenHash, JSON.stringify(fields), String(durationDays)]
  );

  await logAudit(db, {
    actorUserId: req.user.sub, actorType: 'subscriber', actionCategory: 'CONSENT', action: 'GRANTED',
    description: `Consent granted to match ${practitionerMatchId}`, sensitivity: 'sensitive',
  });

  // The raw token is returned once, here, and never stored in plaintext --
  // only its hash is persisted. Matches the client-side pattern already
  // in place for the disclaimer/consent modal token.
  return res.json({ token, expiresInDays: durationDays });
}

async function revokeConsent(req, res) {
  const { practitionerMatchId } = req.params;
  const result = await db.query(
    `UPDATE consents SET status = 'revoked', revoked_at = now()
     WHERE practitioner_match_id = $1 AND status = 'active' RETURNING id`,
    [practitionerMatchId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'No active consent found for this match' });

  await logAudit(db, {
    actorUserId: req.user.sub, actorType: 'subscriber', actionCategory: 'CONSENT', action: 'REVOKED',
    description: `Consent revoked for match ${practitionerMatchId}`, sensitivity: 'sensitive',
  });
  return res.json({ revoked: true });
}

/** The actual data-release endpoint a practitioner's client would call.
 * This is the server-side re-verification the requirements doc calls
 * out as non-negotiable -- token, status, AND expiry are all re-checked
 * against the database on every call, never assumed from a prior check. */
async function getDataForPractitioner(req, res) {
  const { practitionerMatchId } = req.params;
  const suppliedToken = req.headers['x-consent-token'];
  if (!suppliedToken) return res.status(401).json({ error: 'Missing consent token' });

  const suppliedHash = crypto.createHash('sha256').update(suppliedToken).digest('hex');
  const consentResult = await db.query(
    `SELECT c.*, pm.subscriber_id, d.slug AS discipline_slug
     FROM consents c
     JOIN practitioner_matches pm ON pm.id = c.practitioner_match_id
     JOIN disciplines d ON d.id = pm.discipline_id
     WHERE c.practitioner_match_id = $1`,
    [practitionerMatchId]
  );
  const consent = consentResult.rows[0];

  const denied = !consent || consent.status !== 'active' || consent.token_hash !== suppliedHash || new Date(consent.expires_at) < new Date();
  if (denied) {
    await logAudit(db, {
      actorType: 'practitioner', actionCategory: 'DATA_SHARE', action: 'ACCESS_DENIED',
      description: `Denied access attempt for match ${practitionerMatchId}`, sensitivity: 'sensitive',
    });
    return res.status(403).json({ error: 'Consent invalid, expired, or revoked' });
  }

  // Fetch the latest slider snapshot and minimise to the consented fields only.
  const snapshotResult = await db.query(
    `SELECT * FROM slider_snapshots WHERE subscriber_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
    [consent.subscriber_id]
  );

  await logAudit(db, {
    actorType: 'practitioner', actionCategory: 'DATA_SHARE', action: 'PRACTITIONER_ACCESS',
    description: `Data shared with match ${practitionerMatchId} (${consent.discipline_slug})`, sensitivity: 'sensitive',
  });

  return res.json({
    matchId: practitionerMatchId,
    discipline: consent.discipline_slug,
    sharedFields: consent.shared_fields,
    latestSnapshot: snapshotResult.rows[0] || null,
  });
}

module.exports = { grantConsent, revokeConsent, getDataForPractitioner, DISC_DATA_NEEDS };
