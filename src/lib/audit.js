// src/lib/audit.js
//
// The only code path allowed to write to audit_log. Insert-only by
// design -- see migration 004 for the matching database-level
// permission requirement (the app's db role must not have UPDATE or
// DELETE grants on this table).

async function logAudit(db, { actorUserId = null, actorType, actionCategory, action, description = null, sensitivity = 'standard', ipAddress = null }) {
  await db.query(
    `INSERT INTO audit_log (actor_user_id, actor_type, action_category, action, description, sensitivity, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actorUserId, actorType, actionCategory, action, description, sensitivity, ipAddress]
  );
}

module.exports = { logAudit };
