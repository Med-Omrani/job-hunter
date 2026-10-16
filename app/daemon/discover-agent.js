#!/usr/bin/env node
'use strict';
// discover-agent.js -- the self-expanding loop.
//
// WHY
// The registry was 244 hand-found boards. It cannot grow on its own, so every new
// employer had to be noticed by a human. Google CSE was the obvious fix and is the
// wrong one: 100 queries/day, and confirming one employer costs several queries.
//
// This enumerates job boards out of Common Crawl instead -- a public index of
// crawled pages, no key, no daily quota -- and registers each one that passes the
// SAME verification gate the offline prober uses (probe-core.verifyHit). The gate
// is shared on purpose: a discovery loop with its own laxer idea of "valid" would
// fill the registry with boards nobody confirmed.
//
// THE SHAPE OF A RUN
//   for each vendor apex (boards.greenhouse.io, myworkdayjobs.com, ...)
//     Common Crawl -> URLs -> ats-from-url -> a board candidate
//     shuffle, because Common Crawl returns urlkey-sorted pages and an unshuffled
//     first-N only ever sees boards whose names start with '0' or '1'
//     skip boards we already have
//     verify (2 cheap API calls: postings must exist, and an empty 2nd crawl means
//       the platform honours ETags so the board can be polled at 180s)
//     register up to DISCOVER_CAP verified boards
//
// WHAT IS EXPECTED TO FAIL
// A Common Crawl snapshot is months old, so a good share of candidates are boards
// that have since closed and 404. Measured on a live sample: 5 of 10 Greenhouse
// boards verified, the rest 404'd or were empty. That is the gate working, not a
// bug -- and it is why the cap counts VERIFIED boards, not scanned URLs.
//
// Env:
//   DISCOVER=0            kill switch (monitor keeps the process alive, it no-ops)
//   DISCOVER_DRY_RUN=1    verify but never POST
//   DISCOVER_CAP=25       verified boards to register per run
//   DISCOVER_SCAN=400     URLs to sample per vendor before shuffling
//   DISCOVER_INTERVAL_MS=21600000  6h between runs
//   DISCOVER_VENDORS=...  comma-separated apexes (overrides the default list)
//   DISCOVER_SNAPSHOTS=1  how many Common Crawl snapshots to fall back through
//   DISCOVER_CONC=3       boards verified in parallel
//   DISCOVER_ONESHOT=1    run once and exit (testing)

const fs = require('fs');
const path = require('path');
const cc = require('./cc-index.js');
const ats = require('./ats-from-url.js');
const core = require('./probe-core.js');
const api = require('./api_client.js');

const DIR = __dirname;
const EVENTS = path.join(DIR, 'events-discover.log');
function log(ev) {
  const line = new Date().toISOString() + ' ' + JSON.stringify(ev);
  try { fs.appendFileSync(EVENTS, line + '\n'); } catch (_) {}
  if (process.env.VERBOSE || !process.env.DISCOVER_QUIET) console.log(line);
}

// Apexes that host many employers' boards under one domain. This is the whole
// trick that makes discovery cheap: one matchType=domain query per apex returns
// thousands of employers, instead of thousands of queries.
const DEFAULT_VENDORS = [
  'boards.greenhouse.io',
  // 'job-boards.greenhouse.io' was here and is gone: it enumerates cleanly and
  // yields zero boards on every run (dead legacy Greenhouse host). It cost three
  // futile retries each cycle. boards.greenhouse.io covers the vendor.
  'myworkdayjobs.com',
  'jobs.lever.co',
  'jobs.ashbyhq.com',
  'jobs.smartrecruiters.com',
  'recruitee.com',
  'eightfold.ai',
  'jobs.personio.de',
  'apply.workable.com',
  'jobs.tal.net',
  'successfactors.com',
  'successfactors.eu',
];

const num = (n, d) => { const v = Number(process.env[n]); return Number.isFinite(v) && v > 0 ? v : d; };
const flag = (n) => process.env[n] !== undefined && process.env[n] !== '0' && process.env[n] !== 'false';

