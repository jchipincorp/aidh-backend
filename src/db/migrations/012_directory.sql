-- 012_directory.sql
--
-- The public practitioner directory. Decided with the product owner: cards show name, credentials,
-- location and a headshot -- and only for practitioners who explicitly agree. The agreement is a
-- timestamp (directory_consent_at): no timestamp, not listed, and the photo is not served publicly.
--
-- Headshots are small JPEGs the practitioner uploads (resized in their browser). The server checks
-- the file is really a JPEG, strips EXIF/XMP/IPTC/comment segments, and caps the size. They are kept
-- here as base64 text so the platform needs no separate file store.

ALTER TABLE practitioner_booking_settings ADD COLUMN directory_consent_at TIMESTAMPTZ;

CREATE TABLE practitioner_photos (
    practitioner_id UUID PRIMARY KEY REFERENCES practitioner_profiles(id) ON DELETE CASCADE,
    content_type    TEXT NOT NULL CHECK (content_type = 'image/jpeg'),
    data_base64     TEXT NOT NULL,
    byte_size       INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 150000),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
