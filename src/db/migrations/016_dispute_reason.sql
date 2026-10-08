-- 016_dispute_reason.sql
--
-- Why a subscriber reported a problem with a consultation, as one code from a short fixed list (no free text, so a
-- report can carry no health detail). The labels live in src/lib/disputeReasons.js; this list must match it.
-- Reports made before this migration have no reason (NULL) and are shown as "Not recorded".
-- Deliberately no outcome-based reason ("it didn't help"): the platform makes no outcome claims, and disputes are
-- about whether the session happened as booked.

ALTER TABLE consultation_bookings ADD COLUMN issue_reason TEXT
    CHECK (issue_reason IS NULL OR issue_reason IN ('practitioner_no_show', 'late_or_short', 'technical_problem', 'not_as_booked', 'other'));
