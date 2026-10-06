-- seed_research_feed_fasting.sql
--
-- Five YouTube videos the owner asked to have in the Research Feed's "Fasting" tab ("By approach", migration 014).
-- A separate file from seed_research_feed.sql on purpose: that file holds the eight items copied verbatim from the
-- website and is plain INSERTs (run once on a fresh database). THIS file is safe to run again: a video that is
-- already there (matched by its link) is not inserted twice, and its Fasting tag is not duplicated.
--
-- Links are stored WITHOUT the "?si=..." part the owner's copied links carried. That value is a YouTube share-tracking
-- code tied to whoever copied the link, not part of the video's address; the video is the same without it.
--
-- PLACEHOLDER TITLES AND CAPTION. The build environment could not read these videos' pages (YouTube refused the
-- request), so the speaker, channel and content of each video are NOT known here and are deliberately not guessed.
-- Each item has a generic title ("Fasting video N") and the one caption that is true of any of them, in line with the
-- platform's rule of one neutral sentence with no claims. Replace the titles with the speakers' names and the caption
-- with a neutral line about what each video covers once someone has watched them: for a fresh database edit this
-- file; for a database that already has these rows, run
--   UPDATE research_feed_items SET title = '<name>', description = '<one neutral sentence>' WHERE url = 'https://youtu.be/<id>';
-- (the admin screen has no edit form yet; deleting and re-adding also works).
--
-- No pillar tags: the owner asked for the Fasting tab only, so these appear under By approach > Fasting and under
-- By Disease > "General wellbeing". Tagging them to the Frequent Eating pillar as well is a one-line addition if wanted.
-- Not featured on the homepage (featured_on_homepage = false). published = true: they are visible as soon as seeded.
-- created_at is staggered by a second each so the tab lists them in the order the owner gave them (newest first).

INSERT INTO research_feed_items (item_type, title, url, disease, description, published, featured_on_homepage, created_by, created_at)
SELECT 'video', v.title, v.url, 'General wellbeing',
       'A third-party video about fasting, shared for education and information only.',
       true, false, NULL, now() - (v.n * interval '1 second')
FROM (VALUES
  (1, 'Fasting video 1', 'https://youtu.be/iZa00hg8rw0'),
  (2, 'Fasting video 2', 'https://youtu.be/T7o_hF1XB84'),
  (3, 'Fasting video 3', 'https://youtu.be/1ZH_2cKbqzM'),
  (4, 'Fasting video 4', 'https://youtu.be/jqZsS03dlPk'),
  (5, 'Fasting video 5', 'https://youtu.be/r6vkEIeBj_E')
) AS v(n, title, url)
WHERE NOT EXISTS (SELECT 1 FROM research_feed_items i WHERE i.url = v.url);

INSERT INTO research_feed_item_topics (item_id, topic_id)
SELECT i.id, 'fasting' FROM research_feed_items i
WHERE i.url IN ('https://youtu.be/iZa00hg8rw0','https://youtu.be/T7o_hF1XB84','https://youtu.be/1ZH_2cKbqzM','https://youtu.be/jqZsS03dlPk','https://youtu.be/r6vkEIeBj_E')
ON CONFLICT (item_id, topic_id) DO NOTHING;
