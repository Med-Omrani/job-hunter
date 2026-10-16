'use strict';
// ---- source trust floor ----------------------------------------------------
// Aggregators are not company boards. They re-post other employers' openings in
// bulk, and they do so in whatever language the employer happens to use, which
// is routinely not a language we target. Measured over a 6h window, `arbeitnow`
// ingested 2,375 postings and matched 96.0% of them on titles such as
// "Lohnbuchhalter:in / Payroll Specialist", "Steuerberater" and "Senior Campaign
// Analyst" -- each one carried a generic keyword ("Specialist", "Analyst",
// "Manager") that the keyword engine cannot tell apart from a real hit. A floor
// of 3 cuts that board to its 609 genuinely evidenced postings and sends the
// other 1,671 to the LLM band instead of the feed.
//
// A floor demotes weak hits so a source must earn more evidence before its
// postings reach the feed. It never deletes anything: a demoted posting with a
// real description still enters the ambiguous band, and the LLM -- the only
// component that actually reads the text -- can still promote it. That keeps the
// project rule intact: a keyword match may be re-ranked, never silently hidden.
//
// Extracted into its own module because hunter-fleet.js runs its crawler on
// require (no `require.main` guard), which makes it untestable in isolation.

// Only sources with a MEASURED false-positive rate are floored by default.
// Measured over the 6h window this was written in:
//
//   arbeitnow  2,375 offers, 2,280 matched (96.0%), avg score 1.87
//   jobijoba   2,326 offers, 2,247 matched (96.6%), avg score 2.11
//
// Only `arbeitnow` is floored. `jobijoba` is left alone deliberately: it is a
// real jobs board whose postings skew Tunisian and French, which is exactly the
// profile this app targets, and a floor of 2 there would cut 89% of its matches
// (2,247 -> 228). Flooring an on-target source because its raw match *rate* is
// high would be optimising a proxy and destroying the thing the proxy stands
// for. Anything else must be added from measurement, not from the source's
// reputation: add it to the registry as `minScore` on the source, or via
// SOURCE_MIN_SCORE.
const SOURCE_MIN_SCORE_DEFAULT = {
  arbeitnow: 3,
};

const MAX_FLOOR = 6;

// Format: "sourceId=score,sourceId=score". Env-tunable because which sources are
// noisy is an editorial judgement that shifts as the registry grows.
function parseSourceMinScore(spec, base) {
  const out = Object.assign({}, base || SOURCE_MIN_SCORE_DEFAULT);
  for (const pair of String(spec || '').split(',')) {
    const m = pair.split('=');
    if (m.length !== 2) continue;
    const id = m[0].trim().toLowerCase();
    const n = Number(m[1].trim());
    if (id && Number.isFinite(n)) out[id] = clampFloor(n);
  }
  return out;
}

function clampFloor(n) {
  return Math.max(0, Math.min(MAX_FLOOR, Math.round(Number(n) || 0)));
}

function buildSourceMinScore(spec, base) {
  return parseSourceMinScore(spec, base);
}

// The floor in force for one source. A per-source `minScore` in the source record
// wins over the map, so an individual board can be tightened without editing
// global config.
function sourceMinScore(src, table) {
  const own = Number(src && src.minScore);
  if (Number.isFinite(own) && own >= 0) return clampFloor(own);
  const id = String((src && src.id) || '').toLowerCase();
  const t = table || SOURCE_MIN_SCORE_DEFAULT;
  return clampFloor(t[id] || 0);
}

// Apply the floor to a keyword-engine result. Returns a new verdict; the input is
// never mutated, because scoreOffer() results may be shared with the band
// accounting below.
function applyFloor(sc, floor) {
  const score = Number((sc && sc.score) || 0);
  const match = !!(sc && sc.match);
  if (!floor || floor <= 0 || !match || score >= floor) {
    return { match, score, demoted: false, floor: floor || 0 };
  }
  return { match: false, score, demoted: true, floor };
}

module.exports = {
  SOURCE_MIN_SCORE_DEFAULT,
  MAX_FLOOR,
  parseSourceMinScore,
  buildSourceMinScore,
  sourceMinScore,
  applyFloor,
};
