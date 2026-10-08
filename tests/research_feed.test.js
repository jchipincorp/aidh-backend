// tests/research_feed.test.js
//
// Real controllers + a real pg-mem Postgres (same harness as
// billing.test.js / free_plan_single_trial.test.js), not mocks of this
// feature's own code. Covers: the public endpoint never leaks a draft,
// the admin endpoints are genuinely behind requireAuth+requireRole
// (not just "the frontend happens not to show the button"), the full
// draft -> publish -> delete lifecycle, and that pillar validation is
// real (an invalid pillar id is refused, not silently accepted).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const { buildTestDb } = require('./setup');

process.env.JWT_SECRET = 'test-secret-not-for-production';
process.env.FIELD_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fixture';
process.env.STRIPE_PRICE_ID_MONTHLY = 'price_test_monthly';
process.env.STRIPE_PRICE_ID_ANNUAL = 'price_test_annual';

const dbConfigPath = path.join(__dirname, '..', 'src', 'config', 'db.js');

function freshApp() {
  Object.keys(require.cache).forEach((key) => { if (key.includes('/src/')) delete require.cache[key]; });
  const testPool = buildTestDb();
  require.cache[require.resolve(dbConfigPath)] = { id: dbConfigPath, filename: dbConfigPath, loaded: true, exports: testPool };
  const { createApp } = require('../src/server');
  return { app: createApp(), pool: testPool };
}

function jsonRequest(app, method, url, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({
        method, port, path: url,
        headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { server.close(); let parsed = null; try { parsed = data ? JSON.parse(data) : null; } catch (e) {} resolve({ status: res.statusCode, body: parsed }); });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  });
}

let n = 0;
async function realAdminToken(app, pool) {
  n += 1;
  const email = `rf-admin-${n}-${Date.now()}@test.com`;
  const password = 'correct-horse-battery-9';
  const reg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email, password, role: 'subscriber' } });
  // Promote this real, registered user to a real admin -- same shape a
  // human would end up in via scripts/create-admin.js, not a shortcut
  // that skips the schema this feature's auth boundary actually checks.
  const u = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
  await pool.query(`UPDATE users SET role='admin' WHERE id=$1`, [u.rows[0].id]);
  await pool.query(`INSERT INTO admin_users (user_id, admin_role) VALUES ($1,'super_admin')`, [u.rows[0].id]);
  // The register() token above still carries role:'subscriber' -- it was
  // signed before the promotion above, and requireRole checks the JWT's
  // own claim, not a fresh DB lookup (see middleware/auth.js). A real
  // admin only gets a correctly-scoped token by signing in AFTER being
  // promoted (scripts/create-admin.js's own instructions say exactly
  // this: "sign in through the normal sign-in form"), so that's what
  // this helper does too, rather than return the stale token.
  const signin = await jsonRequest(app, 'POST', '/api/auth/signin', { body: { email, password } });
  return signin.body.token;
}
async function realSubscriberToken(app) {
  n += 1;
  const email = `rf-sub-${n}-${Date.now()}@test.com`;
  const reg = await jsonRequest(app, 'POST', '/api/auth/register', { body: { email, password: 'correct-horse-battery-9', role: 'subscriber' } });
  return reg.body.token;
}

const sampleItem = { title: 'Test Person', url: 'https://youtu.be/testid123', disease: 'Test Condition', description: 'A test description.', pillars: ['md'] };

test('PUBLIC: the list endpoint needs no auth at all', async () => {
  const { app } = freshApp();
  const res = await jsonRequest(app, 'GET', '/api/research-feed');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
});

test('ADMIN BOUNDARY: no token at all is refused (401), never silently falls through to the public handler', async () => {
  const { app } = freshApp();
  const res = await jsonRequest(app, 'GET', '/api/admin/research-feed');
  assert.equal(res.status, 401);
});

test('ADMIN BOUNDARY: a real but non-admin token is refused (403) for every admin route', async () => {
  const { app } = freshApp();
  const token = await realSubscriberToken(app);
  const get = await jsonRequest(app, 'GET', '/api/admin/research-feed', { token });
  const post = await jsonRequest(app, 'POST', '/api/admin/research-feed', { token, body: sampleItem });
  assert.equal(get.status, 403);
  assert.equal(post.status, 403);
});

