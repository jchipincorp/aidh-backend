-- 001_users_and_identity.sql
-- Identity core: one users table, extended 1:1 by role-specific profile
-- tables. See AIDH_Database_Design.docx Section 2 for the full rationale.

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

CREATE TYPE user_role AS ENUM ('subscriber', 'practitioner', 'admin');
CREATE TYPE subscriber_plan AS ENUM ('trial', 'monthly', 'annual');
CREATE TYPE verification_status AS ENUM ('pending', 'verified', 'rejected');
CREATE TYPE admin_role AS ENUM ('super_admin', 'support', 'case_reviewer');
CREATE TYPE push_platform AS ENUM ('ios', 'android', 'web');

CREATE TABLE users (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email             TEXT NOT NULL UNIQUE,
    password_hash     TEXT NOT NULL,
    role              user_role NOT NULL,
    email_verified_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_users_email_lower ON users (LOWER(email));

CREATE TABLE subscriber_profiles (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    date_of_birth  DATE,
    gp_name        TEXT,
    plan           subscriber_plan NOT NULL DEFAULT 'trial',
    trial_ends_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE practitioner_profiles (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    practitioner_code    TEXT NOT NULL UNIQUE, -- e.g. PRACT-0042
    bio                  TEXT,
    verification_status  verification_status NOT NULL DEFAULT 'pending',
    verified_at          TIMESTAMPTZ,
    verified_by          UUID, -- FK to admin_users, added after that table exists
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    admin_role  admin_role NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE practitioner_profiles
    ADD CONSTRAINT fk_practitioner_verified_by
    FOREIGN KEY (verified_by) REFERENCES admin_users(id);

CREATE TABLE sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL,
    ip_address  TEXT,
    user_agent  TEXT,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE push_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform    push_platform NOT NULL,
    token       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, token)
);
