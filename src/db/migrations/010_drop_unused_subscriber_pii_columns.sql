-- 010_drop_unused_subscriber_pii_columns.sql
--
-- subscriber_profiles.date_of_birth and subscriber_profiles.gp_name came in with
-- migration 001 for an onboarding design that was later removed: the Personal
-- Details and Health Context screens that asked for them no longer exist. Checked
-- directly before writing this: no controller reads or writes either column, no
-- test references them, and every query on this table names the columns it needs
-- (none is SELECT *), so neither was ever sent to a browser. They are empty in any
-- database built from this code.
--
-- A column that exists is a promise that it can be filled. Dropping them makes the
-- schema say what the platform actually does: it does not collect a subscriber's
-- date of birth or physician's name.
--
-- SAFETY CHECK: if ANY row holds a value in either column (for example someone put
-- data there by hand in a live database), this migration stops with a clear message
-- and drops nothing. Nothing is destroyed silently. Review, export or clear those
-- values deliberately, then re-run.
--
-- Re-adding a column later is a one-line migration, and there is no data to lose.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM subscriber_profiles WHERE date_of_birth IS NOT NULL OR gp_name IS NOT NULL) THEN
    RAISE EXCEPTION 'Refusing to drop subscriber_profiles.date_of_birth / gp_name: at least one row holds a value. Review, export or clear those values deliberately, then re-run this migration.';
  END IF;
END $$;

ALTER TABLE subscriber_profiles DROP COLUMN date_of_birth;
ALTER TABLE subscriber_profiles DROP COLUMN gp_name;
