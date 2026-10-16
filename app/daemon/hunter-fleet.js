'use strict';
// Wide-coverage hunter fleet (2026-09-27).
//
// WHY THIS EXISTS
// The previous design ran one OS process per source (node hunter-agent.js <id>,
// one entry per agents.json). That is fine for 21 sources and impossible for the
// ~800 we now want: 21 node processes already cost 1.7 GB RSS (~80 MB each), so
// 800 would need ~64 GB and 800 supervised pids. The fleet runs every source in
// ONE process with a scheduler, which is what makes a 60s cadence affordable.
//
// WHAT IT CHANGES
// - cadence: the old agent ticked every 300s, so no source could ever be
//   fresher than 5 minutes no matter what intervalMs said. The fleet schedules
//   per source, so intervalMs is now honoured exactly.
// - freshness: offers are written with INSERT ... ON CONFLICT DO NOTHING, so a
//   re-crawl can never reset updated_at and make the whole market look brand
//   new. Only genuinely new postings are inserted and broadcast on /ws/offers.
//
// POLITENESS
// Per-host minimum gap + per-host daily request budget + exponential backoff on
// failure, because hundreds of boards behind a handful of shared hosts
// (boards-api.greenhouse.io, api.lever.co, ...) is exactly how an IP gets
// throttled. Cadence is per ATS capability, see registry/companies.json:
//   - ETag-capable (greenhouse/ashby/personio): 60s, a poll that finds no change
//     is a 304 and transfers nothing.
//   - non-conditional (lever/workday/smartrecruiters/rss/html): 15 min, because
//     Lever re-serves the full board (8 MB for a 780-posting site) no matter
//     what we send. Verified: api.lever.co ignores If-None-Match entirely.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const api = require('./api_client.js');
const adapters = require('./adapters.js');
const { scoreOffer } = require('./engine.js');
const sourceTrust = require('./source-trust.js');
const { computePostedAt } = require('./posted-time');

const DIR = __dirname;
const EVENTS = path.join(DIR, 'events-fleet.log');
const ETAG_FILE = path.join(DIR, '.fleet-etag.json');
const DEDUPE_FILE = path.join(DIR, '.fleet-dedupe.json');
// The ambiguous band gets its OWN dedupe set, separate from `dedupe`.
// `dedupe` is only ever populated from offers that PASSED the keyword engine, so
// an unmatched posting was re-counted as "unmatched" on every single poll of its
// board -- the raw unmatched number is a count of poll sightings, not of distinct
// jobs. Sizing the band needs distinct jobs, hence a second set. Kept separate
// (rather than sharing `dedupe`) so that enabling the band cannot change which
// MATCHED offers are considered new.
const BAND_FILE = path.join(DIR, '.fleet-band-dedupe.json');
// Minimum description length for a rejected offer to be worth classifying.
// ~200 chars is roughly a paragraph: below that the verdict rests on the title
// alone, which the keyword engine has already had. Env-tunable because the right
// value depends on how many ATS boards actually serve descriptions.
const BAND_MIN_DESC = Math.max(0, Number(process.env.RELEVANCE_BAND_MIN_DESC || 200));
// Per-cycle cap on band description fetches, per source crawl.
const BAND_ENRICH_MAX = Math.max(0, Number(process.env.RELEVANCE_BAND_ENRICH_MAX || 40));
// Per-source cap on band candidates stored in one crawl.
const BAND_MAX_PER_SOURCE = Math.max(0, Number(process.env.RELEVANCE_BAND_MAX_PER_SOURCE || 25));
// ---- source trust floor ----------------------------------------------------
// See source-trust.js for the measurement behind this and for why the floor
// demotes rather than deletes. Configuration lives there so it can be unit
// tested: this file starts its crawler on require and so cannot be.
const SOURCE_MIN_SCORE = sourceTrust.buildSourceMinScore(process.env.SOURCE_MIN_SCORE);

