'use strict';
// Common Crawl index client: the transport half of source discovery.
//
// WHY THIS EXISTS
// The old model was a hand-written list: 244 boards someone had already found. It
// cannot grow. Google CSE was the first idea and is unusable for this -- 100
// queries/day, and one employer costs several queries to confirm. Common Crawl is
// a public index of ~250M sites, needs no key and has no daily query quota, and it
// publishes the exact board URLs we need: every Greenhouse board, every Workday
// tenant, every Recruitee company is a crawled public URL.
//
// WHAT THE API ACTUALLY DOES (measured, not assumed -- the docs are thin)
//   GET {index}?url=<apex>&matchType=domain&showNumPages=true&pageSize=1
//       -> {"pages":N,...}   N = number of index BLOCKS (shards), not records
//   GET {index}?url=<apex>&matchType=domain&page=P&pageSize=1&output=json
//       -> newline-delimited JSON, one record per line
//   `pageSize` counts blocks, so pageSize=5 for myworkdayjobs.com returns 7.7MB.
//   Always pageSize=1 and iterate `page`.
//   `collapse=urlkey` removes duplicate captures. Essential.
//   `filter=mime:.*html.*` RETURNS 404 -- the slashes break query parsing.
//   `filter=mime:text/html` works (exact match only).
//   `filter=status:200` works, but is a no-op on hosts that are all-200.
//   504s are routine and transient (~10s each). Retry with backoff or a whole
//   vendor enumeration silently returns nothing.
//
// One block is ~200 records / ~127KB after collapse, so this is cheap: the whole
// myworkdayjobs.com surface is 24 blocks.

const INDEX_LIST = 'https://index.commoncrawl.org/collinfo.json';
const DEFAULT_TIMEOUT = 45000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function envInt(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

async function fetchWithTimeout(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || DEFAULT_TIMEOUT);
  try {
    return await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'JobCenter/2.0 (job board discovery)' } });
  } finally {
    clearTimeout(timer);
  }
}

// Snapshot list, newest first. Cached for the process: it is a static file that
// changes about once a month.
let collinfoCache = null;
async function collinfo() {
  if (collinfoCache) return collinfoCache;
  const r = await fetchWithTimeout(INDEX_LIST, 30000);
  if (!r.ok) throw new Error('collinfo http ' + r.status);
  collinfoCache = await r.json();
  return collinfoCache;
}

async function newestIndex() {
  const list = await collinfo();
  return list[0];
}

// Older snapshots are the fallback for a vendor whose newest crawl lost the board
// (a company that just migrated gets dropped from the current index but is still
// in the previous one). Callers pass the index object from collinfo().
async function resolveIndex(pref) {
  const list = await collinfo();
  if (!pref) return list[0];
  if (typeof pref === 'object' && pref['cdx-api']) return pref;
  const hit = list.find((x) => x.id === pref);
  if (!hit) throw new Error('unknown index ' + pref);
  return hit;
}

function baseQuery(apex, page, opts) {
  const p = new URLSearchParams();
  p.set('url', apex);
  p.set('matchType', 'domain');
  p.set('page', String(page));
  p.set('pageSize', '1');
  p.set('output', 'json');
  p.set('collapse', 'urlkey');
  p.set('filter', 'status:200');
  if (!opts.allMimes) p.set('filter', 'mime:text/html');
  return p.toString();
}

// How many blocks a domain is spread over. Cheap: pageSize=1 means one record,
// but the response still reports the true block count.
async function pagesFor(apex, idx) {
  const index = await resolveIndex(idx);
  const url = index['cdx-api'] + '?url=' + encodeURIComponent(apex) +
    '&matchType=domain&showNumPages=true&pageSize=1';
  let lastErr = null;
  for (let a = 1; a <= (opts3().retries); a++) {
    try {
      const r = await fetchWithTimeout(url, opts3().timeoutMs);
      // 404 here means a malformed query, not a transient failure: retrying an
      // unparseable request just burns 10s per attempt.
      if (r.status === 404) return { pages: 0, error: 'query-404' };
      if (!r.ok) throw new Error('http ' + r.status);
      const ct = r.headers.get('content-type') || '';
      if (ct.indexOf('text/html') >= 0) throw new Error('html-error-page');
      const j = await r.json();
      return { pages: Number(j.pages) || 0, index: index.id };
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(1000 * a * a, 8000));
    }
  }
  return { pages: 0, error: String((lastErr && lastErr.message) || lastErr) };
}

function opts3() {
  return {
    retries: envInt('CC_RETRIES', 4),
    timeoutMs: envInt('CC_TIMEOUT_MS', DEFAULT_TIMEOUT),
    gapMs: envInt('CC_GAP_MS', 1200),
  };
}

