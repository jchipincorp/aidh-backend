-- 002_health_profile.sql
-- Sliders are an insert-only time series, never updated in place.
-- Computed scores (organ scores, overall score, biomarkers, risk scores)
-- are deliberately NOT columns here -- they are pure functions of a
-- snapshot row, applied at read time by the application layer. See
-- AIDH_Database_Design.docx Section 3 for the full rationale.

CREATE TYPE biomarker_code AS ENUM ('crp', 'hba1c', 'cortisol', 'bdnf', 'lps', 'hrv');
CREATE TYPE lab_source AS ENUM ('self_reported');

CREATE TABLE slider_snapshots (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscriber_id  UUID NOT NULL REFERENCES subscriber_profiles(id) ON DELETE CASCADE,
    en_value       SMALLINT NOT NULL CHECK (en_value BETWEEN 0 AND 100), -- Gut Toxicity
    rf_value       SMALLINT NOT NULL CHECK (rf_value BETWEEN 0 AND 100), -- Unhealthy Food
    ft_value       SMALLINT NOT NULL CHECK (ft_value BETWEEN 0 AND 100), -- Frequent Eating
    md_value       SMALLINT NOT NULL CHECK (md_value BETWEEN 0 AND 100), -- Thought Toxicity
    sl_value       SMALLINT NOT NULL CHECK (sl_value BETWEEN 0 AND 100), -- Screen Overload
    recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    -- NOTE: no updated_at column -- this table is insert-only by design.
);
CREATE INDEX idx_slider_snapshots_subscriber_time
    ON slider_snapshots (subscriber_id, recorded_at DESC);

-- Optional performance cache. If used, it must be invalidated (deleted or
-- recomputed) whenever a new slider_snapshots row is inserted for the same
-- subscriber -- never edited independently of its source snapshot.
CREATE TABLE computed_scores_cache (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slider_snapshot_id  UUID NOT NULL UNIQUE REFERENCES slider_snapshots(id) ON DELETE CASCADE,
    scores_json         JSONB NOT NULL, -- organ scores, overall, risk, biomarker estimates
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The manually-typed lab reconciliation field discussed and intentionally
-- not yet wired into the frontend. HARD RULE, enforced at the application
-- layer (see src/controllers/subscriber.controller.js): no scoring
-- function may ever read from this table. It exists purely for
-- side-by-side display against the model's own estimate.
CREATE TABLE lab_results (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscriber_id  UUID NOT NULL REFERENCES subscriber_profiles(id) ON DELETE CASCADE,
    biomarker_code biomarker_code NOT NULL,
    value          DECIMAL NOT NULL,
    unit           TEXT NOT NULL,
    result_date    DATE NOT NULL,
    source         lab_source NOT NULL DEFAULT 'self_reported',
    entered_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lab_results_subscriber ON lab_results (subscriber_id, biomarker_code);
