// src/controllers/admin.controller.js
//
// Every route using this controller must be behind requireRole('admin')
// -- see routes/admin.routes.js. This replaces the current single
// hardcoded plaintext password shared across aidh_website.html and
// aidh_admin.html (AIDH2026admin) with real, individually accountable
// admin accounts tied to admin_users.admin_role.

const db = require('../config/db');
const { logAudit } = require('../lib/audit');
const { decryptField } = require('../lib/fieldEncryption');
const { disputeReasonLabel } = require('../lib/disputeReasons');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CASE_STATUSES = ['pending_review', 'published', 'rejected'];
const CONSENT_FIELDS = [
  ['client_consent_confirmed', 'client consent'],
  ['physician_involvement_confirmed', 'physician involvement'],
  ['outcome_disclaimer_ack', 'outcome disclaimer'],
];
const ADMIN_NOTES_MAX = 2000;
const ref = (id) => String(id).slice(0, 8).toUpperCase();

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

/** The review queue for practitioner-submitted case entries (route: super_admin and case_reviewer).
 *  ?status=pending_review (default) | published | rejected | all. The reviewer has to read the case text to
 *  judge it, so change_summary is decrypted here; a row that cannot be decrypted is still listed (flagged),
 *  never hidden, so it does not silently sit in the queue forever. Pending entries come oldest first with
 *  priority-review entries ahead; the others newest first. At most 200 per call (truncated: true if more). */