// Kill switch. Band collection and enrichment are OFF unless this is '1', so the
// existing keyword-only pipeline keeps working untouched if the LLM path is
// unwanted or the provider is down.
const BAND_ENABLED = String(process.env.RELEVANCE_BAND || '0') === '1';
const HUNT_FILE = path.join(DIR, '.hunt-cache.json');

const SHARD = Math.max(0, Number(process.env.FLEET_SHARD || 0));
const SHARDS = Math.max(1, Number(process.env.FLEET_SHARDS || 1));
const CONCURRENCY = Math.max(1, Number(process.env.FLEET_CONCURRENCY || 8));
// Minimum gap between two requests to the SAME host. 800 boards behind 4 shared
// hosts is 13 req/s from one IP if unpaced; this spreads it out.
const HOST_GAP_MS = Math.max(0, Number(process.env.FLEET_HOST_GAP_MS || 1500));
const HOST_DAILY_BUDGET = Math.max(50, Number(process.env.FLEET_HOST_DAILY_BUDGET || 20000));
const SOURCE_REFRESH_MS = 60000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

function log(ev) {
  const line = JSON.stringify({ ts: new Date().toISOString(), proc: 'fleet', shard: SHARD, ...ev });
  try { fs.appendFileSync(EVENTS, line + '\n'); } catch (_) {}
  if (process.env.VERBOSE) console.log(line);
}

function shardOf(id) {
  if (SHARDS <= 1) return 0;
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % SHARDS;
}

// ------------------------- adapters (legacy + new ATS) -------------------------
const LEGACY = require('./legacy-adapters.js');
const AGG = require('./aggregators.js');
// Legacy parsers and the aggregators both log board_blocked / board_error
// events; bind them to the fleet log so one process still tells us why a board
// is silent. bindLog replaces the sink that setLogSink installed.
const fleetLogSink = (ev) => log({ src: 'legacy', ...ev });
LEGACY.setLogSink(fleetLogSink);
AGG.bindLog(fleetLogSink);
const ADAPTERS = { ...LEGACY.ADAPTERS, ...adapters.ATS, arbeitnow: AGG.arbeitnow, jobicy: AGG.jobicy, keejob: AGG.keejob };

// ------------------------- shared state -------------------------
const sources = new Map();      // id -> source doc (from API)
const state = new Map();        // id -> { nextAt, fails, lastAt, lastError, lastAdded, notModified }
const hostNext = new Map();     // host -> earliest next allowed request ms
const hostCount = new Map();    // host -> { day, n }
const dedupe = new Set();       // md5(title|company) across ALL sources
const bandDedupe = new Set();  // same key space, but only offers that FAILED the keyword engine
let profileKw = [];
let profileAt = 0;
let forceAll = false;
// `unmatched`/`internships`/`dups` are the filter's full accounting. They were
// computed per crawl (crawlSource) but never surfaced anywhere, so the only
// evidence of what matchedOnly actually drops came from `source_added`, which
// fires ONLY when inserted > 0 -- a sample biased toward productive sources.
// These cumulative totals are accumulated on EVERY crawl, zero-insert included,
// so fleet_tick/fleet_heartbeat give an unbiased read of the funnel and the
// ambiguous band (see relevance-worker) can be sized from measured numbers.
let stats = {
  cycles: 0, requests: 0, notModified: 0, inserted: 0, errors: 0, offers: 0,
  items: 0, matched: 0, unmatched: 0, internships: 0, blocked: 0, dups: 0, demoted: 0,
  bandUnique: 0, bandDups: 0, bandWithDesc: 0, bandNoDesc: 0, bandDescChars: 0, bandFetches: 0, bandInserted: 0, bandOverflow: 0,
};

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function saveJsonAtomic(file, obj) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  } catch (_) {}
}

adapters.etagLoad(loadJson(ETAG_FILE, {}));
try { for (const k of loadJson(DEDUPE_FILE, [])) dedupe.add(k); } catch (_) {}
try { for (const k of loadJson(BAND_FILE, [])) bandDedupe.add(k); } catch (_) {}

