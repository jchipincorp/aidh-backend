-- 008_research_feed.sql
--
-- "Research Feed" (aidh_research_feed.html, built in a prior session as a
-- public, admin-curated content feed, five pillars + a "By Disease" view)
-- shipped with its content hardcoded directly in the page. This migration
-- gives it a real table, so AIDH admin can add/edit/remove items without
-- a frontend code change. The five items already live on the page are
-- migrated in as real rows (see seed/seed_research_feed.sql), not
-- re-invented -- same video IDs, same captions, same tags.
--
-- item_type is open-ended on purpose ('video' today; 'paper', 'article'
-- expected later, per the explicit "YouTube or research papers, in
-- future" scope this was built against) -- a free TEXT column, not an
-- ENUM, so adding a new content type never needs a schema migration.
--
-- Pillar tags live in a separate junction table, not an array column:
-- an item can and typically does carry more than one pillar (checked
-- directly against the source video transcripts when this was first
-- built -- most carry 2-3 tags, since the underlying protocol genuinely
-- touches more than one pillar at once), and a junction table lets the
-- public list endpoint filter by pillar with a plain indexed join
-- instead of an array-contains scan.

CREATE TABLE research_feed_items (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_type     TEXT NOT NULL DEFAULT 'video',
    title         TEXT NOT NULL,              -- e.g. the person's name
    url           TEXT NOT NULL,               -- full URL (youtu.be/..., a DOI, a journal link, etc.)
    thumbnail_url TEXT,                        -- NULL for a video: the public page derives it from url
    disease       TEXT NOT NULL,               -- free text, e.g. "Psoriasis" -- powers the By Disease view
    description   TEXT NOT NULL,               -- the one neutral sentence shown on the card
    published     BOOLEAN NOT NULL DEFAULT false,  -- draft until an admin explicitly publishes it
    -- Nullable, not NOT NULL: seed data (seed/seed_research_feed.sql) runs
    -- at deploy time, before any admin account exists to reference -- a
    -- NOT NULL FK here would make the initial five items impossible to
    -- seed at all. NULL honestly means "platform-seeded initial content",
    -- not "created by a specific admin through the UI".
    created_by    UUID REFERENCES admin_users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_research_feed_items_published ON research_feed_items(published);

-- Short codes matching P[] in aidh_dashboard.html exactly (en/rf/ft/md/sl)
-- -- NOT the longer, ad-hoc ids ('gut','food','eating','mind','screen')
-- the Research Feed page's own first version used internally before this
-- migration existed. Enforced by a CHECK rather than free text, since
-- these five are a closed, platform-wide set, not open-ended like
-- item_type above.
CREATE TABLE research_feed_item_pillars (
    item_id   UUID NOT NULL REFERENCES research_feed_items(id) ON DELETE CASCADE,
    pillar_id TEXT NOT NULL CHECK (pillar_id IN ('en','rf','ft','md','sl')),
    PRIMARY KEY (item_id, pillar_id)
);
CREATE INDEX idx_research_feed_item_pillars_pillar ON research_feed_item_pillars(pillar_id);
