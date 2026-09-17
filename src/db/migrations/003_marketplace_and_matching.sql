-- 003_marketplace_and_matching.sql
-- The centerpiece of this schema: consents.practitioner_match_id is
-- UNIQUE, not disciplines.id. This is the database-level enforcement
-- of the per-practitioner-match consent scoping already implemented
-- client-side in aidh_dashboard.html -- granting access for one Fasting
-- Coach match can never cover a second, different Fasting Coach match,
-- because there is no shared key between them to grant against.

CREATE TYPE consent_status AS ENUM ('active', 'revoked', 'expired');
CREATE TYPE payment_status AS ENUM ('awaiting_confirmed_slot', 'paid', 'failed', 'refunded');

CREATE TABLE disciplines (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug         TEXT NOT NULL UNIQUE,   -- e.g. 'fasting-coach'
    name         TEXT NOT NULL,          -- e.g. 'Fasting Coach'
    tier         SMALLINT NOT NULL CHECK (tier IN (1, 2, 3)),
    description  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE practitioner_disciplines (
    practitioner_id  UUID NOT NULL REFERENCES practitioner_profiles(id) ON DELETE CASCADE,
    discipline_id    UUID NOT NULL REFERENCES disciplines(id) ON DELETE CASCADE,
    PRIMARY KEY (practitioner_id, discipline_id)
);

CREATE TABLE practitioner_matches (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscriber_id             UUID NOT NULL REFERENCES subscriber_profiles(id) ON DELETE CASCADE,
    discipline_id             UUID NOT NULL REFERENCES disciplines(id),
    matched_practitioner_id   UUID REFERENCES practitioner_profiles(id), -- NULL until assigned
    match_reference_code      TEXT NOT NULL UNIQUE, -- e.g. match_fasting-coach_mabc123xy
    is_urgent                 BOOLEAN NOT NULL DEFAULT false,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_matches_subscriber ON practitioner_matches (subscriber_id);

CREATE TABLE consents (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    practitioner_match_id  UUID NOT NULL UNIQUE REFERENCES practitioner_matches(id) ON DELETE CASCADE,
    token_hash             TEXT NOT NULL,
    shared_fields          JSONB NOT NULL DEFAULT '[]',
    status                 consent_status NOT NULL DEFAULT 'active',
    granted_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at             TIMESTAMPTZ NOT NULL,
    revoked_at             TIMESTAMPTZ
);
CREATE INDEX idx_consents_status_expiry ON consents (status, expires_at);

CREATE TABLE booking_requests (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    practitioner_match_id           UUID NOT NULL REFERENCES practitioner_matches(id) ON DELETE CASCADE,
    contact_method                  TEXT NOT NULL,
    contact_value                   TEXT NOT NULL,
    preferred_time_window           TEXT NOT NULL,
    notes                           TEXT,
    payment_agreement_accepted_at   TIMESTAMPTZ,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_request_id      UUID NOT NULL UNIQUE REFERENCES booking_requests(id) ON DELETE CASCADE,
    order_reference          TEXT NOT NULL UNIQUE,
    external_payment_token   TEXT, -- Stripe/Square token reference ONLY. Never a card number, expiry, or CVV.
    payment_status           payment_status NOT NULL DEFAULT 'awaiting_confirmed_slot',
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