setInterval(() => { adapters.etagAll && saveJsonAtomic(ETAG_FILE, adapters.etagAll()); }, 60000).unref?.();
setInterval(() => { saveJsonAtomic(DEDUPE_FILE, [...dedupe].slice(-200000)); }, 120000).unref?.();
setInterval(() => { saveJsonAtomic(BAND_FILE, [...bandDedupe].slice(-200000)); }, 120000).unref?.();

async function getProfileKw() {
  if (Date.now() - profileAt < 15 * 60 * 1000) return profileKw;
  profileAt = Date.now();
  try {
    const p = await api.getProfile();
    if (p && Array.isArray(p.keywords)) profileKw = p.keywords;
  } catch (_) {}
  return profileKw;
}

// ------------------------- politeness -------------------------
function hostOf(url) {
  try { return new URL(url).hostname; } catch (_) { return ''; }
}
function dayKey() { return new Date().toISOString().slice(0, 10); }

async function politeSlot(url) {
  const host = hostOf(url);
  if (!host) return true;
  const c = hostCount.get(host);
  if (!c || c.day !== dayKey()) hostCount.set(host, { day: dayKey(), n: 0 });
  const rec = hostCount.get(host);
  if (rec.n >= HOST_DAILY_BUDGET) return false;
  const now = Date.now();
  const allowed = hostNext.get(host) || 0;
  if (allowed > now) await new Promise((r) => setTimeout(r, Math.min(allowed - now, 30000)));
  hostNext.set(host, Date.now() + HOST_GAP_MS);
  rec.n++;
  stats.requests++;
  return true;
}

function statusOf(err) {
  const m = String((err && err.message) || err || '').match(/HTTP (\d{3})/);
  return m ? Number(m[1]) : 0;
}

// ------------------------- crawl one source -------------------------
// A representative URL per ATS, so the host pacing/budget is applied without
// having to run the adapter first (which is the request we are trying to pace).
const PROBE_URL = {
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${s.token}/jobs`,
  lever: (s) => `https://api.lever.co/v0/postings/${s.token}?mode=json`,
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s.token}`,
  personio: (s) => `https://${s.token}.jobs.personio.de/xml`,
  recruitee: (s) => `https://${s.token}.recruitee.com/api/offers/`,
  workable: (s) => `https://apply.workable.com/api/v1/widget/accounts/${s.token}`,
  smartrecruiters: (s) => `https://api.smartrecruiters.com/v1/companies/${s.companyId}/postings?limit=100`,
  eightfold: (s) => `https://${s.token}.eightfold.ai/api/proxy/sdss/listings`,
  workday: (s) => `${(s.base || 'https://' + s.token).replace(/\/$/, '')}/wday/cxs/${s.token}/jobs`,
  capgemini: () => 'https://www.capgemini.com/careers/en/search-jobs/',
  remotive: () => 'https://remotive.com/api/remote-jobs?limit=100',
  remoteok: () => 'https://remoteok.com/api',
  arbeitnow: () => 'https://www.arbeitnow.com/api/job-board-api?page=1',
  jobicy: () => 'https://jobicy.com/api/v2/remote-jobs',
  keejob: () => 'https://www.keejob.com/llms-full.txt',
};
function probeUrlFor(src) {
  const f = PROBE_URL[src.type];
  if (f) { try { return f(src) || ''; } catch (_) { return ''; } }
  if (src.type === 'rss') return src.url || '';
  if (src.type === 'html') return (src.url || '').replace('%Q%', 'a');
  if (src.type === 'linkedin') return src.url || '';
  return '';
}

function offerId(sourceId, ref) {
  return String(sourceId).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
    + '-' + String(ref).replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 60);
}

function isInternship(it) {
  const contract = String(it.contract || '').trim().toLowerCase();
  if (/^(stage|intern|internship|alternant|alternance|vie)$/.test(contract)) return true;
  return /\b(stage|stages|stagiaire|stagiaires|intern|interns|internship|internships|alternance|alternant|apprentissage|apprenti|apprentis)\b/i.test(String(it.title || ''));
}

