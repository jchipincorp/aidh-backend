// src/controllers/practitioner.controller.js
//
// The real backend counterpart to aidh_practitioner_onboarding.html's
// profile form, which previously had no endpoint to call at all -- see
// migration 007 for why the schema was extended rather than reusing
// bio for everything.

const db = require('../config/db');
const { logAudit } = require('../lib/audit');

// Mirrors aidh_practitioner_onboarding.html's REQUIRED_FIELDS, translated
// to the request-body field names this endpoint accepts (see the mapping
// comment in updateProfile below). Used only to decide whether to stamp
// profile_completed_at -- every field here is optional at the database
// level (a practitioner can save a partial draft at any point); this is
// about detecting "the practitioner has now supplied everything the
// frontend's own form requires", not enforcing it server-side.
const REQUIRED_FOR_COMPLETION = [
  'firstName', 'lastName', 'country', 'city', 'publicContactEmail',
  'qualifications', 'registrationBody', 'insuranceStatus',
  'complaintsHistory', 'platformIndependenceAck',
];

function parseProfileDetails(value) {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch (e) {
    return {};
  }
}

function rowToApiShape(row) {
  return {
    firstName: row.first_name,
    lastName: row.last_name,
    country: row.country,
    city: row.city,
    phone: row.phone,
    publicContactEmail: row.public_contact_email,
    qualifications: row.qualifications,
    registrationBody: row.registration_body,
    insuranceStatus: row.insurance_status,
    complaintsHistory: row.complaints_history,
    platformIndependenceAck: row.platform_independence_ack,
    bio: row.bio,
    profileDetails: parseProfileDetails(row.profile_details),
    practitionerCode: row.practitioner_code,
    verificationStatus: row.verification_status,
    profileCompletedAt: row.profile_completed_at,
  };
}

async function getProfile(req, res) {
  const result = await db.query('SELECT * FROM practitioner_profiles WHERE user_id = $1', [req.user.sub]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'No practitioner profile found' });
  return res.json(rowToApiShape(result.rows[0]));
}

async function updateProfile(req, res) {
  const existing = await db.query('SELECT * FROM practitioner_profiles WHERE user_id = $1', [req.user.sub]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'No practitioner profile found' });
  const current = existing.rows[0];

  const {
    firstName, lastName, country, city, phone, publicContactEmail,
    qualifications, registrationBody, insuranceStatus, complaintsHistory,
    platformIndependenceAck, bio, profileDetails,
  } = req.body;

  // Partial update: only overwrite a column if the request actually
  // supplied it (undefined leaves the existing value alone), so a
  // practitioner can save incremental progress without resending the
  // whole form every time.
  const next = {
    first_name: firstName !== undefined ? firstName : current.first_name,
    last_name: lastName !== undefined ? lastName : current.last_name,
    country: country !== undefined ? country : current.country,
    city: city !== undefined ? city : current.city,
    phone: phone !== undefined ? phone : current.phone,
    public_contact_email: publicContactEmail !== undefined ? publicContactEmail : current.public_contact_email,
    qualifications: qualifications !== undefined ? qualifications : current.qualifications,
    registration_body: registrationBody !== undefined ? registrationBody : current.registration_body,
    insurance_status: insuranceStatus !== undefined ? insuranceStatus : current.insurance_status,
    complaints_history: complaintsHistory !== undefined ? complaintsHistory : current.complaints_history,
    platform_independence_ack: platformIndependenceAck !== undefined ? !!platformIndependenceAck : current.platform_independence_ack,
    bio: bio !== undefined ? bio : current.bio,
    // profileDetails merges shallowly into the existing JSONB rather than
    // replacing it wholesale -- a practitioner filling in one more
    // optional field later shouldn't wipe out ones saved earlier.
    // current.profile_details is normally already a parsed object (the pg
    // driver parses JSONB columns automatically) -- but a freshly-inserted
    // row's DEFAULT '{}' value can come back as the literal two-character
    // string "{}" rather than {} depending on driver/environment. Merging
    // a string via Object.assign spreads its characters as numeric keys
    // (0:'{', 1:'}') instead of treating it as empty JSON, corrupting
    // every profile from its very first save. Parsed defensively here so
    // the merge is correct regardless of which representation came back.
    profile_details: profileDetails !== undefined
      ? Object.assign({}, parseProfileDetails(current.profile_details), profileDetails)
      : parseProfileDetails(current.profile_details),
  };

  // Translate the same required-field check the frontend's own
  // updateProgress() runs, so profile_completed_at reflects "the
  // practitioner has now supplied everything the form requires" using
  // the post-update values, not a re-fetch.
  const nextApiShape = {
    firstName: next.first_name, lastName: next.last_name, country: next.country,
    city: next.city, publicContactEmail: next.public_contact_email,
    qualifications: next.qualifications, registrationBody: next.registration_body,
    insuranceStatus: next.insurance_status, complaintsHistory: next.complaints_history,
    platformIndependenceAck: next.platform_independence_ack,
  };
  const nowComplete = REQUIRED_FOR_COMPLETION.every((f) => {
    const v = nextApiShape[f];
    return v !== null && v !== undefined && v !== '' && v !== false;
  });
  const profileCompletedAt = current.profile_completed_at || (nowComplete ? new Date() : null);

  const result = await db.query(
    `UPDATE practitioner_profiles SET
       first_name = $1, last_name = $2, country = $3, city = $4, phone = $5,
       public_contact_email = $6, qualifications = $7, registration_body = $8,
       insurance_status = $9, complaints_history = $10, platform_independence_ack = $11,
       bio = $12, profile_details = $13, profile_completed_at = $14, updated_at = now()
     WHERE user_id = $15
     RETURNING *`,
    [
      next.first_name, next.last_name, next.country, next.city, next.phone,
      next.public_contact_email, next.qualifications, next.registration_body,
      next.insurance_status, next.complaints_history, next.platform_independence_ack,
      next.bio, JSON.stringify(next.profile_details), profileCompletedAt, req.user.sub,
    ]
  );

  const justCompleted = !current.profile_completed_at && !!profileCompletedAt;
  await logAudit(db, {
    actorUserId: req.user.sub, actorType: 'practitioner', actionCategory: 'PRACTITIONER',
    action: justCompleted ? 'PROFILE_COMPLETED' : 'PROFILE_UPDATED',
  });

  return res.json(rowToApiShape(result.rows[0]));
}

module.exports = { getProfile, updateProfile };
