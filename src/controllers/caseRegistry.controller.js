// src/controllers/caseRegistry.controller.js
const db = require('../config/db');

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
    [practitioner.rows[0].id, discipline.rows[0].id, subscriberCaseCode, aidhPillar, wellnessCategory,
     organSystemFocus, engagementDuration, wellbeingBefore, wellbeingAfter, changeSummary,
     labCorroboration, !!clientConsentConfirmed, !!physicianInvolvementConfirmed,
     !!outcomeDisclaimerAck, priorityReview]
  );
  return res.status(201).json(result.rows[0]);
}

async function listPublishedCases(req, res) {
  const { organSystem } = req.query;
  const params = [];
  let where = `WHERE status = 'published'`;
  if (organSystem) { params.push(organSystem); where += ` AND organ_system_focus = $${params.length}`; }

  const result = await db.query(
    `SELECT id, subscriber_case_code, aidh_pillar, wellness_category, organ_system_focus,
            wellbeing_before, wellbeing_after, change_summary, lab_corroboration, submitted_at
     FROM case_entries ${where} ORDER BY submitted_at DESC`,
    params
  );
  return res.json({ entries: result.rows, count: result.rows.length });
}

module.exports = { submitCaseEntry, listPublishedCases };