// Greenhouse's list endpoint has no description. Only matched offers pay for a
// detail call, so the poll stays cheap while scoring still sees the full text.
async function enrichAtsDetail(it) {
  const d = it._detail;
  // Workday: the list endpoint carries no body at all, so the description only
  // exists behind the per-posting detail endpoint. Returns {description} plus
  // `confirmed` when the board answered and genuinely had no body, so the caller
  // can stop re-fetching a posting that will never gain text.
  if (it._wdBase && it._wdPath && !it.description) {
    const url = it._wdBase + it._wdPath;
    try {
      if (!(await politeSlot(url))) return {};
      const r = await adapters.http(url);
      if (!r.ok) return {};
      const info = (await r.json()).jobPostingInfo || {};
      const html = String(info.jobDescription || '');
      return { description: adapters.stripHtml(html).slice(0, 4000), confirmed: true };
    } catch (_) { return {}; }
  }
  if (!d || d.ats !== 'greenhouse' || it.description) return {};
  try {
    if (!(await politeSlot(`https://boards-api.greenhouse.io/v1/boards/${d.token}/jobs/${d.id}`))) return {};
    const r = await adapters.http(`https://boards-api.greenhouse.io/v1/boards/${d.token}/jobs/${d.id}`);
    if (!r.ok) return {};
    const j = await r.json();
    return { description: adapters.stripHtml(j.content || '').slice(0, 4000) };
  } catch (_) { return {}; }
}