async function listCaseEntries(req, res) {
  const status = req.query.status || 'pending_review';
  if (status !== 'all' && !CASE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${CASE_STATUSES.join(', ')}, all` });
  }
  const params = [];
  let where = '';
  if (status !== 'all') { params.push(status); where = `WHERE ce.status = $${params.length}`; }
  const result = await db.query(
    `SELECT ce.id, ce.subscriber_case_code, ce.aidh_pillar, ce.wellness_category, ce.organ_system_focus,
            ce.engagement_duration, ce.wellbeing_before, ce.wellbeing_after, ce.change_summary, ce.lab_corroboration,
            ce.client_consent_confirmed, ce.physician_involvement_confirmed, ce.outcome_disclaimer_ack,
            ce.priority_review, ce.status, ce.admin_notes, ce.submitted_at, ce.reviewed_at,
            pp.practitioner_code, pp.verification_status AS practitioner_verification_status,
            COALESCE(NULLIF(TRIM(CONCAT(pp.first_name, ' ', pp.last_name)), ''), pp.practitioner_code) AS practitioner_display_name,
            d.name AS discipline
     FROM case_entries ce
     JOIN practitioner_profiles pp ON pp.id = ce.practitioner_id
     JOIN disciplines d ON d.id = ce.discipline_id
     ${where}
     ${status === 'pending_review' ? 'ORDER BY ce.priority_review DESC, ce.submitted_at ASC' : 'ORDER BY ce.submitted_at DESC'}
     LIMIT 201`,
    params
  );
  const rows = result.rows;
  const entries = rows.slice(0, 200).map((row) => {
    const missingConsents = CONSENT_FIELDS.filter(([col]) => !row[col]).map(([, label]) => label);
    try {
      return { ...row, change_summary: decryptField(row.change_summary), decrypt_failed: false, missing_consents: missingConsents };
    } catch (err) {
      console.error(`listCaseEntries: could not decrypt change_summary for case_entries.id=${row.id}`, err.message);
      return { ...row, change_summary: null, decrypt_failed: true, missing_consents: missingConsents };
    }
  });
  return res.json({ status, entries, count: entries.length, truncated: rows.length > entries.length });
}

/** Publish or reject one case entry (route: super_admin and case_reviewer). A published entry can be taken
 *  down (rejected) and a rejected one reconsidered. Checks, in order: a well-formed id that exists (404);
 *  the three consents before publishing (409 naming what is missing, rather than letting the database CHECK
 *  turn it into a 500); not already in that state (409); and nobody else changed it since it was read (409).
 *  Optional expectedStatus: the status the caller's screen showed; if the entry has moved on since, 409 and nothing
 *  changes, so a decision is never applied to a state the reviewer did not see.
 *  Every decision is written to the audit log without any of the case text. */
async function reviewCaseEntry(req, res) {
  const { caseEntryId } = req.params;
  const { decision, expectedStatus } = req.body || {};
  let { adminNotes } = req.body || {};
  if (!['published', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'published' or 'rejected'" });
  }
  if (expectedStatus !== undefined && !CASE_STATUSES.includes(expectedStatus)) {
    return res.status(400).json({ error: `expectedStatus must be one of: ${CASE_STATUSES.join(', ')}` });
  }
  if (adminNotes !== undefined && adminNotes !== null && typeof adminNotes !== 'string') {
    return res.status(400).json({ error: 'adminNotes must be text' });
  }
  adminNotes = adminNotes ? adminNotes.trim() : '';
  if (adminNotes.length > ADMIN_NOTES_MAX) {
    return res.status(400).json({ error: `adminNotes must be ${ADMIN_NOTES_MAX} characters or fewer` });
  }
  if (!UUID_RE.test(caseEntryId)) return res.status(404).json({ error: 'Case entry not found' });

  const found = await db.query(
    `SELECT id, status, client_consent_confirmed, physician_involvement_confirmed, outcome_disclaimer_ack
     FROM case_entries WHERE id = $1`, [caseEntryId]);
  const entry = found.rows[0];
  if (!entry) return res.status(404).json({ error: 'Case entry not found' });
  // The status the reviewer's screen was showing. Without it, "Reject" on an entry another reviewer had just
  // published would silently become a take-down (seen on real PostgreSQL). The console always sends it.
  if (expectedStatus !== undefined && entry.status !== expectedStatus) {
    return res.status(409).json({ error: `This entry changed since you loaded it (it is now ${entry.status.replace('_', ' ')}). Reload to see its current state.`, currentStatus: entry.status });
  }

  if (decision === 'published') {
    const missing = CONSENT_FIELDS.filter(([col]) => !entry[col]).map(([, label]) => label);
    if (missing.length) {
      return res.status(409).json({ error: `This entry cannot be published: the practitioner did not confirm ${missing.join(', ')}.`, missingConsents: missing });
    }
  }
  if (entry.status === decision) {
    return res.status(409).json({ error: `This entry is already ${decision}.` });
  }

  const result = await db.query(
    `UPDATE case_entries SET status = $1, admin_notes = $2, reviewed_by = $3, reviewed_at = now()
     WHERE id = $4 AND status = $5 RETURNING id, status, reviewed_at`,
    [decision, adminNotes || null, req.admin.id, caseEntryId, entry.status]
  );
  if (result.rows.length === 0) {
    return res.status(409).json({ error: 'Someone else changed this entry while you were reviewing it. Reload to see its current state.' });
  }
  const action = decision === 'published' ? 'PUBLISHED' : (entry.status === 'published' ? 'UNPUBLISHED' : 'REJECTED');
  await logAudit(db, {
    actorUserId: req.user.sub, actorType: 'admin', actionCategory: 'CASE_ENTRY', action,
    description: `Case entry ${ref(caseEntryId)}: ${entry.status} -> ${decision}`,
  });
  return res.json({ ...result.rows[0], previousStatus: entry.status });
}

/** Bookings a subscriber reported a problem with (route: super_admin and support).
 *  ?state=open (default: still disputed) | resolved | all. Includes both parties' emails, because deciding a
 *  dispute fairly means hearing from both of them, and nothing about anyone's health (bookings hold none). */
async function listDisputes(req, res) {
  const state = req.query.state || 'open';
  if (!['open', 'resolved', 'all'].includes(state)) {
    return res.status(400).json({ error: 'state must be one of: open, resolved, all' });
  }
  let where = 'WHERE cb.issue_reported_at IS NOT NULL';
  if (state === 'open') where += ` AND cb.status = 'disputed'`;
  if (state === 'resolved') where += ` AND cb.status <> 'disputed'`;
  const result = await db.query(
    `SELECT cb.id, cb.status, cb.starts_at, cb.ends_at, cb.amount_cents, cb.currency, cb.price_basis,
            cb.platform_fee_cents, cb.practitioner_share_cents, cb.stripe_fee_cents, cb.practitioner_payout_cents,
            cb.refund_cents, cb.issue_reported_at, cb.issue_resolved_at, cb.completed_at, cb.released_at,
            cb.cancelled_at, cb.cancelled_by, cb.issue_reason,
            pp.id AS practitioner_id, pp.practitioner_code, pp.first_name, pp.last_name, pu.email AS practitioner_email,
            su.email AS subscriber_email
     FROM consultation_bookings cb
     JOIN practitioner_profiles pp ON pp.id = cb.practitioner_id
     JOIN users pu ON pu.id = pp.user_id
     JOIN subscriber_profiles sp ON sp.id = cb.subscriber_id
     JOIN users su ON su.id = sp.user_id
     ${where}
     ${state === 'open' ? 'ORDER BY cb.issue_reported_at ASC' : 'ORDER BY cb.issue_reported_at DESC'}
     LIMIT 201`
  );
  const disputes = result.rows
    .slice(0, 200)
    .map((r) => ({
      id: r.id,
      ref: ref(r.id),
      status: r.status,
      outcome: r.status === 'disputed' ? null : (r.status === 'cancelled' ? 'refunded' : 'released'),
      startsAt: r.starts_at, endsAt: r.ends_at,
      amountCents: r.amount_cents, currency: r.currency, priceBasis: r.price_basis,
      platformFeeCents: r.platform_fee_cents, practitionerShareCents: r.practitioner_share_cents,
      stripeFeeCents: r.stripe_fee_cents, practitionerPayoutCents: r.practitioner_payout_cents,
      refundCents: r.refund_cents,
      issueReportedAt: r.issue_reported_at, issueResolvedAt: r.issue_resolved_at,
      reason: r.issue_reason ? { code: r.issue_reason, label: disputeReasonLabel(r.issue_reason) } : null,
      practitionerMarkedCompleteAt: r.status === 'disputed' ? r.completed_at : null,
      releasedAt: r.released_at, cancelledAt: r.cancelled_at,
      practitioner: { id: r.practitioner_id, code: r.practitioner_code, name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.practitioner_code, email: r.practitioner_email },
      subscriber: { email: r.subscriber_email },
    }));
  return res.json({ state, disputes, count: disputes.length, truncated: result.rows.length > disputes.length });
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

module.exports = { listPractitioners, verifyPractitioner, listCaseEntries, reviewCaseEntry, listDisputes, getAuditLog };