// Deterministic shuffle. Common Crawl pages are sorted by urlkey, so taking the
// first N without shuffling means run after run only ever sees the same
// alphabetical prefix and the registry can never grow past it.
function shuffled(arr, seed) {
  const a = arr.slice();
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// Candidates that are almost certainly archived boards rather than live ones.
// A 32-char hex token is Greenhouse's legacy numeric-id form and every one of
// those sampled in testing answered 404; spending two API calls to re-confirm that
// on every run is pure waste.
function prefilter(h) {
  const t = String(h.token || '');
  if (/^[0-9a-f]{24,40}$/i.test(t)) return 'legacy-hex-token';
  if (/^\d{6,}$/.test(t) && t.length > 12) return 'long-numeric';
  return null;
}

// Everything the gate cannot tell us but a live crawl can: does the fleet have an
// adapter, and is the cadence sane?
function sourceIsUsable(h) {
  if (typeof core.CRAWL[h.type] !== 'function') return 'no-adapter:' + h.type;
  const ms = core.INTERVAL[h.type];
  if (!ms || ms < 60000 || ms > 86400000) return 'bad-interval';
  return null;
}

// Workday site paths are already URL-safe-ish (External_Careers, External), but
// normalise anyway so the source id stays a clean, stable key.
function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
}

function toSource(board) {
  const h = { type: board.type, token: board.token, tenant: board.tenant, site: board.site, host: board.host, companySlug: board.companySlug };
  // A Workday board's identity is tenant + site, not tenant alone. One tenant
  // routinely publishes several boards, and keying on the tenant collapsed them
  // into a single source: the first discovery run accepted 25 boards but
  // registered only 24 new sources for exactly this reason.
  let sid = board.id;
  if (h.type === 'workday' && h.tenant && h.site) {
    sid = 'workday-' + h.tenant + '-' + slug(h.site);
  }
  const src = core.normalizeSrc({ company: board.company, domain: board.domain || '' }, h, sid);
  src.registry = true;
  src.discoveredBy = 'commoncrawl';
  src.discoveredAt = new Date().toISOString();
  src.boardUrl = board.boardUrl || '';
  if (board.cheap304) src.cheap304 = true;
  return src;
}

async function knownKeys() {
  const keys = new Set();
  const ids = new Set();
  try {
    for (const s of await api.listSources()) {
      ids.add(s.id);
      // Reconstruct the key the same way the mapper does, so a board already
      // registered by hand or by an earlier run is recognised as known.
      // Prefer the authoritative tenant/site pair when the source carries one:
      // reconstructing it from the id breaks for ids that contain dashes in the
      // site part (e.g. workday-ag-airbus), which is exactly the shape the
      // toSource fix now produces.
      if (s.type === 'workday' && s.tenant && s.site) {
        keys.add('workday:' + s.tenant + '/' + s.site);
        continue;
      }
      const parts = String(s.id || '').split('-');
      const ty = parts[0];
      const tok = parts.slice(1).join('-');
      if (ty && tok) keys.add(ty + ':' + tok);
    }
  } catch (e) {
    log({ type: 'discover_warn', error: 'cannot list sources: ' + String(e.message || e).slice(0, 120) });
  }
  return { keys, ids };
}

