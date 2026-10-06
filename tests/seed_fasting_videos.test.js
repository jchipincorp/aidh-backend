// tests/seed_fasting_videos.test.js -- the five Fasting-tab videos in src/db/seed/seed_research_feed_fasting.sql.
// The seed itself is run against a REAL Postgres (the pg-mem test harness only loads the disciplines seed); this file
// guards its content: the exact links the owner gave, no tracking codes, neutral captions, safe to run twice.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'seed', 'seed_research_feed_fasting.sql'), 'utf8');
const IDS = ['iZa00hg8rw0', 'T7o_hF1XB84', '1ZH_2cKbqzM', 'jqZsS03dlPk', 'r6vkEIeBj_E'];
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

test('FASTING SEED: all five videos the owner gave are present, as clean youtu.be links with no ?si= tracking code', () => {
  for (const id of IDS) assert.ok(code.includes(`'https://youtu.be/${id}'`), id);
  assert.equal((code.match(/https:\/\/youtu\.be\/[A-Za-z0-9_-]{11}'/g) || []).length, 10, 'five in the items insert, five in the tag insert');
  // The comments in the file mention "?si=" while explaining it, so check the SQL itself, not the comments: every
  // link literal must be EXACTLY a bare video address, with nothing after the 11-character id.
  const links = [...code.matchAll(/'(https?:\/\/[^']+)'/g)].map((m) => m[1]);
  assert.equal(links.length, 10);
  for (const l of links) assert.match(l, /^https:\/\/youtu\.be\/[A-Za-z0-9_-]{11}$/, l);
  assert.ok(!/[?&]si=/.test(code), 'no share-tracking parameter in the SQL');
});

test('FASTING SEED: safe to run twice, tagged to Fasting only, not featured on the homepage, and not invented content', () => {
  assert.match(code, /WHERE NOT EXISTS \(SELECT 1 FROM research_feed_items i WHERE i\.url = v\.url\)/);
  assert.match(code, /ON CONFLICT \(item_id, topic_id\) DO NOTHING/);
  assert.match(code, /SELECT i\.id, 'fasting' FROM research_feed_items i/);
  assert.ok(!/research_feed_item_pillars/.test(code), 'no pillar tags were asked for');
  assert.match(code, /true, false, NULL/, 'published, NOT featured on the homepage, platform-seeded');
  const titles = [...code.matchAll(/\(\d, '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(titles, ['Fasting video 1', 'Fasting video 2', 'Fasting video 3', 'Fasting video 4', 'Fasting video 5'], 'placeholders, not guessed speaker names');
});

test('FASTING SEED: the caption is the one neutral sentence the platform requires: no numbers, results or outcome claims', () => {
  const caption = (code.match(/'(A third-party video about fasting[^']+)'/) || [])[1];
  assert.equal(caption, 'A third-party video about fasting, shared for education and information only.');
  assert.ok(!/\d/.test(caption) && !/\b(cure[sd]?|revers\w+|remission|heal\w*|lose|loss|risk-free|guarantee\w*|proven|results?)\b/i.test(caption));
});
