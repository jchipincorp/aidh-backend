// src/controllers/researchFeed.controller.js
//
// Backs aidh_research_feed.html (the public "Research Feed" page) and the
// new management section in aidh_admin.html. list() is the only public
// endpoint in this file -- it is NOT behind requireAuth, matching the
// explicit decision that this page is public, same category as the
// videos already shown on aidh_website.html, not Premium-gated like the
// Reference Library. Every other function here is reached only through
// routes/researchFeed.routes.js's admin-gated router.

const db = require('../config/db');
const { logAudit } = require('../lib/audit');

const VALID_PILLARS = ['en', 'rf', 'ft', 'md', 'sl'];
// "By approach" tabs (migration 014): a different kind of category from the pillars. Must match the ids in
// aidh_research_feed.html's TOPICS and aidh_admin.html's .rf-topic-cb checkboxes (the guard test cross-checks them).
const VALID_TOPICS = ['protocols', 'yoga', 'meditation', 'tcm', 'fasting', 'diet'];

async function attachPillars(items) {
  if (items.length === 0) return items;
  const ids = items.map((i) => i.id);
  // Deliberately NOT "WHERE item_id = ANY($1::uuid[])" -- confirmed via a
  // minimal, isolated reproduction that pg-mem (the test harness's
  // in-memory Postgres) returns zero rows for this exact pattern
  // specifically when the column is a foreign-key-referenced uuid whose
  // value came from a separate SELECT, even though the same values
  // match correctly with plain "=". A dynamic IN ($1,$2,...) list -- one
  // placeholder per id, no array parameter at all -- was confirmed
  // correct in both pg-mem and real Postgres (scripts/verify-real-postgres.js
  // exercises this same function). ids.length is bounded by the public
  // feed's own result size (small), so this never approaches Postgres's
  // real parameter-count ceiling.
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const tagRows = await db.query(
    `SELECT item_id, pillar_id FROM research_feed_item_pillars WHERE item_id IN (${placeholders})`,
    ids
  );
  const byItem = {};
  tagRows.rows.forEach((r) => { (byItem[r.item_id] = byItem[r.item_id] || []).push(r.pillar_id); });
  // Same dynamic IN list for the approach tags, for the same pg-mem reason as above.
  const topicRows = await db.query(
    `SELECT item_id, topic_id FROM research_feed_item_topics WHERE item_id IN (${placeholders})`,
    ids
  );
  const topicsByItem = {};
  topicRows.rows.forEach((r) => { (topicsByItem[r.item_id] = topicsByItem[r.item_id] || []).push(r.topic_id); });
  return items.map((i) => ({ ...i, pillars: byItem[i.id] || [], topics: topicsByItem[i.id] || [] }));
}

/** GET /api/research-feed -- public, no auth. Published items only;
 * anything an admin hasn't explicitly published never reaches this
 * endpoint, so a draft can never leak onto the public page by accident. */
async function list(req, res) {
  const result = await db.query(
    `SELECT id, item_type, title, url, thumbnail_url, disease, description, featured_on_homepage, created_at
     FROM research_feed_items WHERE published = true ORDER BY created_at DESC`
  );
  return res.json({ items: await attachPillars(result.rows) });
}

/** GET /api/admin/research-feed -- admin-only, includes drafts (published=false),
 * so the admin management UI can show and edit an item before it goes live. */
async function listAll(req, res) {
  const result = await db.query(
    `SELECT id, item_type, title, url, thumbnail_url, disease, description, published, featured_on_homepage, created_at, updated_at
     FROM research_feed_items ORDER BY created_at DESC`
  );
  return res.json({ items: await attachPillars(result.rows) });
}

// Checks the VALUES of whichever tag arrays were sent (undefined = not sent). Whether an item has at least one
// tag overall is a separate rule (create requires it; update checks it against what the item already has).
function checkTagValues(pillars, topics) {
  if (pillars !== undefined) {
    if (!Array.isArray(pillars)) return 'pillars must be an array';
    for (const p of pillars) {
      if (!VALID_PILLARS.includes(p)) return `unknown pillar "${p}" -- must be one of ${VALID_PILLARS.join(', ')}`;
    }
  }
  if (topics !== undefined) {
    if (!Array.isArray(topics)) return 'topics must be an array';
    for (const t of topics) {
      if (!VALID_TOPICS.includes(t)) return `unknown topic "${t}" -- must be one of ${VALID_TOPICS.join(', ')}`;
    }
  }
  return null;
}

