// src/lib/scoring.js
//
// Mirrors the P (pillar weight) array and organSc()/overallSc() functions
// already implemented client-side in aidh_dashboard.html. This file must
// be kept in sync with that client-side implementation by hand until the
// two are unified into one shared package -- see README "Known scaffold
// limitations".
//
// Deliberately pure functions: given a slider_snapshots row, they return
// computed values. Nothing here reads from lab_results, and nothing here
// writes to the database -- that keeps "the input" and "the derived
// output" from ever being edited independently. See
// AIDH_Database_Design.docx Section 3.

const PILLARS = [
  { id: 'en', name: 'Gut Toxicity — Daily Clearance Level', pct: 20, grp: 'A',
    w: { g: .38, im: .14, lv: .28, ht: .06, br: .02, lu: .04, kd: .22, pk: .04 } },
  { id: 'rf', name: 'Unhealthy Food Burden — Living Food Intake', pct: 25, grp: 'A',
    w: { g: .28, im: .26, lv: .20, ht: .18, br: .08, lu: .16, kd: .18, pk: .18 } },
  { id: 'ft', name: 'Frequent Eating — Daily Repair Window', pct: 30, grp: 'A',
    w: { g: .14, im: .20, lv: .24, ht: .18, br: .32, lu: .10, kd: .16, pk: .52 } },
  { id: 'md', name: 'Thought Toxicity — Mind-Body Practice', pct: 15, grp: 'B',
    w: { g: .056, im: .144, lv: .064, ht: .242, br: .322, lu: .147, kd: .080, pk: .050 } },
  { id: 'sl', name: 'Screen Overload — Circadian Sleep Quality', pct: 10, grp: 'B',
    w: { g: .04, im: .16, lv: .05, ht: .12, br: .30, lu: .07, kd: .06, pk: .05 } },
];

const ORGANS = ['g', 'im', 'lv', 'ht', 'br', 'lu', 'kd', 'pk'];

/** Computes one organ's score (0-1) from a slider snapshot.
 * Group-A pillars (en/rf/ft — the ANDS core: gut, food, eating window) are
 * amplified 1.4x relative to Group-B (md/sl — mind-body) in both the
 * numerator and denominator. This mirrors aidh_dashboard.html's organSc()
 * exactly: a second scoring discrepancy found during backend/frontend
 * parity verification, distinct from the earlier overallScore() sl_eff
 * fix — that one was already correct here, this one was missing entirely.
 * Omitting it understated every organ's ANDS-driven component and
 * overstated its mind-body component, shifting organ colors on the
 * dashboard by 1-2 points in roughly half of tested snapshots. */
function organScore(organId, snapshot) {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const p of PILLARS) {
    const w = p.w[organId] || 0;
    if (!w) continue;
    const v = snapshot[p.id] / 100;
    const amp = p.grp === 'A' ? 1.4 : 1.0;
    weightedSum += v * w * amp;
    weightTotal += w * amp;
  }
  return weightTotal > 0 ? weightedSum / weightTotal : 0;
}

/** Computes the Overall AIDH Enquiry Score (0-1) from a slider snapshot.
 * Includes the sleep-quality bonus (sl_eff): sleep's effective contribution
 * scales up when Thought Toxicity (mind-body) is already well-managed
 * (md > 50%) — mirrors aidh_dashboard.html's overallSc() exactly, same
 * scale and operation order throughout, to avoid floating-point drift.
 * A discrepancy here was found and fixed during final pre-production
 * verification (see AIDH_Software_Requirements_Specification.docx 2.5). */
function overallScore(snapshot) {
  const en = snapshot.en / 100, rf = snapshot.rf / 100, ft = snapshot.ft / 100;
  const md = snapshot.md / 100, sl = snapshot.sl / 100;
  const sl_eff = Math.min(1.0, sl * (1 + 0.20 * Math.max(0, md - 0.5) * 2));
  const andsCore = en * (20 / 75) + rf * (25 / 75) + ft * (30 / 75);
  const mindBody = md * (15 / 25) + sl_eff * (10 / 25);
  return 0.75 * andsCore + 0.25 * mindBody;
}

/** Top pillar drivers for a given organ, sorted by weight descending. */
function topDrivers(organId, count = 2) {
  return PILLARS
    .map((p) => ({ id: p.id, name: p.name.split(' — ')[0], weight: p.w[organId] || 0 }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, count);
}

/** Full computed-scores payload for a snapshot, as would be cached in
 * computed_scores_cache.scores_json. */
function computeAll(snapshot) {
  const organScores = {};
  for (const o of ORGANS) organScores[o] = Math.round(organScore(o, snapshot) * 100);
  return {
    overall: Math.round(overallScore(snapshot) * 100),
    organs: organScores,
  };
}

module.exports = { PILLARS, ORGANS, organScore, overallScore, topDrivers, computeAll };
