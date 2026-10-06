-- seed_research_feed_diet.sql
--
-- One YouTube video the owner asked to have in the Research Feed's "Diet" tab ("By approach", migration 014).
-- Same design as seed_research_feed_fasting.sql: a separate file, safe to run again (a video already present, matched
-- by its link, is not inserted twice, and its Diet tag is not duplicated).
--
-- The link is stored WITHOUT the "?si=..." part of the copied link: that is a YouTube share-tracking code tied to
-- whoever copied it, not part of the video's address.
--
-- TITLE: "Dr. William Li". The owner attached this talk's transcript, which never states the speaker's name; the
-- speaker says he is a physician and vascular biologist and that he wrote "a book called Eat to Beat Disease", which is
-- by Dr. William Li (the platform's own Reference Library already cites "Dr William Li -- Eat to Beat Disease (2019)").
-- That is an inference from the transcript, not a name read off the video page: the owner should confirm it.
--
-- CAPTION: one neutral sentence written from the transcript, in line with the platform's rule (no specific numbers,
-- test results or outcome claims). The talk itself makes specific health claims, including about cancer; they are the
-- speaker's, are deliberately NOT repeated in the caption, and the page's banner and the Diet tab's own note apply.
--
-- Tagged to Diet only, as asked (no pillar tags), not featured on the homepage, published.

INSERT INTO research_feed_items (item_type, title, url, disease, description, published, featured_on_homepage, created_by)
SELECT 'video', 'Dr. William Li', 'https://youtu.be/qhJZcKFfu_c', 'General wellbeing',
       'In a conference talk, Dr. William Li, a physician and vascular biologist, discusses how nutrition science and medicine are coming together and how foods are being studied for their role in health, shared here for education and information only.',
       true, false, NULL
WHERE NOT EXISTS (SELECT 1 FROM research_feed_items i WHERE i.url = 'https://youtu.be/qhJZcKFfu_c');

INSERT INTO research_feed_item_topics (item_id, topic_id)
SELECT i.id, 'diet' FROM research_feed_items i
WHERE i.url = 'https://youtu.be/qhJZcKFfu_c'
ON CONFLICT (item_id, topic_id) DO NOTHING;
