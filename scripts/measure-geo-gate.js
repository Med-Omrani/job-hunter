'use strict';
// Measures the deterministic location gate (geo.js) against the offers the LLM
// already decided. Ships nothing; reports precision so the rule can be trusted
// or rejected on evidence.
//
// The dangerous direction is one-sided: a location the gate calls OUT that the
// LLM called a match. Every one of those is a real offer deleted by a regex.
const fs = require('fs');
const readline = require('readline');
const { resolveGeo, locationScope } = require('../app/daemon/geo.js');

const file = process.argv[2];
const sampleArg = process.argv.indexOf('--samples');
const SAMPLES = sampleArg > -1 ? Number(process.argv[sampleArg + 1]) : 20;

(async () => {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const m = { out_correct: 0, out_wrong: 0, in: 0, unknown: 0 };
  const wrongOnes = [];     // gate says out, LLM promoted  <-- the killer list
  let skipped = 0;
  const byCountry = new Map();

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

    const geo = resolveGeo({ location: row.location, country: row.country });
    const scope = locationScope(geo, ['TN', 'FR']);

    if (scope === 'out') {
      byCountry.set(geo.country, (byCountry.get(geo.country) || 0) + 1);
      if (truth) { m.out_wrong++; wrongOnes.push({ title: row.title, loc: row.location, country: geo.country, matched: geo.matched, reason }); }
      else m.out_correct++;
    } else if (scope === 'in') m.in++;
    else m.unknown++;
  }

  const decided = m.out_correct + m.out_wrong + m.in + m.unknown;
  const covered = m.out_correct + m.out_wrong;

  console.log('decided rows            : ' + decided + '  (undecided skipped: ' + skipped + ')');
  console.log('gate says OUT           : ' + covered + '  (' + (100 * covered / decided).toFixed(1) + '% of decided)');
  console.log('  of those, LLM agreed  : ' + m.out_correct);
  console.log('  of those, LLM PROMOTED: ' + m.out_wrong + '   <-- offers this rule would delete');
  console.log('');
  console.log('OUT precision           : ' + (covered ? (100 * m.out_correct / covered).toFixed(2) + '% (' + m.out_correct + '/' + covered + ')' : '-'));
  console.log('coverage of rejects     : ' + (m.out_correct ? (100 * m.out_correct / (m.out_correct + m.in + m.unknown)).toFixed(1) + '% of all gate decisions are correct rejects' : '-'));
  console.log('scope=in                : ' + m.in);
  console.log('scope=unknown (left to model): ' + m.unknown);
  console.log('');
  console.log('countries the gate sends OUT: ' + [...byCountry.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => c + '=' + n).join('  '));
  console.log('');
  console.log('=== LLM-PROMOTED offers the gate would REJECT (must be near zero) ===');
  if (!wrongOnes.length) console.log('(none)');
  for (const w of wrongOnes.slice(0, SAMPLES)) {
    console.log('- ' + w.title);
    console.log('    location="' + w.loc + '" -> ' + w.country + ' via "' + w.matched + '"');
    console.log('    llm promoted it, reason: ' + w.reason);
  }
})().catch((e) => { console.error(e); process.exit(1); });
