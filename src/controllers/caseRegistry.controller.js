// src/controllers/caseRegistry.controller.js
const db = require('../config/db');
const { encryptField, decryptField } = require('../lib/fieldEncryption');

async function submitCaseEntry(req, res) {
  const practitioner = await db.query('SELECT id FROM practitioner_profiles WHERE user_id = $1', [req.user.sub]);
  if (practitioner.rows.length === 0) return res.status(404).json({ error: 'No practitioner profile found' });

  const {
    disciplineSlug, subscriberCaseCode, aidhPillar, wellnessCategory, organSystemFocus,
    engagementDuration, wellbeingBefore, wellbeingAfter, changeSummary, labCorroboration,
    clientConsentConfirmed, physicianInvolvementConfirmed, outcomeDisclaimerAck,
  } = req.body;

  const discipline = await db.query('SELECT id FROM disciplines WHERE slug = $1', [disciplineSlug]);
  if (discipline.rows.length === 0) return res.status(404).json({ error: 'Unknown discipline' });

  // Auto-flag for priority review, matching the client-side rule exactly.
  const priorityReview = wellnessCategory === 'Oncology-Adjacent Supportive Care';

  const result = await db.query(
    `INSERT INTO case_entries (
       practitioner_id, discipline_id, subscriber_case_code, aidh_pillar, wellness_category,
       organ_system_focus, engagement_duration, wellbeing_before, wellbeing_after, change_summary,
       lab_corroboration, client_consent_confirmed, physician_involvement_confirmed,
       outcome_disclaimer_ack, priority_review, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending_review')
     RETURNING id, status`,
    // change_summary is encrypted at rest (see migration 006 / fieldEncryption.js) --
    // subscriber_case_code stays plaintext, it's already an anonymised display code.
    [practitioner.rows[0].id, discipline.rows[0].id, subscriberCaseCode, aidhPillar, wellnessCategory,
     organSystemFocus, engagementDuration, wellbeingBefore, wellbeingAfter, encryptField(changeSummary),
     labCorroboration, !!clientConsentConfirmed, !!physicianInvolvementConfirmed,
     !!outcomeDisclaimerAck, priorityReview]
  );
  return res.status(201).json(result.rows[0]);
}

async function listPublishedCases(req, res) {
  const { organSystem } = req.query;
  const params = [];
  let where = `WHERE ce.status = 'published'`;
  if (organSystem) { params.push(organSystem); where += ` AND ce.organ_system_focus = $${params.length}`; }

  // JOINed to practitioner_profiles and disciplines: aidh_case_directory.html's
  // card renderer and its category/organ/pillar filters need a practitioner
  // identifier, discipline (name), engagement_duration, and status, none of
  // which the previous SELECT here returned -- every published entry would
  // have rendered with an undefined practitioner and discipline, and the
  // frontend's own `e.status !== 'published'` client-side guard would have
  // silently hidden every entry, since status was never in the payload for
  // it to check. Found during frontend/backend integration, not the
  // original scaffold pass.
  //
  // practitioner_display_name (migration 007's first_name/last_name,
  // COALESCEd to practitioner_code when a practitioner hasn't completed
  // onboarding yet) replaces what used to be just practitioner_code here.
  // Showing a practitioner's real name on this PUBLIC directory is the
  // expected behavior for a professional marketplace -- the entire point
  // is helping subscribers find and evaluate a real practitioner, the same
  // way Psychology Today or Zocdoc show real names, not anonymised codes.
  // No PHI is exposed either way: practitioner and discipline identifiers
  // are already public by design (this is the public Case-Experience
  // Registry), and subscriber identity was never queryable here in the
  // first place -- see migration 004's note that case_entries has no
  // subscriber_id column.
  const result = await db.query(
    `SELECT ce.id, ce.subscriber_case_code, ce.aidh_pillar, ce.wellness_category, ce.organ_system_focus,
            ce.engagement_duration, ce.wellbeing_before, ce.wellbeing_after, ce.change_summary,
            ce.lab_corroboration, ce.status, ce.submitted_at,
            pp.practitioner_code,
            COALESCE(NULLIF(TRIM(CONCAT(pp.first_name, ' ', pp.last_name)), ''), pp.practitioner_code) AS practitioner_display_name,
            d.name AS discipline
     FROM case_entries ce
     JOIN practitioner_profiles pp ON pp.id = ce.practitioner_id
     JOIN disciplines d ON d.id = ce.discipline_id
     ${where} ORDER BY ce.submitted_at DESC`,
    params
  );
  // Decrypt change_summary for display -- this is the one place published,
  // public-facing case text is read back out (aidh_case_directory.html).
  //
  // Each row's decryption is isolated in its own try/catch. Found via a
  // real-Postgres verification run: if FIELD_ENCRYPTION_KEY ever changes
  // (rotation without re-encrypting old rows -- see README "Compliance
  // hardening") or a single row's ciphertext is corrupted, decryptField()
  // throws GCM's auth-tag failure -- and an unguarded .map() lets ONE bad
  // row crash this ENTIRE endpoint with a 500, taking down the public
  // case directory for every visitor over one row's problem. Now that row
  // is logged and excluded from the response instead of poisoning the
  // whole request; every other, healthy row still renders normally.
  const entries = [];
  for (const row of result.rows) {
    try {
      entries.push({ ...row, change_summary: decryptField(row.change_summary) });
    } catch (err) {
      console.error(`listPublishedCases: failed to decrypt change_summary for case_entries.id=${row.id} -- excluding from public listing.`, err.message);
    }
  }
  return res.json({ entries, count: entries.length });
}

module.exports = { submitCaseEntry, listPublishedCases };