async function crawlSource(src, opts = {}) {
  const id = src.id;
  const fn = ADAPTERS[src.type];
  if (!fn) {
    log({ type: 'no_adapter', id, ats: src.type });
    return { skipped: 'no_adapter' };
  }
  const url = probeUrlFor(src);
  if (url && !(await politeSlot(url))) {
    log({ type: 'host_budget', id, host: hostOf(url) });
    return { skipped: 'host_budget' };
  }
  const items = await fn(src);
  if (!items || !items.length) return { items: 0, inserted: 0 };

  const kw = await getProfileKw();
  const now = Date.now();
  const matchedOnly = src.matchedOnly !== false;
  const floor = sourceTrust.sourceMinScore(src, SOURCE_MIN_SCORE);
  const offers = [];
  let matched = 0;
  let internships = 0;
  let blocked = 0;
  let dups = 0;
  let unmatched = 0;
  // Demoted by the source trust floor (see SOURCE_MIN_SCORE above). Counted
  // apart from `unmatched` so the funnel shows how much of a board's traffic the
  // floor is responsible for, rather than hiding it inside the keyword verdict.
  let demoted = 0;
  // Ambiguous band: unique (never-before-seen) offers the keyword engine rejected.
  // `unmatched` counts poll sightings; bandUnique counts distinct jobs.
  let bandUnique = 0;
  let bandDups = 0;
  let bandWithDesc = 0;
  let bandNoDesc = 0;
  let bandDescChars = 0;
  let bandFetches = 0;
  let bandOverflow = 0;
  const bandOffers = [];
  // Per-cycle cap on description fetches for band candidates. Without it, one
  // 1,004-posting tenant board turns every sweep into a request storm.
  let bandBudget = BAND_ENRICH_MAX;
  const bandSamples = [];

  for (const it of items) {
    if (!it || !it.ref || !it.title) continue;
    if (isInternship(it)) { internships++; continue; }
    const sc = scoreOffer(it.title, it.description || '', kw);
    // BLOCKLIST titles are dropped here, before the band: staging them just
    // handed sales offers to the LLM for semantic promotion, and storing them
    // at score 0 fed the "Tous" feed. Same treatment as internships.
    if (sc.blocked) { blocked++; continue; }
    // Source trust floor: demote, never delete.
    const floored = sourceTrust.applyFloor(sc, floor);
    const effMatch = floored.match;
    const demotedHere = floored.demoted;
    if (demotedHere) demoted++;
    // Key computed BEFORE the match test so the ambiguous band can be deduped too.
    const key = crypto.createHash('md5')
      .update(adapters.clean(it.title).toLowerCase() + '|' + adapters.clean(it.company || '').toLowerCase())
      .digest('hex');
    if (matchedOnly && !effMatch) {
      unmatched++;
      if (demotedHere) unmatched--; // counted once, as `demoted`
      if (!BAND_ENABLED) continue;
      if (bandDedupe.has(key)) { bandDups++; continue; }
      // Enrich BEFORE deciding, because an un-described posting cannot be
      // classified by anything -- neither keywords nor an LLM. Over budget we
      // deliberately do NOT mark it seen, so the next poll of this board retries
      // it; that keeps the band bounded without needing a separate retry queue.
      let desc = String(it.description || '');
      let confirmed = false;
      if (desc.length < BAND_MIN_DESC) {
        if (bandBudget > 0) {
          bandBudget--;
          const e = await enrichAtsDetail(it);
          if (e.description) { desc = e.description; bandFetches++; }
          if (e.confirmed) confirmed = true;
        }
      } else bandFetches++;
      if (desc.length < BAND_MIN_DESC) {
        // Nothing left to learn from this posting: either the board confirmed it
        // has no body, or we are out of budget and must come back next cycle.
        if (confirmed) bandDedupe.add(key);
        bandNoDesc++;
        continue;
      }
      bandUnique++;
      bandWithDesc++;
      bandDescChars += Math.min(desc.length, 4000);
      bandSamples.push({ id, ref: String(it.ref), title: adapters.clean(it.title).slice(0, 160), company: adapters.clean(it.company || src.company || '').slice(0, 80), descLen: desc.length });
      // Queue for the band, but only up to a per-source cap: one 1,000-posting
      // board must not be able to fill the entire staging area on a single poll.
      //
      // Overflowing candidates are deliberately NOT marked as seen. Marking them
      // (which is what bandDedupe.add above used to do for every candidate)
      // silently discarded 411 classifiable offers per cycle -- 27% of the
      // recoverable set, gone for good, from a cap that was only ever meant to
      // bound one poll's insert. Leaving them unmarked makes the next poll of
      // that board retry them, which is the same mechanism the description budget
      // uses and costs nothing extra.
      if (bandOffers.length < BAND_MAX_PER_SOURCE) {
        bandDedupe.add(key);
        bandOffers.push({
          id: offerId(id, it.ref),
          ref: String(it.ref),
          title: adapters.clean(it.title),
          company: adapters.clean(it.company || src.company || ''),
          link: it.link || '',
          applyUrl: it.applyUrl || '',
          location: it.location || '',
          country: it.country || '',
          companyCountry: src.companyCountry || '',
          contract: it.contract || '',
          source: src.name || id,
          sourceId: id,
          sector: src.sector || '',
          salary: it.salary || '',
          remote: String(it.remote || ''),
          description: desc.slice(0, 4000),
          postedAt: computePostedAt(it, now) ? computePostedAt(it, now).toISOString() : new Date().toISOString(),
          agentNote: `En attente de validation semantique (${src.name || id})`,
          bandFrom: demotedHere ? 'source-floor' : 'keyword-unmatched',
          bandScore0: sc.score || 0,
          bandKeywords: sc.matches || [],
          bandSourceFloor: demotedHere ? floor : undefined,
        });
      } else bandOverflow++;
      continue;
    }
    matched++;
    if (dedupe.has(key)) { dups++; continue; }
    dedupe.add(key);

    let final = { ...it };
    if (sc.match && !final.description) {
      const d = await enrichAtsDetail(it);
      if (d && d.description) final = { ...final, ...d };
    }
    const rsc = scoreOffer(final.title, final.description || '', kw);
    const postedAt = computePostedAt(final, now);
    offers.push({
      id: offerId(id, it.ref),
      ref: String(it.ref),
      title: adapters.clean(final.title),
      company: adapters.clean(final.company || src.company || ''),
      link: final.link || '',
      applyUrl: final.applyUrl || '',
      location: final.location || '',
      // The offer's own country, resolved by the adapter from the posting text
      // alone. Never the source's country: inheriting it here is what made a
      // Vinci job advertised from its Palo Alto HQ show up as country 'TN'.
      country: final.country || '',
      // The employer's country, kept alongside so "which Tunisian companies are
      // hiring" stays answerable without lying about any single posting.
      //
      // ONLY an explicit src.companyCountry counts. This used to be src.country,
      // which is the BOARD's posting region, so a Tunisia-targeted board stamped
      // companyCountry 'TN' onto every posting from it: Valeo, Vinci, Airbus and
      // ForvisMazars were all recorded as Tunisian-headquartered employers, and
      // Coupang's Korean board stamped 'KR'. src.country says where jobs are
      // advertised, never where the employer is based, so it must not reach this
      // field. Absent a curated employer-country dataset the honest value is ''.
      companyCountry: src.companyCountry || '',
      contract: final.contract || '',
      source: src.name || id,
      sourceId: id,
      sector: src.sector || '',
      salary: final.salary || '',
      remote: String(final.remote || ''),
      score: rsc.score,
      match: rsc.match,
      keywords: rsc.matches,
      status: 'new',
      boardHint: final._detail && final._detail.ats ? final._detail.ats : '',
      description: String(final.description || '').slice(0, 4000),
      postedAt: postedAt ? postedAt.toISOString() : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      agentNote: rsc.match ? `Correspond a ton profil (${src.name || id})` : `Trouve par ${src.name || id}`,
    });
    if (offers.length >= 400) break;
  }

  let inserted = 0;
  if (offers.length) {
    for (let i = 0; i < offers.length; i += 200) {
      const batch = offers.slice(i, i + 200);
      const r = await api.insertNewOffers(batch);
      inserted += Number(r.inserted || 0);
    }
  }
  stats.inserted += inserted;
  stats.offers += offers.length;
  stats.items += items.length;
  stats.matched += matched;
  stats.unmatched += unmatched;
  stats.demoted += demoted;
  stats.internships += internships;
  stats.blocked += blocked;
  stats.dups += dups;
  stats.bandUnique += bandUnique;
  stats.bandDups += bandDups;
  stats.bandWithDesc += bandWithDesc;
  stats.bandNoDesc += bandNoDesc;
  stats.bandDescChars += bandDescChars;
  stats.bandFetches += bandFetches;
  // Persist the band. Failure is non-fatal: the crawl's real job (matched
  // offers) already succeeded, and a band insert that fails just means those
  // offers are retried on the next poll of this board.
  let bandInserted = 0;
  if (bandOffers.length) {
    try {
      const r = await api.insertBandOffers(bandOffers);
      bandInserted = Number(r.inserted || 0);
    } catch (e) {
      log({ type: 'band_insert_error', id, error: String((e && e.message) || e).slice(0, 160) });
    }
  }
  stats.bandInserted += bandInserted;
  stats.bandOverflow += bandOverflow;
  // Sizing sample for the ambiguous band: a bounded, deterministic slice of the
  // distinct rejected jobs, so the band can be calibrated (and its relevance
  // judged by eye) without storing a single one.
  if (bandSamples.length) {
    for (const s of bandSamples.slice(0, 5)) log({ type: 'band_sample', ...s });
  }
  return { items: items.length, offers: offers.length, inserted, matched, internships, blocked, dups, unmatched, demoted, bandUnique, bandDups };
}