async function runOnce(opts) {
  const o = Object.assign({ cap: num('DISCOVER_CAP', 25), blockUrls: num('DISCOVER_BLOCK_URLS', 120), conc: num('DISCOVER_CONC', 3), snapshots: num('DISCOVER_SNAPSHOTS', 1), seed: 1 }, opts || {});
  const vendors = (process.env.DISCOVER_VENDORS || DEFAULT_VENDORS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const { keys, ids } = await knownKeys();
  log({ type: 'discover_run_start', vendors: vendors.length, cap: o.cap, known: ids.size, dry: flag('DISCOVER_DRY_RUN') });

  const accepted = [];
  const stats = { scanned: 0, candidates: 0, skippedKnown: 0, skippedPrefilter: 0, skippedUnusable: 0, verified: 0, failed: 0, reasons: {}, byType: {} };

  for (const apex of vendors) {
    if (accepted.length >= o.cap) break;
    const found = new Map();
    // Stop on DISTINCT BOARDS, not on a URL budget. Common Crawl partitions its
    // index by URL-key hash, so a whole block is frequently one tenant's entire
    // board -- myworkdayjobs.com block 1 is 2925 URLs, every one of them
    // 2020companies. A URL budget of 250 therefore surfaced exactly ONE board from
    // the richest vendor we have. maxUrls stays as a per-block safety valve.
    const boardTarget = Math.max(8, o.cap * 3);
    let en = null;
    for (let attempt = 1; attempt <= 3 && found.size < boardTarget; attempt++) {
      found.clear();
      try {
        en = await cc.enumerateDomain(apex, null, (url) => {
          stats.scanned++;
          const h = ats.fromUrl(url);
          if (!h) return;
          const k = ats.keyFor(h);
          if (!k || found.has(k)) return;
          found.set(k, h);
        }, {
          shouldStop: () => found.size >= boardTarget,
          maxUrls: o.blockUrls || 120,
          snapshots: o.snapshots,
        });
      } catch (e) {
        log({ type: 'discover_vendor_error', apex, attempt, error: String(e.message || e).slice(0, 140) });
        await cc.sleep(2000 * attempt);
        continue;
      }
      if (found.size < boardTarget && attempt < 3 && en && (en.errors || []).length) {
        // Retry only on ERRORS. A vendor that enumerates cleanly and yields nothing
        // is genuinely empty -- job-boards.greenhouse.io is a dead legacy host -- and
        // retrying it three times burned ~40s per run to learn the same thing.
        log({ type: 'discover_vendor_retry', apex, attempt, boards: found.size, errors: en.errors.slice(0, 3) });
        await cc.sleep(3000 * attempt);
      }
    }
    if (!en || found.size === 0) {
      log({ type: 'discover_vendor_empty', apex, note: 'no board URLs found after retries' });
      continue;
    }
    stats.candidates += found.size;
    log({ type: 'discover_vendor', apex, urls: en.urls, boards: found.size, blocks: en.blocks, errors: (en.errors || []).length });

    // Shuffle, then skip what we cannot use or already have.
    const order = shuffled([...found.keys()], o.seed + accepted.length + apex.length);
    const queue = [];
    for (const k of order) {
      const h = found.get(k);
      if (keys.has(k)) { stats.skippedKnown++; continue; }
      const pf = prefilter(h);
      if (pf) { stats.skippedPrefilter++; continue; }
      const un = sourceIsUsable(h);
      if (un) { stats.skippedUnusable++; stats.reasons[un] = (stats.reasons[un] || 0) + 1; continue; }
      queue.push(h);
    }

    // Verify in parallel. `claimed` starts at the number already accepted this run, not
    // at zero: it was originally declared per-vendor, so each vendor got a FRESH
    // budget and a cap of 25 produced 42 registered boards.
    let i = 0;
    let claimed = accepted.length;
    const workers = Array.from({ length: Math.min(o.conc, queue.length) }, async () => {
      while (i < queue.length && claimed < o.cap) {
        const h = queue[i++];
        claimed++;
        const c = { id: 'probe-' + h.type + '-' + h.token, company: h.token, country: '', sector: '' };
        let r;
        try {
          r = await core.verifyHit(h, c, { verify: true }, h.boardUrl, 'commoncrawl:' + apex);
        } catch (e) {
          stats.failed++;
          stats.reasons['threw'] = (stats.reasons['threw'] || 0) + 1;
          continue;
        }
        if (!r.ok) {
          stats.failed++;
          const k = String(r.reason || 'unknown').replace(/:.*$/, '');
          stats.reasons[k] = (stats.reasons[k] || 0) + 1;
          continue;
        }
        stats.verified++;
        const board = r.board;
        board.domain = apex;
        keys.add(ats.keyFor(h));
        accepted.push({ hit: h, src: toSource(board) });
        stats.byType[h.type] = (stats.byType[h.type] || 0) + 1;
        log({ type: 'discover_accepted', type: h.type, token: h.token, items: board.items, cheap304: !!board.cheap304, via: h.boardUrl });
      }
    });
    await Promise.all(workers);
  }

  if (accepted.length && !flag('DISCOVER_DRY_RUN')) {
    let written = 0;
    for (const a of accepted) {
      try {
        await api.createSource(a.src);
        written++;
      } catch (e) {
        log({ type: 'discover_write_error', id: a.src.id, error: String(e.message || e).slice(0, 140) });
      }
    }
    log({ type: 'discover_written', count: written, requested: accepted.length });
  }

  log({ type: 'discover_run_done', stats, accepted: accepted.length, dry: flag('DISCOVER_DRY_RUN') });
  return { stats, accepted };
}

(async () => {
  // Opt-in by default: something that writes to the source registry stays inert
  // until DISCOVER is set, so a bad agents.json entry cannot start filling it.
  const enabled = flag('DISCOVER');
  if (!enabled) log({ type: 'discover_kill_switch', note: 'DISCOVER is not set; not registering sources' });
  if (enabled || flag('DISCOVER_ONESHOT')) {
    const interval = num('DISCOVER_INTERVAL_MS', 21600000);
    for (;;) {
      try {
        await runOnce();
      } catch (e) {
        log({ type: 'discover_fatal', error: String((e && e.stack) || e).slice(0, 400) });
      }
      if (flag('DISCOVER_ONESHOT')) return;
      await cc.sleep(interval);
    }
  }
})();