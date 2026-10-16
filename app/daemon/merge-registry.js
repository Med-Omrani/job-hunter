'use strict';
// Additive merge of probe-registry.js output into registry/companies.json.
//
// WHY THIS EXISTS
// probe-registry.js writes ONLY the boards it verified in the current run to its
// OUT file (`fs.writeFileSync(OUT, ok)`). Pointing OUT straight at
// registry/companies.json would therefore DELETE the 149 boards that were already
// verified in earlier passes, and seed-registry.js --prune would then disable
// every real source in the API. This script is the only sanctioned way to grow
// the registry: it reads the existing file, folds the new run in by id, and
// rewrites the union. Re-running it is a no-op.
//
// Usage:
//   node merge-registry.js <probe-output.json> [more.json ...]
//   node merge-registry.js --dry-run <probe-output.json>

const fs = require('fs');
const path = require('path');

const TARGET = path.join(__dirname, 'registry', 'companies.json');

function readArr(p) {
  if (!p) return [];
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    console.error('unreadable ' + p + ': ' + e.message);
    return [];
  }
  return Array.isArray(j) ? j : [];
}

const dry = process.argv.includes('--dry-run');
const inputs = process.argv.slice(2).filter((a) => !a.startsWith('--'));

if (!inputs.length) {
  console.error('usage: node merge-registry.js [--dry-run] <probe-output.json> [...]');
  process.exit(1);
}

let existing = readArr(TARGET);
const before = existing.length;
const byId = new Map(existing.map((c) => [c.id, c]));
let added = 0;
let dup = 0;
let invalid = 0;

for (const f of inputs) {
  for (const c of readArr(f)) {
    // Same admission rule as probe-registry/seed-registry: an entry without an id,
    // a type or a token can never be crawled, so it must not enter the registry.
    if (!c || !c.id || !c.type || !c.token) { invalid++; continue; }
    if (byId.has(c.id)) { dup++; continue; }
    byId.set(c.id, c);
    added++;
  }
}

const merged = [...byId.values()];
console.log('existing ' + before + ' + new ' + added + ' (dup ' + dup + ', invalid ' + invalid + ') = ' + merged.length);

if (dry) { console.log('--dry-run, ' + TARGET + ' unchanged'); process.exit(0); }

const tmp = TARGET + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(merged, null, 1));
fs.renameSync(tmp, TARGET);
console.log('wrote ' + merged.length + ' boards -> ' + TARGET);