test('VALIDATION: missing required fields refused with 400, nothing created', async () => {
  const { app, pool } = freshApp();
  const token = await realAdminToken(app, pool);
  const res = await jsonRequest(app, 'POST', '/api/admin/research-feed', { token, body: { title: 'Only a title' } });
  assert.equal(res.status, 400);
  const count = await pool.query('SELECT count(*)::int AS c FROM research_feed_items');
  assert.equal(count.rows[0].c, 0);
});

test('VALIDATION: an unknown pillar id is refused, not silently accepted or dropped', async () => {
  const { app, pool } = freshApp();
  const token = await realAdminToken(app, pool);
  const res = await jsonRequest(app, 'POST', '/api/admin/research-feed', { token, body: { ...sampleItem, pillars: ['md', 'not-a-real-pillar'] } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not-a-real-pillar/);
});

test('LIFECYCLE: create as draft -> hidden from public -> visible to admin -> publish -> visible to public -> delete -> gone everywhere', async () => {
  const { app, pool } = freshApp();
  const token = await realAdminToken(app, pool);

  const create = await jsonRequest(app, 'POST', '/api/admin/research-feed', { token, body: { ...sampleItem, published: false } });
  assert.equal(create.status, 201);
  assert.equal(create.body.published, false);
  const id = create.body.id;

  const pub1 = await jsonRequest(app, 'GET', '/api/research-feed');
  assert.ok(!pub1.body.items.some((i) => i.id === id), 'draft must not appear on the public endpoint');

  const adminList = await jsonRequest(app, 'GET', '/api/admin/research-feed', { token });
  const found = adminList.body.items.find((i) => i.id === id);
  assert.ok(found, 'draft must appear on the admin list-all endpoint');
  assert.deepEqual(found.pillars.sort(), ['md']);

  const patch = await jsonRequest(app, 'PATCH', `/api/admin/research-feed/${id}`, { token, body: { published: true } });
  assert.equal(patch.status, 200);

  const pub2 = await jsonRequest(app, 'GET', '/api/research-feed');
  assert.ok(pub2.body.items.some((i) => i.id === id), 'must appear on the public endpoint once published');

  const del = await jsonRequest(app, 'DELETE', `/api/admin/research-feed/${id}`, { token });
  assert.equal(del.status, 200);

  const pub3 = await jsonRequest(app, 'GET', '/api/research-feed');
  assert.ok(!pub3.body.items.some((i) => i.id === id), 'must be gone from the public endpoint after delete');
  const adminList2 = await jsonRequest(app, 'GET', '/api/admin/research-feed', { token });
  assert.ok(!adminList2.body.items.some((i) => i.id === id), 'must be gone from the admin list too -- a real delete, not just unpublish');
});

test('UPDATE: replacing pillars replaces the full set, does not merge with the old one', async () => {
  const { app, pool } = freshApp();
  const token = await realAdminToken(app, pool);
  const create = await jsonRequest(app, 'POST', '/api/admin/research-feed', { token, body: { ...sampleItem, pillars: ['en', 'rf'], published: true } });
  const id = create.body.id;

  await jsonRequest(app, 'PATCH', `/api/admin/research-feed/${id}`, { token, body: { pillars: ['sl'] } });

  const adminList = await jsonRequest(app, 'GET', '/api/admin/research-feed', { token });
  const found = adminList.body.items.find((i) => i.id === id);
  assert.deepEqual(found.pillars, ['sl'], 'old pillars (en, rf) must be gone, not merged with the new one');
});

test('UPDATE / DELETE on a nonexistent id returns 404, not a silent success', async () => {
  const { app, pool } = freshApp();
  const token = await realAdminToken(app, pool);
  const fakeId = '00000000-0000-0000-0000-000000000000';
  const patch = await jsonRequest(app, 'PATCH', `/api/admin/research-feed/${fakeId}`, { token, body: { published: true } });
  const del = await jsonRequest(app, 'DELETE', `/api/admin/research-feed/${fakeId}`, { token });
  assert.equal(patch.status, 404);
  assert.equal(del.status, 404);
});

test('AUDIT: creating, updating and deleting an item each write a real audit_log row', async () => {
  const { app, pool } = freshApp();
  const token = await realAdminToken(app, pool);
  const create = await jsonRequest(app, 'POST', '/api/admin/research-feed', { token, body: sampleItem });
  await jsonRequest(app, 'PATCH', `/api/admin/research-feed/${create.body.id}`, { token, body: { published: true } });
  await jsonRequest(app, 'DELETE', `/api/admin/research-feed/${create.body.id}`, { token });
  const log = await pool.query(`SELECT action FROM audit_log WHERE action_category='RESEARCH_FEED' ORDER BY created_at`);
  assert.deepEqual(log.rows.map((r) => r.action), ['ITEM_CREATED', 'ITEM_UPDATED', 'ITEM_DELETED']);
});


// ───────────────────────── "By approach" topics (migration 014) ─────────────────────────
const ALL_TOPICS = ['protocols', 'yoga', 'meditation', 'tcm', 'fasting', 'diet'];
const paperItem = { itemType: 'paper', title: 'A Yoga Study', url: 'https://doi.org/10.1000/xyz123', disease: 'General wellbeing', description: 'A neutral description.', topics: ['yoga'], published: true };
const post = (app, token, body) => jsonRequest(app, 'POST', '/api/admin/research-feed', { token, body });
const count = async (pool, table) => (await pool.query(`SELECT count(*)::int AS c FROM ${table}`)).rows[0].c;

test('TOPICS: an item can carry an approach and no pillar, and the public list returns both arrays', async () => {
  const { app, pool } = freshApp(); const token = await realAdminToken(app, pool);
  const r = await post(app, token, paperItem); assert.equal(r.status, 201, JSON.stringify(r.body));
  const pub = (await jsonRequest(app, 'GET', '/api/research-feed')).body.items.find((i) => i.id === r.body.id);
  assert.ok(pub); assert.deepEqual(pub.topics, ['yoga']); assert.deepEqual(pub.pillars, []); assert.equal(pub.item_type, 'paper');
  const both = await post(app, token, { ...paperItem, title: 'Both', pillars: ['ft'], topics: ['fasting', 'diet'] });
  const found = (await jsonRequest(app, 'GET', '/api/research-feed')).body.items.find((i) => i.id === both.body.id);
  assert.deepEqual(found.pillars, ['ft']); assert.deepEqual(found.topics.sort(), ['diet', 'fasting']);
});

test('TOPICS: all six approach ids are accepted; an unknown one is refused and nothing is created; duplicates collapse', async () => {
  const { app, pool } = freshApp(); const token = await realAdminToken(app, pool);
  const ok = await post(app, token, { ...paperItem, topics: [...ALL_TOPICS, 'yoga', 'tcm'] });
  assert.equal(ok.status, 201);
  assert.equal(await count(pool, 'research_feed_item_topics'), 6, 'six rows: the duplicates were collapsed, not a primary-key error');
  const bad = await post(app, token, { ...paperItem, title: 'Bad', topics: ['yoga', 'not-an-approach'] });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /not-an-approach/);
  assert.equal(await count(pool, 'research_feed_items'), 1, 'the refused item was not created');
  assert.equal((await post(app, token, { ...paperItem, topics: 'yoga' })).status, 400, 'a string instead of an array is refused');
});

