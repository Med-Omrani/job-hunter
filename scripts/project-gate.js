'use strict';
// Read-only projection of the tier-0 gate over the live pending backlog.
// Writes nothing. Answers: how much of the 11.7k backlog does the gate clear for
// free, and what is left for a real model?
//
//   node scripts/project-gate.js <pending.jsonl>
const fs = require('fs');
const readline = require('readline');
const { tierZero } = require('../app/daemon/offer-gate.js');

(async () => {
  const rl = readline.createInterface({
    input: fs.createReadStream(process.argv[2], { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let total = 0, rejected = 0, passed = 0;
  const byRule = {}, byCombo = {}, samples = [];
  const bad = [];

  for await (const line of rl) {
    if (!line || !line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { bad.push(line.slice(0, 80)); continue; }
    total++;
    let v;
    try { v = tierZero(o); } catch (e) { bad.push('THROW ' + String(e.message)); continue; }
    if (v.verdict === 'reject') {
      rejected++;
      for (const r of v.rules) byRule[r] = (byRule[r] || 0) + 1;
      byCombo[v.rules.sort().join('+')] = (byCombo[v.rules.sort().join('+')] || 0) + 1;
      if (samples.length < 400) samples.push({ t: o.title, l: o.location, r: v.rules.join('+') });
    } else passed++;
  }

  console.log('pending rows        : ' + total + (bad.length ? '  (unparsed/threw: ' + bad.length + ')' : ''));
  console.log('gate REJECTS        : ' + rejected + '   (' + (100 * rejected / total).toFixed(1) + '%)');
  console.log('gate passes to model: ' + passed + '   (' + (100 * passed / total).toFixed(1) + '%)');
  console.log('');
  console.log('individual rules (a row can fire several):');
  for (const [k, n] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + k.padEnd(8) + String(n).padStart(6) + '   (' + (100 * n / total).toFixed(1) + '% of backlog)');
  }
  console.log('');
  console.log('rule combinations:');
  for (const [k, n] of Object.entries(byCombo).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + k.padEnd(24) + String(n).padStart(6));
  }
  console.log('');
  console.log('sample of rejects (title | location | rules) - first 30:');
  for (const s of samples.slice(0, 30)) {
    console.log('  ' + String(s.t || '').slice(0, 62).padEnd(62) + ' | ' + String(s.l || '').slice(0, 28).padEnd(28) + ' | ' + s.r);
  }
  if (bad.length) {
    console.log('');
    console.log('=== problems (first 5) ===');
    for (const b of bad.slice(0, 5)) console.log('  ' + b);
  }
})().catch((e) => { console.error(e); process.exit(1); });