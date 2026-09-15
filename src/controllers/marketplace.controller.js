// src/controllers/marketplace.controller.js
const db = require('../config/db');

async function listDisciplines(req, res) {
  const { search, tier } = req.query;
  const conditions = [];
  const params = [];

  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    conditions.push(`(LOWER(name) LIKE $${params.length} OR LOWER(description) LIKE $${params.length})`);
  }
  if (tier) {
    params.push(Number(tier));
    conditions.push(`tier = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await db.query(`SELECT * FROM disciplines ${where} ORDER BY tier, name`, params);
  return res.json({ disciplines: result.rows, count: result.rows.length });
}

async function createMatch(req, res) {
  const { disciplineSlug, isUrgent = false } = req.body;
  const profile = await db.query('SELECT id FROM subscriber_profiles WHERE user_id = $1', [req.user.sub]);
  if (profile.rows.length === 0) return res.status(404).json({ error: 'No subscriber profile found' });

  const discipline = await db.query('SELECT id FROM disciplines WHERE slug = $1', [disciplineSlug]);
  if (discipline.rows.length === 0) return res.status(404).json({ error: 'Unknown discipline' });

  const refCode = `match_${disciplineSlug}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const result = await db.query(
    `INSERT INTO practitioner_matches (subscriber_id, discipline_id, match_reference_code, is_urgent)
     VALUES ($1, $2, $3, $4) RETURNING id, match_reference_code`,
    [profile.rows[0].id, discipline.rows[0].id, refCode, isUrgent]
  );
  return res.status(201).json(result.rows[0]);
}

module.exports = { listDisciplines, createMatch };
