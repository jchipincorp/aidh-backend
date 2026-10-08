-- 009_research_feed_featured.sql
--
-- aidh_website.html's own "How the body responded" video row (Chapter 3)
-- and aidh_research_feed.html were, until now, two completely independent
-- data sources: the Research Feed page reads this table; the website's
-- row was hand-edited HTML with no connection to it at all. Every video
-- added to the website this session had to be manually duplicated into
-- this table separately to show up on the Research Feed page too, and
-- the reverse was never true at all -- an admin-uploaded item never
-- appeared on the website regardless.
--
-- This column is the explicit, admin-chosen bridge between the two: an
-- item with featured_on_homepage = true is included in the website's
-- own fetch (see aidh_website.html's loadFeaturedVideos()), in addition
-- to appearing on the Research Feed page as before (every item there
-- regardless of this flag). Defaults to false, not true -- an admin
-- must deliberately opt an item into the website's row, matching the
-- explicit request that this be a choice made at upload time, not an
-- automatic consequence of publishing.

ALTER TABLE research_feed_items
  ADD COLUMN featured_on_homepage BOOLEAN NOT NULL DEFAULT false;
