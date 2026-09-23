-- 007_practitioner_profile_fields.sql
--
-- Closes a gap flagged repeatedly during frontend/backend integration:
-- aidh_practitioner_onboarding.html collects ~31 profile fields (name,
-- location, qualifications, declarations, session logistics, etc.) but
-- practitioner_profiles had nowhere to store almost any of them -- only
-- bio existed. That form's own submitProfile() stayed local-only as a
-- result, and admin's practitioner list had no real display name to
-- show (practitioner_code was the best available stand-in).
--
-- Schema approach: the handful of fields that matter for search, admin
-- review, and public display get real, indexed columns. The long tail
-- of optional, free-form profile detail (session logistics, philosophy,
-- specialisations, disclosures that aren't pass/fail, etc.) goes into a
-- single JSONB column -- standard, sound design for a profile shape
-- with many optional, rarely-queried attributes; adding 20+ individual
-- columns for fields nothing ever filters or sorts by would be schema
-- bloat without a corresponding benefit.
ALTER TABLE practitioner_profiles
  ADD COLUMN first_name              TEXT,
  ADD COLUMN last_name               TEXT,
  ADD COLUMN country                 TEXT,
  ADD COLUMN city                    TEXT,
  ADD COLUMN phone                   TEXT,
  -- Deliberately distinct from users.email: the onboarding form collects
  -- a separate public-facing contact email, which may reasonably differ
  -- from the login email a practitioner authenticates with.
  ADD COLUMN public_contact_email    TEXT,
  ADD COLUMN qualifications          TEXT,
  ADD COLUMN registration_body       TEXT,
  -- Single-select declarations with more than two meaningful states
  -- (e.g. complaints_history has 5 options: none / minor resolved /
  -- formal resolved / sanction with conditions / prefer to discuss) --
  -- stored as the option's own value text, not collapsed to boolean,
  -- so admin review sees the real nuance the practitioner selected.
  ADD COLUMN insurance_status        TEXT,
  ADD COLUMN complaints_history      TEXT,
  -- The one genuinely single-option declaration in the form (a single
  -- "I acknowledge..." checkbox-equivalent) -- boolean fits here.
  ADD COLUMN platform_independence_ack BOOLEAN NOT NULL DEFAULT false,
  -- Everything else the form collects: languages, study/practice years,
  -- CPD, supervision, best-results/limitations text, specialisations,
  -- philosophy, first-session description, product-sales disclosure,
  -- educational disclaimer ack, session formats, response time,
  -- cancellation policy, session expectations, between-sessions
  -- support, video intro URL, patient feedback, website, consult count.
  ADD COLUMN profile_details         JSONB NOT NULL DEFAULT '{}',
  -- Set once, the first time a PATCH includes every field
  -- REQUIRED_FIELDS (aidh_practitioner_onboarding.html) needs -- lets
  -- admin and the practitioner's own UI distinguish "still drafting"
  -- from "submitted for review", independent of verification_status
  -- (which is about admin's decision, not the practitioner's own
  -- completeness).
  ADD COLUMN profile_completed_at    TIMESTAMPTZ,
  ADD COLUMN updated_at              TIMESTAMPTZ NOT NULL DEFAULT now();

COMMENT ON COLUMN practitioner_profiles.profile_details IS
  'Free-form optional profile fields not promoted to their own column -- see migration 007. Keys match aidh_practitioner_onboarding.html field ids (langs, p_study_years, p_practice_years, p_cpd, supervision, p_best_results, p_limitations, specialisations, philosophy, first_session, product_sales, edu_disclaimer, session_formats, response_time, cancellation, session_expectation, between_sessions, p_video_url, p_patient_feedback, p_website, p_consult_count).';
