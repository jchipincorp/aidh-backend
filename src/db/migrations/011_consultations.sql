-- 011_consultations.sql
--
-- Instant-booking consultations: a subscriber picks a time from a practitioner's published
-- availability, pays at booking, and the practitioner's share is released after the session.
-- Runs alongside (does not replace) the older booking_requests / orders tables, which the
-- request-based flow still uses until the frontend moves over.
--
-- What is deliberately NOT stored here: nothing about the subscriber's health. A booking
-- records who booked, with whom, when, and the money. There is no notes box. The shared
-- video link lives in the practitioner's settings (one row), never copied onto bookings.
--
-- Money model (decided with the product owner): the subscriber pays AIDH at booking; the
-- funds are held; AIDH keeps 25% of the gross; the practitioner receives 75% of the gross
-- MINUS Stripe's processing fee, released 24 hours after the session ends unless the
-- subscriber reported a problem. platform_fee_cents + practitioner_share_cents = amount_cents.

CREATE TABLE practitioner_booking_settings (
    practitioner_id          UUID PRIMARY KEY REFERENCES practitioner_profiles(id) ON DELETE CASCADE,
    session_price_cents      INTEGER CHECK (session_price_cents IS NULL OR (session_price_cents >= 100 AND session_price_cents <= 1000000)),
    premium_price_cents      INTEGER CHECK (premium_price_cents IS NULL OR (premium_price_cents >= 100 AND premium_price_cents <= 1000000)),
    currency                 TEXT NOT NULL DEFAULT 'usd',
    session_minutes          INTEGER NOT NULL DEFAULT 30 CHECK (session_minutes >= 15 AND session_minutes <= 120),
    timezone                 TEXT NOT NULL DEFAULT 'UTC',
    -- The practitioner's own standing video room (Google Meet, Zoom, etc.). Shared-link
    -- safeguards: https only; revealed only to the booked subscriber after payment;
    -- host_admits_ack records the practitioner's confirmation that they admit each person
    -- individually; the link must be re-confirmed periodically (video_link_confirmed_at).
    video_link               TEXT,
    video_link_confirmed_at  TIMESTAMPTZ,
    host_admits_ack          BOOLEAN NOT NULL DEFAULT false,
    accepting_bookings       BOOLEAN NOT NULL DEFAULT false,
    -- Stripe Connect Express account. Identity, bank and tax details live at Stripe only.
    stripe_account_id        TEXT,
    stripe_payouts_enabled   BOOLEAN NOT NULL DEFAULT false,
    stripe_details_submitted BOOLEAN NOT NULL DEFAULT false,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE practitioner_availability (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    practitioner_id UUID NOT NULL REFERENCES practitioner_profiles(id) ON DELETE CASCADE,
    weekday         INTEGER NOT NULL CHECK (weekday >= 0 AND weekday <= 6),      -- 0 = Sunday, in the practitioner's timezone
    start_minute    INTEGER NOT NULL CHECK (start_minute >= 0 AND start_minute <= 1439),
    end_minute      INTEGER NOT NULL CHECK (end_minute >= 1 AND end_minute <= 1440),
    CHECK (end_minute > start_minute)
);
CREATE INDEX idx_practitioner_availability_practitioner ON practitioner_availability (practitioner_id);

CREATE TABLE consultation_bookings (
    id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscriber_id              UUID NOT NULL REFERENCES subscriber_profiles(id) ON DELETE CASCADE,
    practitioner_id            UUID NOT NULL REFERENCES practitioner_profiles(id) ON DELETE CASCADE,
    starts_at                  TIMESTAMPTZ NOT NULL,
    ends_at                    TIMESTAMPTZ NOT NULL,
    status                     TEXT NOT NULL CHECK (status IN ('held','confirmed','completed','cancelled','expired','disputed')),
    amount_cents               INTEGER NOT NULL CHECK (amount_cents > 0),
    currency                   TEXT NOT NULL,
    price_basis                TEXT NOT NULL CHECK (price_basis IN ('standard','premium')),
    platform_fee_cents         INTEGER NOT NULL,
    practitioner_share_cents   INTEGER NOT NULL,
    stripe_fee_cents           INTEGER,
    practitioner_payout_cents  INTEGER,
    -- Double-booking guard. Set to "<practitioner id>|<start ms>" while the slot is held or
    -- booked; set to NULL when it is freed (expired, cancelled). UNIQUE, and NULLs do not
    -- collide, so the database itself refuses a second active booking for the same slot.
    slot_key                   TEXT UNIQUE,
    hold_expires_at            TIMESTAMPTZ,
    stripe_checkout_session_id TEXT UNIQUE,
    stripe_payment_intent_id   TEXT,
    stripe_charge_id           TEXT,
    stripe_transfer_id         TEXT,
    confirmed_at               TIMESTAMPTZ,
    completed_at               TIMESTAMPTZ,
    release_after              TIMESTAMPTZ,
    released_at                TIMESTAMPTZ,
    cancelled_at               TIMESTAMPTZ,
    cancelled_by               TEXT CHECK (cancelled_by IS NULL OR cancelled_by IN ('subscriber','practitioner','system')),
    refund_cents               INTEGER NOT NULL DEFAULT 0,
    issue_reported_at          TIMESTAMPTZ,
    issue_resolved_at          TIMESTAMPTZ,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_consultation_bookings_subscriber ON consultation_bookings (subscriber_id);
CREATE INDEX idx_consultation_bookings_practitioner ON consultation_bookings (practitioner_id);
CREATE INDEX idx_consultation_bookings_status ON consultation_bookings (status);