async function runSource(src, opts) {
  const id = src.id;
  if (src.enabled === false) return;
  const st = state.get(id) || { nextAt: 0, fails: 0 };
  const interval = Number(src.intervalMs || 60 * 1000);
  const now = Date.now();
  if (!forceAll && !opts.force && st.nextAt && now < st.nextAt) return;

  const t0 = Date.now();
  try {
    const r = await crawlSource(src, opts);
    if (r.skipped) { st.nextAt = now + 15000; state.set(id, st); return; }
    st.fails = 0;
    st.nextAt = Date.now() + interval;
    st.lastAt = Date.now();
    st.lastError = '';
    state.set(id, st);
    // Only write back when something is worth reporting, so 800 sources do not
    // generate 800 UPDATEs per minute against Postgres.
    if (r.inserted || r.offers || (st.lastAdded || 0) !== r.inserted) {
      st.lastAdded = r.inserted;
      await api.updateSource(id, {
        lastCrawlAt: new Date().toISOString(),
        lastCrawlAtMs: Date.now(),
        itemCount: r.items || 0,
        lastAdded: r.inserted,
        lastError: '',
        lastErrorAtMs: 0,
      }).catch(() => {});
    } else {
      // A crawl that succeeds but keeps no offer still clears the previous error.
      // STMicro's eightfold board served 10 postings that all failed the
      // matchedOnly filter, so this branch ran and left lastErrorAtMs at the
      // pre-fix 404 forever: a healthy source permanently badged as broken in the
      // UI. Gate on the PERSISTED value (src.lastError, as listed by the API);
      // st.lastError was already reset to '' by the success path above, so testing
      // it here is always false and the stale row never gets cleaned up.
      const patch = { lastCrawlAtMs: Date.now() };
      if (src.lastError) {
        patch.lastError = '';
        patch.lastErrorAtMs = 0;
      }
      await api.updateSource(id, patch).catch(() => {});
    }
    if (r.inserted) {
      log({
        type: 'source_added', id, inserted: r.inserted, offers: r.offers, items: r.items, ms: Date.now() - t0,
        matched: r.matched, unmatched: r.unmatched, internships: r.internships, blocked: r.blocked, dups: r.dups,
        demoted: r.demoted,
      });
    }
  } catch (e) {
    st.fails = (st.fails || 0) + 1;
    const code = statusOf(e);
    // 4xx that is not rate limiting means this board is gone or blocked: back off
    // hard instead of retrying every minute for hours.
    const hard = code >= 400 && code < 500 && code !== 429;
    const wait = hard ? MAX_BACKOFF_MS : Math.min(MAX_BACKOFF_MS, interval * Math.pow(2, st.fails));
    st.nextAt = Date.now() + wait;
    st.lastError = String((e && e.message) || e).slice(0, 200);
    state.set(id, st);
    stats.errors++;
    log({ type: 'source_error', id, code, fails: st.fails, waitMs: wait, error: st.lastError });
    await api.updateSource(id, { lastError: st.lastError, lastErrorAtMs: Date.now() }).catch(() => {});
  }
}

