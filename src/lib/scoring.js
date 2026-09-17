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
  { id: 'en', name: 'Gut Toxicity — Daily Clearance Level', pct: 20,
    w: { g: .38, im: .14, lv: .28, ht: .06, br: .02, lu: .04, kd: .22, pk: .04 } },
  { id: 'rf', name: 'Unhealthy Food Burden — Living Food Intake', pct: 25,
    w: { g: .28, im: .26, lv: .20, ht: .18, br: .08, lu: .16, kd: .18, pk: .18 } },
  { id: 'ft', name: 'Frequent Eating — Daily Repair Window', pct: 30,
    w: { g: .14, im: .20, lv: .24, ht: .18, br: .32, lu: .10, kd: .16, pk: .52 } },
  { id: 'md', name: 'Thought Toxicity — Mind-Body Practice', pct: 15,
    w: { g: .056, im: .144, lv: .064, ht: .242, br: .322, lu: .147, kd: .080, pk: .050 } },
  { id: 'sl', name: 'Screen Overload — Circadian Sleep Quality', pct: 10,
    w: { g: .04, im: .16, lv: .05, ht: .12, br: .30, lu: .07, kd: .06, pk: .05 } },
];

const ORGANS = ['g', 'im', 'lv', 'ht', 'br', 'lu', 'kd', 'pk'];

/** Computes one organ's score (0-1) from a slider snapshot. */
function organScore(organId, snapshot) {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const p of PILLARS) {
    const w = p.w[organId] || 0;
    weightedSum += (snapshot[p.id] / 100) * w;
    weightTotal += w;
  }
  return weightTotal > 0 ? weightedSum / weightTotal : 0;
}

/** Computes the Overall AIDH Enquiry Score (0-1) from a slider snapshot. */
function overallScore(snapshot) {
  const andsCore = snapshot.en * (20 / 75) + snapshot.rf * (25 / 75) + snapshot.ft * (30 / 75);
  const mindBody = snapshot.md * (15 / 25) + snapshot.sl * (10 / 25);
  return (0.75 * (andsCore / 100) + 0.25 * (mindBody / 100));
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
