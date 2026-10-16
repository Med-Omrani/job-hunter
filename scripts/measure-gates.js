'use strict';
// Measures the whole deterministic tier-0 gate -- location, seniority, and the
// family veto -- against the LLM's existing decisions, then projects the win
// onto the live pending backlog.
//
// Reports precision for each rule and for the union, plus the union's effect on
// the decided corpus. The union is what actually ships, so the number that
// matters is "promoted offers deleted", which must stay at zero.
const fs = require('fs');
const readline = require('readline');
const { resolveGeo, locationScope } = require('../app/daemon/geo.js');
const { classifyLocal } = require('../app/daemon/fallback-classifier.js');

// Faithful to the profile, which names "senior/lead/principal/head of
// department" and 8+ years. Deliberately EXCLUDES 'manager': the profile does
// not list it, and "Engineering Manager" or "Maintenance Manager" can be a real
// fit, so widening this list needs its own measurement.
const SENIOR_TITLE = /\b(senior|sr|lead|director|head|principal|staff|chief)\b/i;

// Carve-out for the industrial-maintenance track. The first measurement of this
// gate deleted exactly two real offers -- "Maintenance Engineer / Sr Engineer"
// and "Calibration/Metrology Engineer/Sr. Engineer" -- both purely for "Sr".
// The profile states this failure mode explicitly ("industrial technician,
// quality, maintenance and production-supervisor roles are IN SCOPE"), and in
// Tunisia and France "Sr Ingenieur" is routinely an ordinary engineer title
// rather than a 10-year staff post. So a seniority word only counts when the
// title is NOT in that domain.
const INDUSTRIAL_IN_SCOPE = /\b(maintenance|maintenanc|metrology|metrologie|calibration|calibrage|qualite|quality|production|technicien|technician|assembly|assemblage|methodes|methodiste|industrial|automatis|automatism|outillage|usinage|mecanique|mechanical|be\b)\b/i;

function seniorFires(title) {
  if (!SENIOR_TITLE.test(title)) return false;
  if (INDUSTRIAL_IN_SCOPE.test(title)) return false;
  return true;
}

(async () => {
  const rl = readline.createInterface({
    input: fs.createReadStream(process.argv[2], { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const rules = {
    geo: { n: 0, correct: 0, wrong: 0 },
    senior: { n: 0, correct: 0, wrong: 0 },
    family: { n: 0, correct: 0, wrong: 0 },
    union: { n: 0, correct: 0, wrong: 0 },
    abstain: { n: 0 },
  };
  const deleted = [];
  let skipped = 0;

  for await (const line of rl) {
    if (!line || !line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const v = row.verdict;
    let truth = null, reason = '';
    if (v && typeof v === 'object' && typeof v.match === 'boolean') { truth = v.match; reason = v.reason || ''; }
    else if (row.band === 'promoted') truth = true;
    else if (row.band === 'rejected') truth = false;
    if (truth === null) { skipped++; continue; }

    const title = row.title || '';
    const geo = resolveGeo({ location: row.location, country: row.country });
    const hit = {
      geo: locationScope(geo, ['TN', 'FR']) === 'out',
      senior: seniorFires(title),
      family: classifyLocal({ title, description: '' }).verdict === 'reject',
    };

    let any = false;
    for (const k of ['geo', 'senior', 'family']) {
      if (!hit[k]) continue;
      any = true;
      rules[k].n++;
      if (truth) { rules[k].wrong++; } else rules[k].correct++;
    }
    if (any) {
      rules.union.n++;
      if (truth) { rules.union.wrong++; deleted.push({ title, loc: row.location, reason, which: Object.keys(hit).filter((k) => hit[k]).join('+') }); }
      else rules.union.correct++;
    } else rules.abstain.n++;
  }

  const pct = (r) => (r.n ? (100 * r.correct / r.n).toFixed(2) + '%  (' + r.correct + '/' + r.n + ')' : '-');
  const decided = rules.union.n + rules.abstain.n;

  console.log('decided rows: ' + decided + '   undecided skipped: ' + skipped);
  console.log('');
  console.log('rule       fires   correct   promoted-deleted   precision');
  for (const k of ['geo', 'senior', 'family', 'union']) {
    const r = rules[k];
    console.log(k.padEnd(10) + String(r.n).padStart(5) + String(r.correct).padStart(9) + String(r.wrong).padStart(19) + '   ' + pct(r));
  }
  console.log('');
  console.log('union coverage of decided rows : ' + (100 * rules.union.n / decided).toFixed(1) + '%');
  console.log('abstains (left to the model)   : ' + rules.abstain.n + '  (' + (100 * rules.abstain.n / decided).toFixed(1) + '%)');
  console.log('');
  if (deleted.length) {
    console.log('=== LLM-PROMOTED offers the union would DELETE (must be 0) ===');
    for (const d of deleted.slice(0, 25)) {
      console.log('- ' + d.title + '  [' + d.loc + ']  via ' + d.which);
      console.log('    llm promoted it: ' + d.reason);
    }
  } else {
    console.log('=== zero LLM-promoted offers deleted ===');
  }
})().catch((e) => { console.error(e); process.exit(1); });