// Links are shown to visitors as clickable addresses, so only real web addresses are accepted: never javascript:,
// data:, ftp: or a bare word. (The page also refuses anything else when it draws the card; this is the first gate.)
function checkLink(value, label) {
  if (typeof value !== 'string' || value.length > 2000 || !/^https?:\/\/[^\s"'<>]+$/i.test(value)) {
    return `${label} must be a full web address starting with https:// (or http://)`;
  }
  return null;
}

// item_type stays open-ended on purpose (migration 008) but must be a short lowercase word, never free markup.
function checkItemType(value) {
  return (typeof value === 'string' && /^[a-z][a-z_-]{1,29}$/.test(value)) ? null
    : 'itemType must be a short lowercase word such as video, paper, article or document';
}

/** POST /api/admin/research-feed -- admin-only. Starts as a draft
 * (published defaults to false) unless the admin explicitly sets
 * published:true in the same request -- see the frontend's own
 * "Save as draft" / "Publish" buttons, not a backend default alone. */
async function create(req, res) {
  const { itemType = 'video', title, url, thumbnailUrl = null, disease, description, pillars, topics, published = false, featuredOnHomepage = false } = req.body;
  if (!title || !url || !disease || !description) {
    return res.status(400).json({ error: 'title, url, disease and description are all required' });
  }
  const tagErr = checkTagValues(pillars, topics)
    || checkLink(url, 'url')
    || (thumbnailUrl ? checkLink(thumbnailUrl, 'thumbnailUrl') : null)
    || checkItemType(itemType);
  if (tagErr) return res.status(400).json({ error: tagErr });
  // The homepage row is a row of YouTube videos ("Opens on YouTube / Watch on YouTube"), so only a video can be
  // featured there; a paper or article stays on the Research Feed page, which labels each card by its type.
  if (featuredOnHomepage && itemType !== 'video') {
    return res.status(400).json({ error: 'only a video can be featured on the homepage video row' });
  }
  const pillarSet = [...new Set(pillars || [])];
  const topicSet = [...new Set(topics || [])];
  if (pillarSet.length + topicSet.length === 0) {
    return res.status(400).json({ error: 'at least one pillar or one approach topic (protocols, yoga, meditation, tcm, fasting, diet) is required' });
  }

  const adminRow = await db.query('SELECT id FROM admin_users WHERE user_id = $1', [req.user.sub]);
  if (adminRow.rows.length === 0) return res.status(403).json({ error: 'Not an admin account' });

  const result = await db.query(
    `INSERT INTO research_feed_items (item_type, title, url, thumbnail_url, disease, description, published, featured_on_homepage, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, published, featured_on_homepage`,
    [itemType, title, url, thumbnailUrl, disease, description, !!published, !!featuredOnHomepage, adminRow.rows[0].id]
  );
  const itemId = result.rows[0].id;
  for (const p of pillarSet) {
    await db.query(`INSERT INTO research_feed_item_pillars (item_id, pillar_id) VALUES ($1,$2)`, [itemId, p]);
  }
  for (const t of topicSet) {
    await db.query(`INSERT INTO research_feed_item_topics (item_id, topic_id) VALUES ($1,$2)`, [itemId, t]);
  }
  await logAudit(db, {
    actorUserId: req.user.sub, actorType: 'admin', actionCategory: 'RESEARCH_FEED', action: 'ITEM_CREATED',
    description: `"${title}" (${disease})${published ? ', published' : ', draft'}${featuredOnHomepage ? ', featured on homepage' : ''}${topicSet.length ? ', approach: ' + topicSet.join('/') : ''}`,
  });
  return res.status(201).json({ id: itemId, published: result.rows[0].published, featuredOnHomepage: result.rows[0].featured_on_homepage });
}

/** PATCH /api/admin/research-feed/:id -- admin-only. Partial update:
 * only fields present in the body are changed. Pillars, if included,
 * REPLACE the full existing set rather than merge -- matches how the
 * admin UI's checkbox list works (it always submits the complete
 * current selection, not a diff). */
async function update(req, res) {
  const { id } = req.params;
  const { itemType, title, url, thumbnailUrl, disease, description, pillars, topics, published, featuredOnHomepage } = req.body;

  const tagErr = checkTagValues(pillars, topics)
    || (url !== undefined ? checkLink(url, 'url') : null)
    || (thumbnailUrl ? checkLink(thumbnailUrl, 'thumbnailUrl') : null)
    || (itemType !== undefined ? checkItemType(itemType) : null);
  if (tagErr) return res.status(400).json({ error: tagErr });

  const existing = await db.query('SELECT id, item_type, featured_on_homepage FROM research_feed_items WHERE id = $1', [id]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
  // Same rule as create, against what the item WILL be: its new type (or the old one) and its new featured flag (or the old one).
  const willBeType = itemType !== undefined ? itemType : existing.rows[0].item_type;
  const willBeFeatured = featuredOnHomepage !== undefined ? !!featuredOnHomepage : existing.rows[0].featured_on_homepage;
  if (willBeFeatured && willBeType !== 'video') {
    return res.status(400).json({ error: 'only a video can be featured on the homepage video row' });
  }

  // An item must always keep at least one pillar or one approach. Checked BEFORE anything is changed, against the
  // full set the item will have afterwards (what was sent, plus whatever it already has for the part not sent).
  if (pillars !== undefined || topics !== undefined) {
    const finalPillars = pillars !== undefined ? pillars
      : (await db.query('SELECT pillar_id FROM research_feed_item_pillars WHERE item_id = $1', [id])).rows;
    const finalTopics = topics !== undefined ? topics
      : (await db.query('SELECT topic_id FROM research_feed_item_topics WHERE item_id = $1', [id])).rows;
    if (finalPillars.length + finalTopics.length === 0) {
      return res.status(400).json({ error: 'an item must keep at least one pillar or one approach topic' });
    }
  }

  const sets = []; const params = []; let n = 0;
  const maybe = (col, val) => { if (val !== undefined) { n += 1; sets.push(`${col} = $${n}`); params.push(val); } };
  maybe('item_type', itemType); maybe('title', title); maybe('url', url);
  maybe('thumbnail_url', thumbnailUrl); maybe('disease', disease); maybe('description', description);
  maybe('published', published); maybe('featured_on_homepage', featuredOnHomepage);
  if (sets.length > 0) {
    n += 1; params.push(id);
    await db.query(`UPDATE research_feed_items SET ${sets.join(', ')}, updated_at = now() WHERE id = $${n}`, params);
  }
  if (pillars !== undefined) {
    await db.query('DELETE FROM research_feed_item_pillars WHERE item_id = $1', [id]);
    for (const p of [...new Set(pillars)]) {
      await db.query(`INSERT INTO research_feed_item_pillars (item_id, pillar_id) VALUES ($1,$2)`, [id, p]);
    }
  }
  if (topics !== undefined) {
    await db.query('DELETE FROM research_feed_item_topics WHERE item_id = $1', [id]);
    for (const t of [...new Set(topics)]) {
      await db.query(`INSERT INTO research_feed_item_topics (item_id, topic_id) VALUES ($1,$2)`, [id, t]);
    }
  }
  await logAudit(db, {
    actorUserId: req.user.sub, actorType: 'admin', actionCategory: 'RESEARCH_FEED', action: 'ITEM_UPDATED',
    description: `Item ${id} updated`,
  });
  return res.json({ id, updated: true });
}

/** DELETE /api/admin/research-feed/:id -- admin-only. Hard delete (the
 * pillar tags cascade via ON DELETE CASCADE, migration 008) -- there is
 * no "trash"/undo here, matching how this content differs from
 * case_entries (which keeps a reviewed/rejected trail): a research-feed
 * item is a link to someone else's content, not a submitted account of
 * someone's own care that needs an audit trail of its own. */
async function remove(req, res) {
  const { id } = req.params;
  const result = await db.query('DELETE FROM research_feed_items WHERE id = $1 RETURNING id, title', [id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
  await logAudit(db, {
    actorUserId: req.user.sub, actorType: 'admin', actionCategory: 'RESEARCH_FEED', action: 'ITEM_DELETED',
    description: `"${result.rows[0].title}" (${id}) deleted`,
  });
  return res.json({ id, deleted: true });
}

module.exports = { list, listAll, create, update, remove, VALID_PILLARS, VALID_TOPICS };
