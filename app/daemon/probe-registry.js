#!/usr/bin/env node
'use strict';
// Registry builder (CLI).
//
// This used to hold the whole prober. The logic now lives in probe-core.js so the
// discovery loop can call the SAME verification gate in-process; what is left here
// is argument handling and reporting. If you are adding a detection rule or
// changing when a board is accepted, change probe-core.js -- this file must stay a
// thin wrapper or the two paths can drift and the loop will start registering
// boards that were never confirmed.
//
// Usage:
//   node probe-registry.js <candidates.json> [out.json]
//
// Candidates: [{ id, company, domain?, country?, sector?, name? }]
//
// Env:
//   PROBE_MODE=fingerprint|slug|both   how boards are found        (default both)
//   PROBE_VERIFY=0                     record hits, skip crawling  (default 1)
//   PROBE_CONC=4                       parallel candidates
//   PROBE_MAX_TRIES=26                 request budget per candidate
//   PROBE_TIMEOUT_MS=12000             per-request timeout
//   PROBE_HOST_GAP_MS=1200             min gap between requests to one host
//   PROBE_ROBOTS=0                     skip robots.txt checks
//   PROBE_BROWSER=0                    never launch a browser for bot-walled hosts
//   PROBE_NO_GUESS=1                   do not fall back to path guessing
//   LIST_BAD=1                         print every rejected candidate

const fs = require('fs');
const path = require('path');
const core = require('./probe-core.js');

const RAW = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const OUT = process.argv[3] || path.join(__dirname, 'registry', 'companies.json');
const CONC = Number(process.env.PROBE_CONC || 4);
const MODE = process.env.PROBE_MODE || 'fingerprint';
const VERIFY = process.env.PROBE_VERIFY !== '0';

(async () => {
  const ok = [];
  const bad = [];
  const byType = {};
  const seen = new Set();
  const queue = RAW.slice();
  let i = 0;

  const workers = Array.from({ length: CONC }, async () => {
    while (i < queue.length) {
      const c = queue[i++];
      if (seen.has(c.id)) continue;
      seen.add(c.id);

      let hits = [];
      let via = '';
      if (MODE !== 'slug') {
        const f = await core.fingerprint(c);
        hits = f.hits; via = f.via;
      }
      if (!hits.length && MODE !== 'fingerprint') {
        hits = await core.slugProbe(c);
        via = 'slug-probe';
      }
      if (!hits.length) { bad.push([c.id, 'no-ats-found']); continue; }

      if (!VERIFY) {
        // Discovery-only: record what the careers page exposes and move on.
        for (const h of hits.slice(0, 3)) {
          ok.push({ ...c, id: c.id + '-unverified', type: h.type, token: h.token, discovered: true, foundBy: MODE });
        }
        process.stdout.write(`seen ${c.id.padEnd(26)} ${hits.slice(0, 3).map((h) => h.type).join(',').padEnd(28)} <- ${c.company}\n`);
        continue;
      }

      // The gate: only a board that actually returns postings ships.
      const { board, failed } = await core.verifyHits(hits, c, { verify: true }, via, MODE);
      if (!board) {
        bad.push([c.id, 'verification-failed [' + failed.join('; ') + ']']);
        continue;
      }
      ok.push(board);
      byType[board.type] = (byType[board.type] || 0) + 1;
      process.stdout.write(
        `ok   ${board.id.padEnd(26)} ${String(board.items).padStart(4)} jobs  ${board.type}` +
        `${board.cheap304 ? ' 304' : ''}  <- ${board.company}\n`
      );
    }
  });
  await Promise.all(workers);

  fs.writeFileSync(OUT, JSON.stringify(ok, null, 1));
  console.log('\nverified', ok.length, '/', RAW.length, '->', OUT);
  console.log('by type', JSON.stringify(byType));
  // "no-ats-found" (no board we can reach) and "verification-failed" (a board
  // exists but our adapter could not read it) demand completely different
  // follow-up, so they are counted apart rather than lumped together.
  const reasons = {};
  for (const [, why] of bad) {
    const k = String(why).replace(/\[[^\]]*\]/, '[details]');
    reasons[k] = (reasons[k] || 0) + 1;
  }
  console.log('unresolved ' + bad.length + ': ' + JSON.stringify(reasons));
  if (process.env.LIST_BAD) console.log(bad.map((x) => x.join('  ')).join('\n'));
})().catch((e) => { console.error('PROBE FATAL', e); process.exit(1); });