test('TOPICS: an item must carry at least one pillar or one approach', async () => {
  const { app, pool } = freshApp(); const token = await realAdminToken(app, pool);
  for (const body of [{ ...paperItem, topics: undefined }, { ...paperItem, topics: [] }, { ...paperItem, topics: [], pillars: [] }]) {
    const r = await post(app, token, body); assert.equal(r.status, 400); assert.match(r.body.error, /at least one pillar or one approach/);
  }
  assert.equal(await count(pool, 'research_feed_items'), 0);
});

test('TOPICS: updating approaches replaces the set; updating pillars alone keeps them; removing every tag is refused and changes nothing', async () => {
  const { app, pool } = freshApp(); const token = await realAdminToken(app, pool);
  const id = (await post(app, token, { ...paperItem, pillars: ['ft'], topics: ['yoga', 'diet'] })).body.id;
  const patch = (b) => jsonRequest(app, 'PATCH', `/api/admin/research-feed/${id}`, { token, body: b });
  const get = async () => (await jsonRequest(app, 'GET', '/api/admin/research-feed', { token })).body.items.find((i) => i.id === id);
  assert.equal((await patch({ topics: ['tcm'] })).status, 200); assert.deepEqual((await get()).topics, ['tcm'], 'replaced, not merged');
  assert.equal((await patch({ pillars: ['sl'] })).status, 200); assert.deepEqual((await get()).topics, ['tcm'], 'topics untouched when only pillars are sent');
  assert.equal((await patch({ pillars: [] })).status, 200, 'dropping the pillars is fine while an approach remains');
  const refused = await patch({ topics: [] }); assert.equal(refused.status, 400); assert.match(refused.body.error, /at least one/);
  const after = await get(); assert.deepEqual([after.pillars, after.topics], [[], ['tcm']], 'the refused update changed nothing');
  assert.equal((await patch({ topics: ['nope'] })).status, 400);
});