// Stream one block and hand every URL to `onUrl`. Returns early once `maxUrls` is
// hit, or as soon as `shouldStop()` returns true. Returns early once `want` URLs
// have been seen: buffering a 7.7MB block to look at the first 40 tenants is how
// an enumeration eats its whole memory budget.
//
// Streaming rather than response.text() is not optional. A large block is tens of
// megabytes and there is no server-side "give me only lines matching X".
//
// `maxUrls` and `shouldStop` are deliberately separate. An earlier version had one
// `want` counted in raw URLs, which is wrong for exactly the domains that matter
// most: Common Crawl partitions its index by URL-key hash, so one block is often a
// SINGLE tenant's entire board. Measured on myworkdayjobs.com block 1: 2925 URLs,
// all 2020companies. A 250-URL budget therefore discovered exactly one board, and
// the highest-value vendor looked broken.
//
// `shouldStop` lets the caller stop on its own unit of interest (distinct boards)
// while `maxUrls` stays a hard safety valve on bytes.
async function eachUrlInBlock(apex, page, idx, onUrl, opts) {
  const o = Object.assign({}, opts3(), opts || {});
  const index = await resolveIndex(idx);
  const url = index['cdx-api'] + '?' + baseQuery(apex, page, o);
  const maxUrls = o.maxUrls || 2000;
  let seen = 0;
  let lastErr = null;

  for (let a = 1; a <= o.retries; a++) {
    try {
      const r = await fetchWithTimeout(url, o.timeoutMs);
      if (r.status === 404) return { urls: 0, done: true, error: 'query-404' };
      if (!r.ok) throw new Error('http ' + r.status);
      const ct = r.headers.get('content-type') || '';
      if (ct.indexOf('text/html') >= 0) throw new Error('html-error-page');

      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let stopped = false;
      let bytes = 0;
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        buf += dec.decode(value, { stream: true });
        // Keep only the last partial line in the buffer.
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const line of parts) {
          if (!line.trim()) continue;
          let rec;
          try { rec = JSON.parse(line); } catch (_) { continue; }
          if (!rec || !rec.url) continue;
          seen++;
          const cont = onUrl(rec.url, rec);
          if (cont === false) { stopped = true; break; }
          if (seen >= maxUrls) { stopped = true; break; }
          if (o.shouldStop && o.shouldStop()) { stopped = true; break; }
        }
      }
      if (stopped) {
        try { await reader.cancel(); } catch (_) {}
      }
      await sleep(o.gapMs);
      return { urls: seen, bytes, done: true };
    } catch (e) {
      lastErr = e;
      // A 504 typically burns the full timeout before failing, so back off hard.
      await sleep(Math.min(1500 * a * a, 10000));
    }
  }
  return { urls: seen, done: false, error: String((lastErr && lastErr.message) || lastErr) };
}

// Walk every block of a domain, newest snapshot first, falling back to older ones
// when the current crawl has nothing. `onUrl` returns false to stop early.
//
// Stops on the CALLER's unit of interest via `opts.shouldStop`, not on a URL count
// -- see the note on eachUrlInBlock about one-block-one-tenant partitioning.
//
// Yields { url, index, block } so the caller can tell which snapshot a board came
// from -- a board that only exists in an 18-month-old crawl is a migration risk and
// the verification gate will usually reject it anyway.
async function enumerateDomain(apex, idx, onUrl, opts) {
  const o = Object.assign({}, opts3(), opts || {});
  const list = await collinfo();
  const order = idx ? [await resolveIndex(idx)] : list.slice(0, o.snapshots || 2);

  const stats = { apex, blocks: 0, urls: 0, indexes: [], errors: [], stopped: false };
  for (const index of order) {
    const { pages, error } = await pagesFor(apex, index);
    if (error) { stats.errors.push(index.id + ':' + error); continue; }
    if (!pages) continue;
    const maxBlocks = o.maxBlocks || pages;
    const n = Math.min(pages, maxBlocks);
    for (let p = 0; p < n; p++) {
      const r = await eachUrlInBlock(apex, p, index, (u, rec) => onUrl(u, rec, index.id, p), o);
      stats.blocks++;
      stats.urls += r.urls || 0;
      if (r.error) stats.errors.push(index.id + '#' + p + ':' + r.error);
      if (r.error && pages > 1) break; // this block is unusable, move to the next
      if (o.shouldStop && o.shouldStop()) { stats.stopped = true; return stats; }
      if (r.urls === 0) break;
    }
    stats.indexes.push(index.id);
  }
  return stats;
}

module.exports = {
  collinfo, newestIndex, resolveIndex, pagesFor, eachUrlInBlock, enumerateDomain,
  INDEX_LIST, sleep,
};