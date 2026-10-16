const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { computePostedAt } = require('./posted-time');

const DIR = __dirname;

const SOURCE_ID = process.argv[2];
if (!SOURCE_ID) { console.error('usage: node hunter-agent.js <sourceId>'); process.exit(1); }

const EVENTS = path.join(DIR, 'events-' + SOURCE_ID + '.log');
function log(ev) {
  const line = JSON.stringify({ ts: new Date().toISOString(), source: SOURCE_ID, ...ev });
  try { fs.appendFileSync(EVENTS, line + '\n'); } catch (_) {}
  if (process.env.VERBOSE) console.log(line);
}

// Docker API client — replaces Firebase failover/meta-mirror
const api = require('./api_client.js');

const metaCache = { profile: null, source: null };
const knownSet = new Set();
let knownSeeded = false;

const { scoreOffer } = require('./engine.js');

async function pkw() {
  try {
    const c = metaCache.profile;
    if (c && Date.now() - c.t < 15 * 60 * 1000) return c.kw;
    let kw = [];
    try {
      const prof = await api.getProfile();
      if (prof && Array.isArray(prof.keywords) && prof.keywords.length) kw = prof.keywords;
    } catch (_) {}
    metaCache.profile = { kw, t: Date.now() };
    return kw;
  } catch (_) { return []; }
}

// Board adapters + shared helpers now live in ./legacy-adapters.js (2026-07 refactor).
const L = require('./legacy-adapters.js');
const { ADAPTERS, enrichDetail, http, getText, getJson, clean, decodeEntities, extractLocation, sleep } = L;

// ---------------- cycle ----------------
let running = false;
async function cycle(force) {
  if (running) return;
  running = true;
  try {
    await cycleBody(force);
  } finally {
    running = false;
  }
}

async function cycleBody(force) {
  try {
    const src = await getSourceDoc();
    if (!src.enabled) return;
    const now = Date.now();
    const interval = src.intervalMs || 30 * 60 * 1000;
    const pick = src.lastCrawlAtMs || 0;
    const errPick = src.lastErrorAtMs || 0;
    if (!force && now - Math.max(pick, errPick) < interval) return;

    const kw = await pkw();
    const known = await knownOfferIds();
    const refreshPosted = process.env.REFRESH_POSTED === '1';
    let items = await ADAPTERS[src.type](src);
    let added = 0, skippedDup = 0, matched = 0, unmatched = 0, refreshed = 0, internships = 0, blocked = 0;
    for (const it of items) {
      if (!it.ref) continue;
      const id = offerId(it.ref);
      if (isInternship(it)) { internships++; continue; }
      const sc = scoreOffer(it.title, it.description || '', kw);
      // BLOCKLIST titles never reach the DB (same treatment as internships):
      // storing them at score 0 only fed the "Tous" feed and the push digest.
      if (sc.blocked) { blocked++; continue; }
      if (src.matchedOnly && !sc.match) { unmatched++; continue; }
      if (known.has(id)) {
        continue;
      }
      const dedupeKey = clean(it.title).toLowerCase() + '|' + clean(it.company).toLowerCase();
      if (dedupeKey.length > 8) {
        const ok = await ensureUniqueKey(dedupeKey, id);
        if (!ok) { skippedDup++; continue; }
      }
      let final = { ...it };
      if (sc.match && !final.description) {
        const d = await enrichDetail(it, src);
        final = { ...final, ...d };
      }
      const rsc = scoreOffer(final.title, final.description || '', kw);
      const postedAt = computePostedAt(final, now);
      await api.createOffer({
        id,
        title: final.title,
        ref: it.ref,
        company: final.company || '',
        link: final.link || '',
        location: final.location || '',
        country: final.country || '',
        contract: final.contract || '',
        source: src.name || src.id,
        sourceId: SOURCE_ID,
        salary: final.salary || '',
        remote: String(final.remote || ''),
        score: rsc.score,
        match: rsc.match,
        keywords: rsc.matches,
        status: 'new',
        // Employer ATS page when the source was an aggregator (WP5). The
        // apply-worker prefers it over the aggregator link so the bypass
        // strategy targets the real ATS host instead of the listing page.
        applyUrl: final.applyUrl || '',
        boardHint: require('./apply-driver.js').detectBoard({ link: (final.applyUrl || final.link || ''), sourceId: SOURCE_ID }),
        description: String(final.description || '').slice(0, 4000),
        postedAt: postedAt ? postedAt.toISOString() : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        agentNote: rsc.match ? ('Correspond a ton profil (hunter ' + (src.name || SOURCE_ID) + ')') : ('Trouve par le hunter ' + (src.name || SOURCE_ID)),
      });
      known.add(id);
      added++;
      if (rsc.match) matched++;
      log({ type: 'offer_added', ref: it.ref, title: it.title, match: rsc.match, score: rsc.score });

      // AUTO-TAILOR IS OFF BY DEFAULT (2026-09-26).
      //
      // This block used to queue a tailor task for EVERY ingested offer scoring
      // >= 3, with no flag and no way to opt out. In 5 days that produced 68
      // CV/letter pairs (136 docs) that nobody had asked for, and the Documents
      // tab became a graveyard of stale applications.
      //
      // Tailoring now happens ONLY when the user asks for it:
      //   - "adapter <ref>" (or "adapter" + pasted offer link) in the chat
      //   - the "Adapter" button on an offer card / offer detail screen
      // The task-worker still consumes the exact same 'adapter' tasks, so the
      // manual flow is unchanged.
      //
      // To re-enable the automatic path, start monitor.js with AUTO_TAILOR=1 in
      // its environment. AUTO_TAILOR_SCORE tunes the threshold (default 3).
      const AUTO_TAILOR = process.env.AUTO_TAILOR === '1';
      const AUTO_TAILOR_SCORE = Number(process.env.AUTO_TAILOR_SCORE || 3);
      const autoScore = typeof rsc.score === 'number' ? rsc.score : 0;
      if (AUTO_TAILOR && rsc.match && autoScore >= AUTO_TAILOR_SCORE) {
        try {
          const offerRef = String(it.ref || id);
          // Deterministic id. The previous '-<Date.now()>' suffix minted a brand
          // new task row on every re-crawl of the same offer (the tasks table was
          // the fastest growing one in the DB). This id is stable per offer, so
          // ON CONFLICT can finally do its job.
          const tailorId = 'tailor-hunter-' + offerRef.replace(/[^\w.-]+/g, '_').slice(0, 60);
          const prev = await api.getTask(tailorId).catch(() => null);
          if (prev && (prev.status === 'done' || prev.status === 'queued')) {
            log({ type: 'auto_tailor_skipped', offerId: id, ref: it.ref, reason: 'task already ' + prev.status, tailorId });
          } else {
            // Queue tailor task (task-worker picks it up in 10s)
            await api.createTask({
              id: tailorId,
              kind: 'adapter',
              request: 'adapter ' + offerRef,
              status: 'queued',
              offerRef,
              offerId: id,
              createdAt: new Date().toISOString(),
              autoChained: true,
              source: 'hunter-' + SOURCE_ID,
            });
            log({ type: 'auto_tailor_queued', offerId: id, ref: it.ref, score: rsc.score, tailorId });
          }
        } catch (autoErr) {
          log({ type: 'auto_tailor_error', offerId: id, error: String((autoErr && autoErr.message) || autoErr).slice(0, 120) });
        }
      }

    }
    await setSource({ lastCrawlAt: new Date().toISOString(), lastCrawlAtMs: now, itemCount: items.length, lastAdded: added, lastError: '', silentCatchup: false });
    log({ type: 'crawl_done', items: items.length, added, matched, skippedDup, unmatched, internships, blocked, refreshed });
  } catch (e) {
    try { await setSource({ lastError: String((e && e.message) || e), lastErrorAt: new Date().toISOString(), lastErrorAtMs: Date.now() }); } catch (_) {}
    log({ type: 'crawl_error', error: String((e && e.message) || e), stack: (e && e.stack || '').split('\n').slice(0, 5).join(' | ') });
    throw e;
  } finally {
    running = false;
  }
}

