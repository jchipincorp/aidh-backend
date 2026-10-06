// tests/seed_diet_video.test.js -- the Diet-tab video in src/db/seed/seed_research_feed_diet.sql.
// The seed is run against a REAL Postgres (the pg-mem harness loads only the disciplines seed); this guards its content.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'seed', 'seed_research_feed_diet.sql'), 'utf8');
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

test('DIET SEED: the video the owner gave is present as a clean youtu.be link, with no ?si= tracking code in the SQL', () => {
  const links = [...code.matchAll(/'(https?:\/\/[^']+)'/g)].map((m) => m[1]);
  assert.equal(links.length, 3, 'the item insert, its NOT EXISTS check and the tag insert');
  for (const l of links) assert.equal(l, 'https://youtu.be/qhJZcKFfu_c');
  assert.ok(!/[?&]si=/.test(code));
});

test('DIET SEED: safe to run twice, tagged to Diet only, not featured on the homepage', () => {
  assert.match(code, /WHERE NOT EXISTS \(SELECT 1 FROM research_feed_items i WHERE i\.url = 'https:\/\/youtu\.be\/qhJZcKFfu_c'\)/);
  assert.match(code, /ON CONFLICT \(item_id, topic_id\) DO NOTHING/);
  assert.match(code, /SELECT i\.id, 'diet' FROM research_feed_items i/);
  assert.ok(!/research_feed_item_pillars/.test(code), 'no pillar tags were asked for');
  assert.match(code, /true, false, NULL/, 'published, NOT featured on the homepage, platform-seeded');
});

test('DIET SEED: the caption is ONE neutral sentence: no digits, results or outcome claims, and none of the talk\'s own health claims', () => {
  const caption = (code.match(/'(In a conference talk[^']+)'/) || [])[1];
  assert.ok(caption, 'caption found');
  assert.equal((caption.match(/\. /g) || []).length, 1, 'one sentence: the only ". " is the one after "Dr."');
  assert.ok(caption.endsWith('information only.'));
  assert.ok(!/\d/.test(caption), 'no numbers');
  assert.ok(!/\b(cure[sd]?|revers\w*|remission|heal(s|ed|ing)?|lose|loss|risk-free|guarantee\w*|proven|results?|cancer|survival|prevent\w*|treat\w*)\b/i.test(caption), 'no outcome or disease claims');
});