// ------------------------- scheduler -------------------------
async function runBatch(force) {
  const due = [];
  for (const [id, src] of sources) {
    if (shardOf(id) !== SHARD) continue;
    if (src.enabled === false) continue;
    const st = state.get(id);
    if (force || forceAll || !st || !st.nextAt || Date.now() >= st.nextAt) due.push(src);
  }
  if (!due.length) return 0;
  let i = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, due.length) }, async () => {
    while (i < due.length) {
      const src = due[i++];
      await runSource(src, { force }).catch(() => {});
    }
  });
  await Promise.all(workers);
  stats.cycles++;
  return due.length;
}

// ------------------------- source registry refresh -------------------------
async function refreshSources() {
  try {
    const all = await api.listSources();
    let added = 0;
    let removed = 0;
    const seen = new Set();
    for (const s of all) {
      const id = s.id;
      if (shardOf(id) !== SHARD) continue;
      seen.add(id);
      if (!sources.has(id)) added++;
      sources.set(id, s);
    }
    for (const id of [...sources.keys()]) if (!seen.has(id)) { sources.delete(id); state.delete(id); removed++; }
    if (added || removed) log({ type: 'sources_loaded', total: sources.size, added, removed });
  } catch (e) {
    log({ type: 'sources_error', error: String((e && e.message) || e).slice(0, 140) });
  }
}