let detachTasks = null;
const huntCacheFile = path.join(DIR, '.hunt-cache.json');
function loadHandledHunt() {
  try { return new Set(JSON.parse(fs.readFileSync(huntCacheFile, 'utf8'))); } catch (_) { return new Set(); }
}
function saveHandledHunt(s) {
  try { fs.writeFileSync(huntCacheFile, JSON.stringify([...s].slice(-100))); } catch (_) {}
}
async function pollTasks() {
  try {
    const tasks = await api.listTasks({ status: 'queued', limit: 20 });
    if (!tasks.some((t) => /cherche des offres|recherche des offres|hunt|nouvelle recherche/i.test(String(t.request || '')))) return;
    const handled = loadHandledHunt();
    for (const t of tasks) {
      const v = t;
      if (handled.has(v.id)) continue;
      if (/cherche des offres|recherche des offres|hunt|nouvelle recherche/i.test(String(v.request || ''))) {
        handled.add(v.id);
        saveHandledHunt(handled);
        cycle(true).catch((e) => log({ type: 'task_trigger_error', error: String((e && e.message) || e) }));
      }
    }
  } catch (e) { log({ type: 'poll_tasks_error', error: String(e.message || e) }); }
}
function attachTasks() {
  // poll every 30s instead of Firestore onSnapshot
  if (detachTasks) { clearInterval(detachTasks); detachTasks = null; }
  detachTasks = setInterval(pollTasks, 30000);
  pollTasks();
}

process.on('unhandledRejection', (e) => log({ type: 'agent_error', context: 'unhandled_rejection', error: String((e && e.message) || e) }));
process.on('uncaughtException', (e) => log({ type: 'agent_error', context: 'uncaught_exception', error: String((e && e.message) || e) }));

(async () => {
  const once = process.argv.includes('--once');
  const delays = [5000, 15000, 30000, 60000, 120000, 300000, 600000];
  const runStartup = async () => {
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        await cycle(true);
        return true;
      } catch (e) {
        log({ type: 'initial_crawl_retry', attempt, error: String((e && e.message) || e) });
        if (attempt >= delays.length) break;
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
    return false;
  };
  if (once) {
    const ok = await runStartup();
    process.exit(ok ? 0 : 1);
    return;
  }
log({ type: 'agent_start', runId: SOURCE_ID + '-' + Date.now() });
  attachTasks();
  setInterval(() => cycle(false).catch((e) => log({ type: 'agent_error', context: 'tick', error: String((e && e.message) || e) })), 300000);
  runStartup();
})();
