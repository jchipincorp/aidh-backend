-- 004_case_registry_and_audit.sql

CREATE TYPE lab_corroboration AS ENUM ('not_applicable', 'client_reported_only', 'client_shared_own_lab_results');
CREATE TYPE case_status AS ENUM ('pending_review', 'published', 'rejected');
CREATE TYPE actor_type AS ENUM ('subscriber', 'practitioner', 'admin', 'system');
CREATE TYPE audit_sensitivity AS ENUM ('standard', 'sensitive');

-- Deliberately has NO subscriber_id foreign key anywhere in this table.
-- This is a structural privacy guarantee, not a filter that could be
-- forgotten: a subscriber account deletion has nothing to cascade into
-- here, because there is no link to sever in the first place.
CREATE TABLE case_entries (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    practitioner_id                 UUID NOT NULL REFERENCES practitioner_profiles(id),
    discipline_id                   UUID NOT NULL REFERENCES disciplines(id),
    subscriber_case_code            TEXT NOT NULL, -- anonymised, e.g. CASE-000123
    aidh_pillar                     TEXT NOT NULL,
    wellness_category               TEXT NOT NULL,
    organ_system_focus              TEXT NOT NULL,
    engagement_duration              TEXT,
    wellbeing_before                SMALLINT CHECK (wellbeing_before BETWEEN 1 AND 10),
    wellbeing_after                 SMALLINT CHECK (wellbeing_after BETWEEN 1 AND 10),
    change_summary                  TEXT NOT NULL,
    lab_corroboration               lab_corroboration NOT NULL DEFAULT 'not_applicable',
    client_consent_confirmed        BOOLEAN NOT NULL DEFAULT false,
    physician_involvement_confirmed BOOLEAN NOT NULL DEFAULT false,
    outcome_disclaimer_ack          BOOLEAN NOT NULL DEFAULT false,
    priority_review                 BOOLEAN NOT NULL DEFAULT false,
    status                          case_status NOT NULL DEFAULT 'pending_review',
    admin_notes                     TEXT,
    reviewed_by                     UUID REFERENCES admin_users(id),
    submitted_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at                     TIMESTAMPTZ,
    CONSTRAINT chk_publish_requires_consents CHECK (
        status <> 'published' OR
        (client_consent_confirmed AND physician_involvement_confirmed AND outcome_disclaimer_ack)
    )
);
CREATE INDEX idx_case_entries_status ON case_entries (status);

-- Insert-only. The application's database role must NOT be granted
-- UPDATE or DELETE on this table -- enforce this as a database
-- permission (see db/migrate.js), not only as an application convention.
CREATE TABLE audit_log (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id     UUID REFERENCES users(id), -- NULL for system events or post-deletion anonymisation
    actor_type        actor_type NOT NULL,
    action_category   TEXT NOT NULL,   -- e.g. 'CONSENT'
    action            TEXT NOT NULL,   -- e.g. 'GRANTED'
    description       TEXT,
    sensitivity       audit_sensitivity NOT NULL DEFAULT 'standard',
    ip_address        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_log_actor ON audit_log (actor_user_id, created_at DESC);
CREATE INDEX idx_audit_log_category ON audit_log (action_category, created_at DESC);

CREATE TABLE data_deletion_requests (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscriber_id  UUID NOT NULL, -- intentionally not a FK: the subscriber row may already be gone by completed_at
    requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at   TIMESTAMPTZ
);