// ------------------------- chat trigger ("nouvelle recherche") -------------------------
const handledHunt = new Set(loadJson(HUNT_FILE, []));
async function pollTasks() {
  try {
    const tasks = await api.listTasks({ status: 'queued', limit: 20 });
    const hunt = tasks.filter((t) => /cherche des offres|recherche des offres|hunt|nouvelle recherche/i.test(String(t.request || '')));
    for (const t of hunt) {
      if (handledHunt.has(t.id)) continue;
      handledHunt.add(t.id);
      saveJsonAtomic(HUNT_FILE, [...handledHunt].slice(-100));
      forceAll = true;
      log({ type: 'force_all', taskId: t.id });
    }
  } catch (_) {}
}

// ------------------------- main loop -------------------------
(async () => {
  log({ type: 'fleet_start', shards: SHARDS, shard: SHARD, concurrency: CONCURRENCY, hostGapMs: HOST_GAP_MS, hostDailyBudget: HOST_DAILY_BUDGET });
  await refreshSources();

  const once = process.argv.includes('--once');
  if (once) {
    const n = await runBatch(true);
    log({ type: 'fleet_once', ran: n, ...stats });
    console.log(JSON.stringify({ ran: n, ...stats }));
    process.exit(0);
  }

let tick = 0;
  // The funnel, stated explicitly so the ambiguous band can be sized without
  // arithmetic: what gets scraped, what the keyword engine keeps, and what it
  // throws away. `unmatchedRate` is the number that decides whether the band is
  // a trickle or a flood, and it is only trustworthy because these totals
  // accumulate on every crawl rather than only on inserted > 0.
  function logFunnel() {
    const seen = stats.matched + stats.unmatched;
    const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
    log({
      type: 'fleet_funnel', sources: sources.size,
      items: stats.items, matched: stats.matched, unmatched: stats.unmatched,
      internships: stats.internships, blocked: stats.blocked, dups: stats.dups,
      bandUnique: stats.bandUnique, bandDups: stats.bandDups,
      bandWithDesc: stats.bandWithDesc, bandNoDesc: stats.bandNoDesc,
      bandAvgDesc: stats.bandWithDesc ? Math.round(stats.bandDescChars / stats.bandWithDesc) : 0,
      bandMinDesc: BAND_MIN_DESC, bandFetches: stats.bandFetches, bandInserted: stats.bandInserted, bandOverflow: stats.bandOverflow, bandEnrichMax: BAND_ENRICH_MAX, bandMaxPerSource: BAND_MAX_PER_SOURCE, bandOn: BAND_ENABLED,
      keepRate: pct(stats.matched, seen), unmatchedRate: pct(stats.unmatched, seen),
      internRate: pct(stats.internships, stats.items), dupRate: pct(stats.dups, stats.items),
      bandPerCycle: stats.bandUnique,
      demoted: stats.demoted, demoteRate: pct(stats.demoted, seen),
      sourceFloors: Object.keys(SOURCE_MIN_SCORE).length,
    });
  }
  const loop = async () => {
    tick++;
    if (tick % 2 === 1) await refreshSources();
    if (tick % 5 === 0) await pollTasks();
    const n = await runBatch(false);
    if (tick % 5 === 0) {
      log({ type: 'fleet_tick', sources: sources.size, ran: n, ...stats });
      logFunnel();
      if (forceAll) { forceAll = false; log({ type: 'force_cleared' }); }
    }
  };
  await loop();
  setInterval(() => { loop().catch((e) => log({ type: 'loop_error', error: String((e && e.message) || e).slice(0, 160) })); }, 5000);
  setInterval(() => { log({ type: 'fleet_heartbeat', sources: sources.size, ...stats }); logFunnel(); }, 300000).unref?.();
})();

process.on('unhandledRejection', (e) => log({ type: 'unhandled_rejection', error: String((e && e.message) || e).slice(0, 160) }));
process.on('uncaughtException', (e) => log({ type: 'uncaught_exception', error: String((e && e.message) || e).slice(0, 160) }));
