-- 013_practitioner_agreement.sql
--
-- Practitioners must accept the Practitioner Agreement before they can be booked. The Terms say AIDH collects
-- payments as a limited payment collection agent for the practitioner; that appointment is made in the
-- agreement, so nobody should be bookable without having accepted it.
--
-- agreement_version / agreement_accepted_at record WHICH version a practitioner accepted and WHEN. The server's
-- current version (PRACTITIONER_AGREEMENT_VERSION, default 'DRAFT-1' = a clearly marked placeholder until
-- counsel's final text exists) decides what counts as accepted: change the version and every practitioner has to
-- accept again before they can be booked. Each booking records the version in force when it was made.

ALTER TABLE practitioner_booking_settings ADD COLUMN agreement_version TEXT;
ALTER TABLE practitioner_booking_settings ADD COLUMN agreement_accepted_at TIMESTAMPTZ;
ALTER TABLE consultation_bookings ADD COLUMN practitioner_agreement_version TEXT;