test('LINKS: only real http(s) addresses are accepted, on create and on update; javascript:, data:, ftp:, markup and bare words are refused', async () => {
  const { app, pool } = freshApp(); const token = await realAdminToken(app, pool);
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'ftp://example.com/x', 'example.com/paper', '//example.com/x', 'https://exa mple.com', 'https://example.com/"onmouseover="x', '', 'https://' + 'a'.repeat(2100)]) {
    const r = await post(app, token, { ...paperItem, url }); assert.equal(r.status, 400, 'refused: ' + url.slice(0, 40));
  }
  assert.equal(await count(pool, 'research_feed_items'), 0);
  assert.equal((await post(app, token, { ...paperItem, url: 'http://example.org/a.pdf' })).status, 201, 'plain http is allowed');
  const id = (await post(app, token, { ...paperItem, title: 'T2', url: 'https://pubmed.ncbi.nlm.nih.gov/12345/' })).body.id;
  const bad = await jsonRequest(app, 'PATCH', `/api/admin/research-feed/${id}`, { token, body: { url: 'javascript:alert(1)' } });
  assert.equal(bad.status, 400);
  const row = (await pool.query('SELECT url FROM research_feed_items WHERE id=$1', [id])).rows[0];
  assert.equal(row.url, 'https://pubmed.ncbi.nlm.nih.gov/12345/', 'the refused update changed nothing');
  assert.equal((await post(app, token, { ...paperItem, title: 'T3', thumbnailUrl: 'javascript:x' })).status, 400, 'the thumbnail address is checked too');
});

test('TYPE: itemType must be a short lowercase word; paper, article and document are fine', async () => {
  const { app, pool } = freshApp(); const token = await realAdminToken(app, pool);
  for (const itemType of ['paper', 'article', 'document', 'video']) assert.equal((await post(app, token, { ...paperItem, title: itemType, itemType })).status, 201, itemType);
  for (const itemType of ['Paper', '<img src=x>', 'a', 'x'.repeat(40), '', 5]) assert.equal((await post(app, token, { ...paperItem, itemType })).status, 400, String(itemType));
});

test('TOPICS: deleting an item removes its approach rows, and a draft never reaches the public list', async () => {
  const { app, pool } = freshApp(); const token = await realAdminToken(app, pool);
  const draft = await post(app, token, { ...paperItem, published: false });
  assert.ok(!(await jsonRequest(app, 'GET', '/api/research-feed')).body.items.some((i) => i.id === draft.body.id));
  assert.equal(await count(pool, 'research_feed_item_topics'), 1);
  assert.equal((await jsonRequest(app, 'DELETE', `/api/admin/research-feed/${draft.body.id}`, { token })).status, 200);
  assert.equal(await count(pool, 'research_feed_item_topics'), 0, 'the approach rows went with the item');
});

test('HOMEPAGE: only a video can be featured on the homepage row; a paper or article stays on the Research Feed page', async () => {
  const { app, pool } = freshApp(); const token = await realAdminToken(app, pool);
  const refused = await post(app, token, { ...paperItem, featuredOnHomepage: true });
  assert.equal(refused.status, 400); assert.match(refused.body.error, /only a video/);
  assert.equal(await count(pool, 'research_feed_items'), 0, 'nothing was created');
  const video = await post(app, token, { ...paperItem, title: 'V', itemType: 'video', url: 'https://youtu.be/abcdef12345', featuredOnHomepage: true });
  assert.equal(video.status, 201);
  const paper = await post(app, token, { ...paperItem, title: 'P' });
  const patch = (id, b) => jsonRequest(app, 'PATCH', `/api/admin/research-feed/${id}`, { token, body: b });
  assert.equal((await patch(paper.body.id, { featuredOnHomepage: true })).status, 400, 'a paper cannot be switched onto the homepage');
  assert.equal((await patch(video.body.id, { itemType: 'paper' })).status, 400, 'a featured video cannot be turned into a paper while still featured');
  assert.equal((await patch(video.body.id, { itemType: 'paper', featuredOnHomepage: false })).status, 200, 'but both can change together');
  assert.equal((await patch(video.body.id, { title: 'V2' })).status, 200, 'an unrelated edit to a featured video is fine');
});
