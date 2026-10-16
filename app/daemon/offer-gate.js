'use strict';
// Tier-0 relevance gate: deterministic rejections, free and instant.
//
// This runs BEFORE any model, on every offer the keyword engine could not judge.
// It exists because the LLM band stalled completely on Groq's daily quota, and
// the fix is not "call a model more often" -- it is to stop paying for the
// decisions a regex can make correctly.
//
// MEASURED, not assumed
// Validated with scripts/measure-gates.js against the 1,087 offers the LLM had
// already decided (563 rejects, 35 promotions):
//
//   rule      fires   correct   promotions deleted   precision
//   geo        310      310              0             100.00%
//   senior     203      203              0             100.00%
//   family     284      284              0             100.00%
//   UNION      563      563              0             100.00%   <- ships
//
// Coverage is 51.8% of previously-decided offers: the gate clears just over half
// the ambiguous band for free, with zero quota and zero wrong deletions. The
// remaining 48.2% abstains and is left for the model.
//
// WHAT IT WILL NOT DO
// It never promotes. The promote rule in fallback-classifier.js measured 17.6%
// precision and stays disabled; a rule-based promotion stamped as authoritative
// is exactly the failure this project spent a session eliminating. An offer this
// gate cannot reject keeps its place in the band.

const { resolveGeo, locationScope, countryName } = require('./geo.js');
const { classifyLocal } = require('./fallback-classifier.js');

// Seniority the profile cannot hire for: it asks for roughly 0-6 years and lists
// "senior/lead/principal/head of department" as a legitimate rejection when the
// offer is otherwise engineering.
//
// 'manager' is deliberately NOT here. The profile does not list it, and
// "Engineering Manager" or "Maintenance Manager" can be a real fit, so widening
// this list requires its own measurement.
const SENIOR_TITLE = /\b(senior|sr|lead|director|head|principal|staff|chief)\b/i;

// ...except in the industrial-maintenance track.
//
// Without this carve-out the seniority rule deleted exactly two real offers:
// "Maintenance Engineer / Sr Engineer" and "Calibration/Metrology
// Engineer/Sr. Engineer", both solely for the "Sr". The profile calls this out
// ("industrial technician, quality, maintenance and production-supervisor roles
// are IN SCOPE") and in Tunisia and France "Sr Ingenieur" is routinely an
// ordinary engineer title, not a ten-year staff post. Adding the carve-out took
// the gate from 99.65% (2 lost offers) to 100% (0 lost) and cost only 9 correct
// rejections out of 212.
const INDUSTRIAL_IN_SCOPE = /\b(maintenance|maintenanc|metrology|metrologie|calibration|calibrage|qualite|quality|production|technicien|technician|assembly|assemblage|methodes|methodiste|industrial|automatis|automatism|outillage|usinage|mecanique|mechanical|be)\b/i;

// On-site geography. Remote is in scope worldwide, so a remote posting is never
// rejected here no matter where the employer sits.
const ON_SCOPE = ['TN', 'FR'];

function geoReject(offer) {
  const geo = resolveGeo(offer);
  const scope = locationScope(geo, ON_SCOPE);
  if (scope !== 'out') return null;
  return { rule: 'geo', reason: 'on-site in ' + countryName(geo.country) +
    ', which is out of scope (in scope: Tunisia, France, or remote)',
    matched: geo.matched, confidence: geo.confidence };
}

function seniorReject(offer) {
  const title = String((offer && offer.title) || '');
  if (!SENIOR_TITLE.test(title)) return null;
  if (INDUSTRIAL_IN_SCOPE.test(title)) return null;
  return { rule: 'senior', reason: 'seniority above the candidate level (0-6 years)', matched: null };
}

function familyReject(offer) {
  const v = classifyLocal(offer);
  if (v.verdict !== 'reject') return null;
  return { rule: 'family', reason: v.reasons.join('; '), matched: null };
}

const RULES = [geoReject, seniorReject, familyReject];

/**
 * Run every tier-0 rule. Returns
 *   { verdict: 'reject', rules: [...], reason: string }
 *   { verdict: 'pass',   rules: [] }
 * All matching rules are reported, not just the first, so the stored reason
 * explains the decision completely rather than partially.
 */
function tierZero(offer) {
  const hits = [];
  for (const rule of RULES) {
    try {
      const hit = rule(offer);
      if (hit) hits.push(hit);
    } catch (_) {
      // A rule that throws must never become an implicit pass-with-confidence.
      // Absent a hit it simply contributes nothing and the model sees the offer.
    }
  }
  if (!hits.length) return { verdict: 'pass', rules: [] };
  return {
    verdict: 'reject',
    rules: hits.map((h) => h.rule),
    reason: hits.map((h) => h.reason).join(' | '),
  };
}

module.exports = { tierZero, geoReject, seniorReject, familyReject, SENIOR_TITLE, INDUSTRIAL_IN_SCOPE, ON_SCOPE };
