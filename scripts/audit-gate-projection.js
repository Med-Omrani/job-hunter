'use strict';
// Pre-flight safety audit for enabling the tier-0 gate on the live backlog.
//
// The projection says the gate rejects 86% of pending. Before letting it write
// that many deletions, two questions have to be answered explicitly:
//
//   1. LEAK: did any in-scope posting (Tunisia, France, or remote) get rejected?
//      The candidate lives in Tunisia and works remotely, so a geography bug
//      here would delete exactly the offers that matter. This must be zero.
//   2. WHAT SURVIVES: of the rows the gate keeps, are they plausible candidates
//      or is the gate just passing everything through?
//
// Read-only. Usage: node scripts/audit-gate-projection.js <pending.jsonl>
const fs = require('fs');
const readline = require('readline');
const { tierZero } = require('../app/daemon/offer-gate.js');
const { resolveGeo, locationScope, norm } = require('../app/daemon/geo.js');

(async () => {
  const rl = readline.createInterface({
    input: fs.createReadStream(process.argv[2], { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const geoLeak = [];    // geo fired on something geo itself calls in-scope <-- impossible
  const nonGeoOnInScope = []; // rejected by seniority/family while in scope: CORRECT
  const survivors = [];   // kept by the gate
  let total = 0, rejected = 0, inScopeTotal = 0, inScopeKept = 0;

  for await (const line of rl) {
    if (!line || !line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    total++;
    const v = tierZero(o);

    // Independent re-derivation of scope from geo.js, so a bug in tierZero's
    // use of it cannot hide behind the same call.
    const geo = resolveGeo(o);
    const scope = locationScope(geo, ['TN', 'FR']);
    const isIn = scope === 'in';

    if (isIn) inScopeTotal++;
    if (v.verdict === 'reject') {
      rejected++;
      // The only failure that actually matters: the LOCATION rule deleting
      // something the location rule considers in scope.
      if (isIn && v.rules.includes('geo')) geoLeak.push({ o, geo, rules: v.rules });
      else if (isIn) nonGeoOnInScope.push({ o, rules: v.rules });
    } else {
      if (isIn) inScopeKept++;
      if (survivors.length < 60) {
        survivors.push({ t: o.title, l: o.location, c: o.country, scope, geo: geo.country });
      }
    }
  }

  console.log('pending rows examined      : ' + total);
  console.log('gate rejects               : ' + rejected + '  (' + (100 * rejected / total).toFixed(1) + '%)');
  console.log('gate keeps                 : ' + (total - rejected));
  console.log('');
  console.log('--- GEOGRAPHY LEAK (the one that must be zero) ---');
  console.log('rows geo considers in scope : ' + inScopeTotal);
  console.log('  of those, gate KEPT       : ' + inScopeKept);
  console.log('  of those, rejected by GEO : ' + geoLeak.length + (geoLeak.length ? '  <-- FAIL' : '   (zero, correct)'));
  console.log('  of those, rejected by SENIOR/FAMILY (legitimate, not a leak): ' + nonGeoOnInScope.length);
  console.log('');
  if (geoLeak.length === 0) {
    console.log('LEAK CHECK PASSED: the location rule never deletes an in-scope offer.');
  } else {
    console.log('!!! LEAK: ' + geoLeak.length + ' offers rejected by the GEO rule while in scope !!!');
    for (const l of geoLeak.slice(0, 25)) {
      console.log('  - ' + l.o.title + '  [' + l.o.location + '] -> ' + l.geo.country + ' rules=' + l.rules.join('+'));
    }
  }
  console.log('');
  console.log('=== 25 in-scope rows the gate REJECTED on seniority/family (spot-check) ===');
  for (const n of nonGeoOnInScope.slice(0, 25)) {
    console.log('  ' + String(n.o.title || '').slice(0, 64).padEnd(64) + ' | ' + String(n.o.location || '').slice(0, 24).padEnd(24) + ' | ' + n.rules.join('+'));
  }
  console.log('');
  console.log('=== 40 rows the gate KEEPS (first 40) ===');
  for (const s of survivors.slice(0, 40)) {
    console.log('  ' + String(s.t || '').slice(0, 66).padEnd(66) + ' | ' +
      String(s.l || '').slice(0, 26).padEnd(26) + ' | ' + (s.c || '-').padEnd(6) + ' | ' + s.scope);
  }
})().catch((e) => { console.error(e); process.exit(1); });