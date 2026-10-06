// src/controllers/admin.controller.js
//
// Every route using this controller must be behind requireRole('admin')
// -- see routes/admin.routes.js. This replaces the current single
// hardcoded plaintext password shared across aidh_website.html and
// aidh_admin.html (AIDH2026admin) with real, individually accountable
// admin accounts tied to admin_users.admin_role.

const db = require('../config/db');
const { logAudit } = require('../lib/audit');

async function listPractitioners(req, res) {
  const { status } = req.query; // pending_review | verified | rejected
  const params = [];
  let where = '';
  if (status) { params.push(status); where = `WHERE pp.verification_status = $${params.length}`; }

  // Added to close a gap found during frontend/backend integration:
  // aidh_admin.html's practitioner review table already called this out
  // as a known TODO ("In production: GET /api/admin/practitioners") but
  // the endpoint never existed -- verifyPractitioner() above had no way
  // to be reached from real data, only from a fabricated id. Now also
  // returns first_name/last_name/country/city (migration 007) -- when
  // this endpoint was first added, practitioner_profiles had no name
  // field at all and practitioner_code was the best available stand-in;
  // it still is for anyone who hasn't completed onboarding yet, so the
  // frontend falls back to it when first_name/last_name are null.
  const result = await db.query(
    `SELECT pp.id, pp.practitioner_code, pp.bio, pp.verification_status, pp.verified_at, pp.created_at,
            pp.first_name, pp.last_name, pp.country, pp.city, pp.qualifications,
            pp.profile_completed_at, u.email
     FROM practitioner_profiles pp
     JOIN users u ON u.id = pp.user_id
     ${where} ORDER BY pp.created_at DESC`,
    params
  );
  return res.json({ practitioners: result.rows });
}

async function verifyPractitioner(req, res) {
  const { practitionerId } = req.params;
  const { decision } = req.body; // 'verified' | 'rejected'
  if (!['verified', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'verified' or 'rejected'" });
  }

  const adminRow = await db.query('SELECT id FROM admin_users WHERE user_id = $1', [req.user.sub]);
  if (adminRow.rows.length === 0) return res.status(403).json({ error: 'Not an admin account' });

  await db.query(
    `UPDATE practitioner_profiles SET verification_status = $1, verified_at = now(), verified_by = $2 WHERE id = $3`,
    [decision, adminRow.rows[0].id, practitionerId]
  );
  await logAudit(db, {
    actorUserId: req.user.sub, actorType: 'admin', actionCategory: 'PRACTITIONER', action: decision.toUpperCase(),
    description: `Practitioner ${practitionerId} marked ${decision}`,
  });
  return res.json({ practitionerId, decision });
}

async function reviewCaseEntry(req, res) {
  const { caseEntryId } = req.params;
  const { decision, adminNotes } = req.body; // 'published' | 'rejected'
  if (!['published', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'published' or 'rejected'" });
  }

  const adminRow = await db.query('SELECT id FROM admin_users WHERE user_id = $1', [req.user.sub]);
  if (adminRow.rows.length === 0) return res.status(403).json({ error: 'Not an admin account' });

  // The CHECK constraint on case_entries (migration 004) enforces that
  // 'published' cannot be set unless all three consent booleans are
  // already true -- this UPDATE will fail at the database level if that
  // is not the case, not just at the application layer.
  const result = await db.query(
    `UPDATE case_entries SET status = $1, admin_notes = $2, reviewed_by = $3, reviewed_at = now()
     WHERE id = $4 RETURNING id, status`,
    [decision, adminNotes || null, adminRow.rows[0].id, caseEntryId]
  );
  return res.json(result.rows[0]);
}

async function getAuditLog(req, res) {
  const { actionCategory, limit = 100 } = req.query;
  const params = [];
  let where = '';
  if (actionCategory) { params.push(actionCategory); where = `WHERE action_category = $${params.length}`; }
  params.push(Math.min(Number(limit), 500));

  const result = await db.query(
    `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return res.json({ entries: result.rows });
}

module.exports = { listPractitioners, verifyPractitioner, reviewCaseEntry, getAuditLog };
