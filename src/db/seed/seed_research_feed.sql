-- seed_research_feed.sql
--
-- All eight items currently live in aidh_website.html's Chapter 3 video
-- row, migrated in here as real rows with featured_on_homepage = true --
-- the flag that row's own dynamic fetch (loadFeaturedVideos(), added in
-- this same change) filters on. The first five were already seeded
-- before featured_on_homepage existed; the last three (added to the
-- website by hand, one at a time, across several turns of this project,
-- since there was no admin-upload path connected to that page until
-- now) are added here for the first time, with their captions copied
-- verbatim from the website's own HTML -- not re-written, so the two
-- places say exactly the same thing from the moment this seed applies.
-- created_by is NULL (platform-seeded, not created through the admin
-- UI; see migration 008's own comment on why this column is nullable).

INSERT INTO research_feed_items (item_type, title, url, disease, description, published, featured_on_homepage, created_by) VALUES
('video', 'Nirmal Khadse', 'https://youtu.be/CqoD6c06xyg', 'Psoriasis',
 'Nirmal Khadse shares his personal experience with psoriasis and the New Diet System (NDS) protocol, under practitioner guidance.', true, true, NULL),
('video', 'Ritu', 'https://youtu.be/DMZeCZairA8', 'Thyroid condition',
 'Ritu shares her personal experience with a thyroid condition, following a raw-food approach under the New Diet System (NDS) protocol, under practitioner guidance.', true, true, NULL),
('video', 'Prakash', 'https://youtu.be/xStsEjAerJ8', 'Diabetes & blood pressure',
 'Prakash shares his personal experience with diabetes and blood pressure, following the New Diet System (NDS) protocol, under practitioner guidance.', true, true, NULL),
('video', 'Sameer Patel', 'https://youtu.be/t3X3zaWuJ5g', 'Heart disease',
 'Sameer Patel shares his personal experience with heart disease, following the New Diet System (NDS) protocol, under practitioner guidance.', true, true, NULL),
('video', 'Manish Bhai', 'https://youtu.be/hFL4pb1SM2E', 'Fungal infection & uric acid',
 'Manish Bhai shares his personal experience with a fungal infection and elevated uric acid, following the New Diet System (NDS) protocol, under practitioner guidance.', true, true, NULL),
('video', 'Jasvinder Singh', 'https://youtu.be/C2M9Kw_SwQs', 'Dystonia',
 'Jasvinder Singh shares his personal experience with dystonia, following the New Diet System (NDS) protocol, under practitioner guidance.', true, true, NULL),
('video', 'Jind participant', 'https://youtu.be/QnOwqN2wLF8', 'Multiple chronic conditions',
 'A participant from Jind, Haryana shares his personal experience with hypertension, diabetes, and a cardiac history, following the New Diet System (NDS) protocol, under practitioner guidance.', true, true, NULL),
('video', 'Narhari Pandya', 'https://youtu.be/2r0odtsGuZE', 'Multiple chronic conditions',
 'Narhari Pandya, from Patan, Gujarat, shares his personal experience with knee problems, asthma, blood pressure, and heart disease, following the New Diet System (NDS) protocol, under practitioner guidance.', true, true, NULL);

-- Pillar tags. The first five match the exact assignments already live
-- on aidh_research_feed.html (checked against each video's own
-- transcript when that page was first built). The last three are new:
-- Jasvinder Singh's transcript describes enema and raw-juice intake, no
-- explicit fasting window (en, rf); the Jind participant's and Narhari
-- Pandya's transcripts are both testimony-focused, with no per-pillar
-- protocol detail specific enough to tag confidently beyond the two
-- pillars common to every NDS account reviewed in this project (en, rf)
-- -- not over-claimed from a transcript that doesn't support more.
INSERT INTO research_feed_item_pillars (item_id, pillar_id)
SELECT id, pillar FROM research_feed_items, UNNEST(
  CASE title
    WHEN 'Nirmal Khadse'     THEN ARRAY['en','rf','ft']
    WHEN 'Ritu'              THEN ARRAY['rf','en']
    WHEN 'Prakash'           THEN ARRAY['ft','en','rf']
    WHEN 'Sameer Patel'      THEN ARRAY['ft','rf']
    WHEN 'Manish Bhai'       THEN ARRAY['rf','en']
    WHEN 'Jasvinder Singh'   THEN ARRAY['en','rf']
    WHEN 'Jind participant'  THEN ARRAY['en','rf']
    WHEN 'Narhari Pandya'    THEN ARRAY['en','rf']
  END
) AS pillar
WHERE title IN ('Nirmal Khadse','Ritu','Prakash','Sameer Patel','Manish Bhai','Jasvinder Singh','Jind participant','Narhari Pandya');
