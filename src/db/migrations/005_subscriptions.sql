-- 005_subscriptions.sql
-- No column in this table, or anywhere in this schema, stores a raw
-- card number, expiry date, or CVV. Only external processor references.

CREATE TYPE external_processor AS ENUM ('stripe', 'square');
CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'canceled');

CREATE TABLE subscriptions (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscriber_id                UUID NOT NULL UNIQUE REFERENCES subscriber_profiles(id) ON DELETE CASCADE,
    external_processor           external_processor NOT NULL,
    external_customer_id         TEXT NOT NULL,
    external_subscription_id     TEXT,
    status                       subscription_status NOT NULL DEFAULT 'trialing',
    current_period_end           TIMESTAMPTZ,
    created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
    canceled_at                  TIMESTAMPTZ
);
