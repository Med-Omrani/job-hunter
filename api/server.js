'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { pool, init } = require('./db');
const { client: redis, connect: redisConnect } = require('./redis');
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET required');
const PDF_DIR = process.env.PDF_DIR || '/app/data/pdfs';
try { fs.mkdirSync(PDF_DIR, { recursive: true }); } catch (_) {}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// simple anon auth — issues JWT without password (single-user PC). Phone + hunters use this.
function signAnon(uid = 'anon') {
  return jwt.sign({ uid }, JWT_SECRET, { expiresIn: '30d' });
}
function authOptional(req, _res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)/);
  if (m) {
    try { req.user = jwt.verify(m[1], JWT_SECRET); } catch (_) {}
  }
  next();
}
app.use(authOptional);

// health
app.get('/api/health', (_req, res) => res.json({ ok: true, at: new Date().toISOString() }));
app.get('/health', (_req, res) => res.json({ ok: true }));

// auth
app.post('/api/auth/anon', (req, res) => {
  const uid = String(req.body?.uid || 'anon').slice(0, 64);
  const token = signAnon(uid);
  res.json({ token, uid });
});

// helper to broadcast WS
const wssByPath = new Map();
function broadcast(pathKey, data) {
  const wss = wssByPath.get(pathKey);
  if (!wss) return;
  const msg = JSON.stringify(data);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
}

// offers
app.get('/api/offers', async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 250), 1000);
  const order = String(req.query.order || 'updated_at.desc');
  const q = order.includes('asc') ? 'ASC' : 'DESC';
  const status = req.query.status;
  const sourceId = req.query.sourceId;
  const country = req.query.country;
  let where = '';
  const params = [];
  let i = 1;
  if (status) { where += (where ? ' AND ' : ' WHERE ') + ` data->>'status' = $${i++}`; params.push(status); }
  if (sourceId) { where += (where ? ' AND ' : ' WHERE ') + ` data->>'sourceId' = $${i++}`; params.push(sourceId); }
  if (country) { where += (where ? ' AND ' : ' WHERE ') + ` data->>'country' = $${i++}`; params.push(country); }
  if (req.query.since) {
    where += (where ? ' AND ' : ' WHERE ') + ` updated_at > $${i++}`;
    params.push(new Date(req.query.since));
  }
  // Archived offers are hidden by default (use ?status=archived or ?all=1 to see them).
  if (!status && req.query.all !== '1') { where += (where ? ' AND ' : ' WHERE ') + ` data->>'status' IS DISTINCT FROM 'archived'`; }
  const sql = `SELECT id, data, updated_at FROM offers ${where} ORDER BY updated_at ${q} LIMIT $${i++}`;
  params.push(limit);
  const r = await pool.query(sql, params);
  const out = r.rows.map((row) => ({ id: row.id, ...row.data, updated_at: row.updated_at, updatedAt: row.updated_at }));
  res.json(out);
});
// ---- search (added 2026-09-25) --------------------------------------------
// GET /api/offers is intentionally left byte-identical: the hunters, batch
// apply, monitor and push all parse it as a bare array. The app's search lives
// here instead, returning a {items,total,...} envelope.
const SEARCH_COL = `lower(
  COALESCE(data->>'title','') || ' ' ||
  COALESCE(data->>'company','') || ' ' ||
  COALESCE(data->>'ref','') || ' ' ||
  COALESCE(data->>'location','') || ' ' ||
  COALESCE(data->>'contract','') || ' ' ||
  COALESCE(data->>'description',''))`;

// Builds the shared WHERE clause for /offers/search and /offers/facets.
function offerFilters(q) {
  const clauses = [];
  const params = [];
  const add = (sql, val) => { params.push(val); clauses.push(sql.replace('$?', '$' + params.length)); };

  const status = q.status;
  if (status) add("status = $?", String(status));
  // Mirror /api/offers: archived offers stay hidden unless asked for.
  if (!status && q.all !== '1') clauses.push("status IS DISTINCT FROM 'archived'");
  if (q.sourceId) add("lower(COALESCE(data->>'sourceId', data->>'source','')) = $?", String(q.sourceId).toLowerCase());
  if (q.country) add("lower(COALESCE(data->>'country','')) = $?", String(q.country).toLowerCase());
  if (q.city) add("lower(COALESCE(data->>'location','')) = $?", String(q.city).toLowerCase());
  if (q.contract) add("lower(COALESCE(data->>'contract','')) = $?", String(q.contract).toLowerCase());
  if (q.matchOnly === '1' || q.matchOnly === 'true') clauses.push('(match IS TRUE OR score >= 2)');
  // Vu tab: only offers the user actually opened. Pairs with sort=seen_at.
  if (q.hasSeen === '1' || q.hasSeen === 'true') clauses.push("data ? 'seenAt'");
  if (q.unseenOnly === '1' || q.unseenOnly === 'true') clauses.push("data IS NOT NULL AND NOT (data ? 'seenAt')");
  if (q.since) {
    const d = new Date(q.since);
    if (!Number.isNaN(d.getTime())) add('updated_at > $?', d);
  }
  if (q.q) {
    // Every whitespace-separated term must match (AND), each as a substring.
    // Backed by idx_offers_search (gin_trgm_ops).
    for (const term of String(q.q).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)) {
      add(`${SEARCH_COL} LIKE $?`, '%' + term.replace(/[%_\\]/g, (c) => '\\' + c) + '%');
    }
  }
  return { where: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', params };
}

app.get('/api/offers/search', async (req, res) => {
  try {
    // The cache key is the entire query string, so limit/offset/sort/fields and
    // every filter are part of the key by construction. A different page or
    // field projection can never read another one's cached rows.
    const cacheKey = req.originalUrl || req.url;
    const cached = searchCacheGet(cacheKey);
    if (cached !== null) {
      return res.set('X-Cache', 'hit').type('application/json').send(cached);
    }
    const limit = Math.min(Math.max(Number(req.query.limit || 30), 1), 200);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const { where, params } = offerFilters(req.query);

    // sort: updated_at (default) | score | company | seen_at
    const sort = String(req.query.sort || 'updated_at');
    const order = String(req.query.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const orderBy = sort === 'score' ? 'score DESC NULLS LAST, updated_at DESC'
      : sort === 'seen_at' ? `(data->>'seenAt') ${order}, updated_at DESC`
      : sort === 'company' ? `lower(COALESCE(data->>'company','')) ${order}`
      : `updated_at ${order}`;

    // fields=list omits the description from the SELECT itself.
    //
    // WHY: the offers table is 239MB, of which 93MB is description text (avg
    // 3,236 chars/offer). But nothing that renders a LIST ever reads it:
    // offer_card.dart reads country/keywords/location/match/score/seenAt/statusAt,
    // and results_tab.dart + groups_tab.dart read only id/link/status/company/
    // location/postedAt/sourceId/updatedAt. Measured payload reduction:
    //   30 rows: 154KB -> 24KB   (6.4x)
    //   200 rows: 0.98MB -> 0.16MB
    // The detail screen still needs the body and fetches it per offer from
    // /api/offers/:id, which is unchanged.
    //
    // Excluding the key in SQL rather than deleting it in JS is the point: the
    // text is never read from disk, never parsed, never copied through the
    // driver, and never serialised into JSON.
    const listOnly = String(req.query.fields || '') === 'list';
    const listSelect = listOnly ? "(data - 'description') AS data" : 'data';

    const count = await pool.query('SELECT COUNT(*)::int AS n FROM offers' + where, params);
    const rows = await pool.query(
      `SELECT id, ${listSelect}, updated_at, score, match FROM offers${where} ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    const items = rows.rows.map((row) => ({
      id: row.id, ...row.data,
      score: row.score, match: row.match,
      updated_at: row.updated_at, updatedAt: row.updated_at,
    }));
    const payload = {
      items, total: count.rows[0].n, offset, limit,
      hasMore: offset + items.length < count.rows[0].n,
    };
    searchCacheSet(req.originalUrl || req.url, JSON.stringify(payload));
    res.set('X-Cache', 'miss');
    res.json(payload);
  } catch (e) {
    console.error('offers/search failed', e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Search-result cache.
//
// WHY THIS IS NEEDED EVEN THOUGH THE TRGM INDEX EXISTS
// Search is a substring match over title+company+ref+location+contract+
// description. Measured on the live table: `q=kubernetes` uses idx_offers_search
// (98MB GIN trgm) and returns in ~293ms, but `q=engineer` matches 16,537 rows, so
// Postgres picks a sequential scan and must lowercase+concatenate 93MB of
// description text -- 5.4s. The cost scales with how COMMON the term is, so the
// popular searches are exactly the slow ones.
//
// This is not tunable: no index helps a term that matches half the table. What
// does help is not recomputing an identical query. The app debounces at 300ms and
// re-issues the same search on every 20s poll and every filter re-tap, so the same
// popular query runs many times per minute.
//
// Only successful GET /api/offers/search responses are cached, keyed by the full
// query string, and any offer write drops the whole cache (a crawl landing
// changes `total` and the newest page).
const SEARCH_TTL_MS = Math.max(5, Number(process.env.SEARCH_TTL_SEC || 45)) * 1000;
const SEARCH_CACHE_MAX = 100;
let searchCache = new Map();

function invalidateSearch() { searchCache = new Map(); }

function searchCacheGet(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= SEARCH_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  // Refresh LRU position so a busy key is not evicted while still hot.
  searchCache.delete(key);
  searchCache.set(key, hit);
  return hit.body;
}

function searchCacheSet(key, body) {
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    searchCache.delete(searchCache.keys().next().value);
  }
  searchCache.set(key, { at: Date.now(), body });
}

// Distinct filter values with counts, so the app never has to pull every offer
// just to build its chip rows.
//
// WHY THIS IS NOW 5 GROUP BY QUERIES
// The original implementation selected five columns across EVERY non-archived
// row and tallied them in JavaScript. Measured on the live table (30,347 offers,
// 239MB) that was 5.1-5.6s per call and 186KB of response, and the app calls it
// every time the offers tab opens. EXPLAIN ANALYZE on a single column was
// already 852ms with 79,476 buffer hits -- the cost was in reading the table,
// not in the counting.
//
// Counting in Postgres returns only the distinct values, so the row count drops
// from 30k to a few hundred. Planning time is ~2ms per query.
//
// The five queries run concurrently, and the whole payload is cached briefly:
// facet values only shift when a crawl lands, so recomputing them several times
// a second is wasted work. The cache is invalidated on any offer write.
const FACETS_TTL_MS = Math.max(5, Number(process.env.FACETS_TTL_SEC || 60)) * 1000;
let facetsCache = { at: 0, value: null, inflight: null };

function invalidateFacets() { facetsCache = { at: 0, value: null, inflight: null }; }

// One facet dimension: distinct value -> count.
const FACET_DIMS = [
  ['countries', `COALESCE(NULLIF(data->>'country',''), '')`],
  ['cities', `COALESCE(NULLIF(data->>'location',''), '')`],
  ['contracts', `COALESCE(NULLIF(data->>'contract',''), '')`],
  ['sources', `COALESCE(NULLIF(data->>'sourceId',''), data->>'source', '')`],
  ['statuses', `COALESCE(status, 'new')`],
];

async function computeFacets() {
  // Some scrapers store a JSON object in a scalar field; such values are useless
  // as filter chips, and they were skipped in JS before, so the same rule is
  // applied in SQL to keep the output identical. The blank case is dropped for
  // the same reason it was before: an empty chip filters nothing.
  const jobs = FACET_DIMS.map(async ([key, expr]) => {
    // HAVING repeats the expression instead of using the `v` alias: Postgres
    // does not resolve output aliases in HAVING here ("column v does not exist"),
    // and repeating is cheap because the filter is applied to the already
    // computed group key rather than to each row.
    const { rows } = await pool.query(
      `SELECT ${expr} AS v, COUNT(*)::int AS n
         FROM offers
        WHERE status IS DISTINCT FROM 'archived'
        GROUP BY 1
       HAVING ${expr} <> '' AND ${expr} !~ '^[[{]'
        ORDER BY n DESC, v ASC`
    );
    return [key, rows.map((r) => ({ value: r.v, count: r.n }))];
  });
  const seen = pool.query(
    `SELECT COUNT(*)::int AS n FROM offers
      WHERE status IS DISTINCT FROM 'archived' AND data ? 'seenAt'`
  );
  const [pairs, seenRes] = await Promise.all([Promise.all(jobs), seen]);
  const out = { seenTotal: seenRes.rows[0].n };
  for (const [k, v] of pairs) out[k] = v;
  return out;
}

app.get('/api/offers/facets', async (_req, res) => {
  try {
    const now = Date.now();
    if (facetsCache.value && now - facetsCache.at < FACETS_TTL_MS) {
      return res.json(facetsCache.value);
    }
    // Collapse a thundering herd: the app fires facets and search together, and a
    // cache miss would otherwise recompute once per concurrent caller.
    if (!facetsCache.inflight) {
      facetsCache.inflight = computeFacets()
        .then((value) => { facetsCache = { at: Date.now(), value, inflight: null }; return value; })
        .catch((e) => { facetsCache = { at: 0, value: null, inflight: null }; throw e; });
    }
res.json(await facetsCache.inflight);
  } catch (e) {
    console.error('offers/facets failed', e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Every offer write drops the facets cache. Registered before the mutating
// routes so a crawl landing mid-TTL cannot leave stale chip counts behind, and
// so a "Vu" tap (which changes seenTotal) is reflected immediately rather than
// after the next TTL expiry.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.path.startsWith('/api/offers')) {
    res.on('finish', () => {
      invalidateFacets();
      invalidateSearch();
    });
  }
  next();
});

// Aggregate band outcomes + engagement signals over a window.
//
// This exists so the audit agent can compare what the classifier decided
// against what the user actually did. It lives in the API rather than the
// daemon because it is plain SQL aggregation, and putting it in the daemon
// would mean inventing a second, weaker data surface for one consumer.
//
// The engagement numbers are deliberately reported as counts only. With a
// single user these are far too small to learn from; they exist to catch
// contradictions ("promoted 40, dismissed 38"), not to fit a model.
app.get('/api/offers/stats', async (req, res) => {
   const days = Math.min(Math.max(Number(req.query.days || 7), 1), 90);
   try {
     const [band, promoted, events] = await Promise.all([
       pool.query(
         `SELECT COALESCE(data->>'band','none') AS band, COUNT(*)::int AS n
            FROM offers WHERE updated_at > NOW() - ($1 || ' days')::interval
           GROUP BY 1 ORDER BY 2 DESC`,
         [days]
       ),
       pool.query(
         `SELECT COUNT(*)::int AS n FROM offers
           WHERE match IS TRUE AND updated_at > NOW() - ($1 || ' days')::interval`,
         [days]
       ),
       pool.query(
         `SELECT kind, COUNT(*)::int AS n, SUM(weight)::int AS weight
            FROM offer_events WHERE created_at > NOW() - ($1 || ' days')::interval
           GROUP BY kind ORDER BY n DESC`,
         [days]
       ),
     ]);

     const signals = {};
     for (const r of events.rows) signals[r.kind] = { n: r.n, weight: r.weight };

     // Promoted-then-dismissed is the one genuine false-positive signal: the
     // classifier surfaced it and the user explicitly pushed it away.
     const contradicted = await pool.query(
       `SELECT COUNT(DISTINCT e.offer_id)::int AS n
          FROM offer_events e JOIN offers o ON o.id = e.offer_id
         WHERE e.kind = 'dismissed' AND o.match IS TRUE`,
       []
     );

     res.json({
       days,
       band: band.rows,
       promoted: promoted.rows[0]?.n || 0,
       signals,
       promotedThenDismissed: contradicted.rows[0]?.n || 0,
     });
   } catch (e) {
     console.error('stats failed', e.message);
     res.status(500).json({ error: e.message });
   }
});

app.get('/api/offers/:id', async (req, res) => {
  const r = await pool.query('SELECT id, data, updated_at FROM offers WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  const row = r.rows[0];
  res.json({ id: row.id, ...row.data, updated_at: row.updated_at, updatedAt: row.updated_at });
});
app.post('/api/offers', async (req, res) => {
  const b = req.body || {};
  const id = String(b.id || b.ref || ('off-' + Date.now())).slice(0, 128);
  const data = { ...b, id };
  const score = b.score ?? null;
  const match = b.match ?? null;
  const status = b.status || data.status || 'new';
  await pool.query(
    `INSERT INTO offers(id,data,updated_at,score,match,status) VALUES($1,$2,NOW(),$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET data=$2, updated_at=NOW(), score=$3, match=$4, status=$5`,
    [id, JSON.stringify(data), score, match, status]
  );
  const row = (await pool.query('SELECT id, data, updated_at FROM offers WHERE id=$1', [id])).rows[0];
  const payload = { id: row.id, ...row.data, updated_at: row.updated_at, updatedAt: row.updated_at };
  broadcast('/ws/offers', { type: 'offer', data: payload });
  broadcast('/ws/offers', payload);
  res.json(payload);
});
// Bulk insert used by the wide-coverage fleet (2026-09-27).
//
// POST /api/offers with one row per offer would re-"UPDATE" every posting on
// every crawl cycle, which resets updated_at and makes the app show the whole
// market as brand new. With ~800 sources on a 60s cadence that is fatal.
//
// DO NOTHING makes the database the single source of truth for "have I already
// stored this?", so a source can be re-crawled as often as we like without
// duplicating a row or faking freshness. Only genuinely new rows come back and
// only those are broadcast on /ws/offers, which is what drives the real-time
// notification in the app.
//
// Body: { offers: [ {...offer fields..., id} ] } -> { inserted, ids: [...] }
app.post('/api/offers/insert-new', async (req, res) => {
  const list = Array.isArray(req.body?.offers) ? req.body.offers : [];
  if (!list.length) return res.json({ inserted: 0, ids: [] });
  if (list.length > 2000) return res.status(413).json({ error: 'too many offers in one batch' });

  const values = [];
  const params = [];
  let i = 0;
  for (const o of list) {
    const id = String(o.id || o.ref || '').slice(0, 128);
    if (!id) continue;
    const data = { ...o, id };
    values.push(`($${i + 1},$${i + 2},NOW(),$${i + 3},$${i + 4},$${i + 5})`);
    params.push(id, JSON.stringify(data), o.score ?? null, o.match ?? null, o.status || 'new');
    i += 5;
  }
  if (!values.length) return res.json({ inserted: 0, ids: [] });

  let insertedIds = [];
  try {
    const r = await pool.query(
      `INSERT INTO offers(id,data,updated_at,score,match,status) VALUES ${values.join(',')}
       ON CONFLICT (id) DO NOTHING
       RETURNING id, data`,
      params
    );
    insertedIds = r.rows.map((row) => row.id);
  } catch (e) {
    // A single malformed row must never take down a whole source cycle.
    if (e && e.code === '22P02') {
      for (const o of list) {
        const id = String(o.id || o.ref || '').slice(0, 128);
        if (!id) continue;
        try {
          const one = await pool.query(
            `INSERT INTO offers(id,data,updated_at,score,match,status) VALUES($1,$2,NOW(),$3,$4,$5)
             ON CONFLICT (id) DO NOTHING RETURNING id, data`,
            [id, JSON.stringify({ ...o, id }), o.score ?? null, o.match ?? null, o.status || 'new']
          );
          if (one.rows.length) insertedIds.push(one.rows[0].id);
        } catch (_) {}
      }
    } else {
      throw e;
    }
  }

  for (const id of insertedIds) {
    const row = (await pool.query('SELECT id, data, updated_at FROM offers WHERE id=$1', [id])).rows[0];
    if (!row) continue;
    const payload = { id: row.id, ...row.data, updated_at: row.updated_at, updatedAt: row.updated_at };
    broadcast('/ws/offers', { type: 'offer', data: payload });
    broadcast('/ws/offers', payload);
  }
  res.json({ inserted: insertedIds.length, ids: insertedIds });
});

// ---- relevance band -------------------------------------------------------
//
// The band holds offers the KEYWORD engine rejected but which carry enough
// description for an LLM to judge. They are stored with match=false and
// band='pending', so they stay out of the default feed (search filters on
// `match IS TRUE OR score >= 2`) and out of the Vu tab, until a verdict promotes
// them. Without this the classifier can only ever re-rank what keywords already
// found, and the whole point is to recover what they missed.
//
// Deliberately NOT broadcast on insert: a pending offer is not news. Promotion
// below is what broadcasts, so a rescued offer appears in the feed (and the
// websocket) exactly once, when it is actually worth the user's attention.
app.post('/api/offers/insert-band', async (req, res) => {
  const list = Array.isArray(req.body?.offers) ? req.body.offers : [];
  if (!list.length) return res.json({ inserted: 0, ids: [] });
  if (list.length > 500) return res.status(413).json({ error: 'too many band offers in one batch' });

  // TTL: the band is a staging area, not an archive. A posting nobody can act
  // on within RELEVANCE_BAND_TTL_DAYS is stale, so it is pruned by the worker
  // rather than accumulating forever.
  const ttlDays = Math.max(1, Number(process.env.RELEVANCE_BAND_TTL_DAYS || 21));

  const values = [];
  const params = [];
  let i = 0;
  for (const o of list) {
    const id = String(o.id || '').slice(0, 128);
    if (!id) continue;
    const bandAt = new Date().toISOString();
    const data = {
      ...o, id,
      match: false, score: 0,
      band: 'pending',
      bandAt,
      bandExpiresAt: new Date(Date.now() + ttlDays * 86400000).toISOString(),
      bandBy: 'llm-pending',
    };
    values.push(`($${i + 1},$${i + 2},NOW(),0,FALSE,'new')`);
    params.push(id, JSON.stringify(data));
    i += 2;
  }
  if (!values.length) return res.json({ inserted: 0, ids: [] });

  const r = await pool.query(
    `INSERT INTO offers(id,data,updated_at,score,match,status) VALUES ${values.join(',')}
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    params
  );
  res.json({ inserted: r.rows.length, ids: r.rows.map((x) => x.id) });
});

// Claim pending band offers for classification.
//
// A lease, not a plain SELECT: rows are stamped with a claim owner and expiry,
// committed immediately, and only rows whose lease is free (or stale) come back.
// The comment here used to promise FOR UPDATE SKIP LOCKED while the query did
// neither, so two workers would classify the same rows and double-charge the
// token quota -- which matters a lot more now that the provider allowance is the
// binding constraint.
app.get('/api/offers/band/pending', async (req, res) => {
   const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
   const includeExpired = req.query.includeExpired === '1';
   const owner = String(req.query.owner || '').slice(0, 64) || ('anon-' + Math.random().toString(36).slice(2, 10));
   const leaseSec = Math.min(Math.max(Number(req.query.leaseSec || 600), 30), 3600);

   // Single statement, so the claim and the read cannot interleave with another
   // worker's UPDATE: the winner of each row is decided by the same snapshot.
   //
   // The candidate list is built by UPDATE ... FROM a CTE rather than by
   // `WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`. Two reasons, both found
   // the hard way:
   //   1. In the IN-subquery form the subquery is re-evaluated per outer row, so
   //      LIMIT $1 applied per row, not per claim -- returning far more than the
   //      requested number and re-issuing leases already held.
   //   2. FOR UPDATE inside a CTE that is then consumed by an UPDATE is not
   //      honoured: the stale-lease rows stayed permanently unclaimable, i.e. a
   //      crashed worker would have wedged its rows forever.
   //
   // The UPDATE itself takes row locks, so two concurrent claims still serialise;
   // the lease stamp is what makes the outcome deterministic across processes.
   const r = await pool.query(
   `WITH claimable AS (
         SELECT id FROM offers
          WHERE data->>'band' = 'pending'
            AND ${includeExpired ? '' : "(data->>'bandExpiresAt')::timestamptz > NOW()"}
            AND COALESCE((data->>'bandClaimedAt')::timestamptz, to_timestamp(0))
                < NOW() - ($3 || ' seconds')::interval
          ORDER BY (data->>'bandAt') ASC
          LIMIT $1
     )
     UPDATE offers o
        SET data = o.data || jsonb_build_object(
              'bandClaimedBy', $2::text,
              'bandClaimedAt', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            )
       FROM claimable c
      WHERE o.id = c.id
     RETURNING o.id, o.data`,
   [limit, owner, String(leaseSec)]
   );
  res.json({
    items: r.rows.map((row) => ({
      id: row.id,
      title: row.data.title || '',
      company: row.data.company || '',
      location: row.data.location || '',
      country: row.data.country || '',
      link: row.data.link || '',
      sourceId: row.data.sourceId || '',
      description: row.data.description || '',
bandAt: row.data.bandAt || '',
      bandTries: Number(row.data.bandTries || 0),
      claimedBy: row.data.bandClaimedBy || '',
   })),
   owner,
   });
   });

// Record a verdict for one band offer. Promotion flips match/score and sets
// band='promoted', which makes the offer visible in the default feed for the
// first time -- so this is the only band write that broadcasts.
app.post('/api/offers/band/verdict', async (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '').slice(0, 128);
  if (!id) return res.status(400).json({ error: 'id required' });
  const match = b.match === true;
  const score = Math.max(0, Math.min(6, Math.round(Number(b.score) || 0)));
  const cur = await pool.query('SELECT data FROM offers WHERE id=$1', [id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'not found' });

  const prev = cur.rows[0].data || {};
  const merged = {
    ...prev,
    // A promotion must not be undone by a later "no" verdict from a retry, so a
    // promoted offer stays promoted; only its score is refined.
    band: prev.band === 'promoted' ? 'promoted' : (match ? 'promoted' : 'rejected'),
    bandTries: Number(prev.bandTries || 0) + 1,
    bandVerdict: { match, score, reason: String(b.reason || '').slice(0, 200), at: new Date().toISOString(), model: String(b.model || '').slice(0, 60) },
  };
  if (match) { merged.match = true; merged.score = score; }

  await pool.query(
    `UPDATE offers SET data=$1, updated_at=NOW(), score=$2, match=$3 WHERE id=$4`,
    [JSON.stringify(merged), match ? merged.score : 0, match, id]
  );

  if (match && prev.band !== 'promoted') {
    const row = (await pool.query('SELECT id, data, updated_at FROM offers WHERE id=$1', [id])).rows[0];
    const payload = { id: row.id, ...row.data, updated_at: row.updated_at, updatedAt: row.updated_at };
    broadcast('/ws/offers', { type: 'offer', data: payload });
    broadcast('/ws/offers', payload);
  }
  res.json({ ok: true, id, match, score, band: merged.band });
});

// Drop band offers that nobody has judged and that are past their TTL.
app.post('/api/offers/band/prune', async (req, res) => {
  const r = await pool.query(
    `DELETE FROM offers
      WHERE data->>'band' = 'pending' AND (data->>'bandExpiresAt')::timestamptz <= NOW()`,
    []
  );
  res.json({ pruned: r.rowCount || 0 });
});

// ---- behavioural feedback -------------------------------------------------
// The /seen and /status routes below call this so engagement is captured where
// it already happens, with no change to the Flutter app. Weights are advisory
// and stored so the worker can log which signal moved a score.
const EVENT_WEIGHTS = {
  opened: 1, seen: 1,
  saved: 3,
  applied: 6,
  dismissed: -2,
  not_interested: -3,
  archived: -1,
};
async function recordEvent(offerId, kind, meta) {
  const w = EVENT_WEIGHTS[kind];
  if (w == null) return;
  try {
    await pool.query(
      'INSERT INTO offer_events(offer_id,kind,weight,meta) VALUES($1,$2,$3,$4)',
      [String(offerId).slice(0, 128), kind, w, meta ? JSON.stringify(meta) : null]
    );
  } catch (e) {
    console.error('offer_events insert failed', e.message);
  }
}

app.patch('/api/offers/:id', async (req, res) => {
  const cur = await pool.query('SELECT data FROM offers WHERE id=$1', [req.params.id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'not found' });
  const merged = { ...cur.rows[0].data, ...req.body, id: req.params.id };
  await pool.query(
    `UPDATE offers SET data=$1, updated_at=NOW(), score=$2, match=$3, status=$4 WHERE id=$5`,
    [JSON.stringify(merged), merged.score ?? null, merged.match ?? null, merged.status || 'new', req.params.id]
  );
  const row = (await pool.query('SELECT id, data, updated_at FROM offers WHERE id=$1', [req.params.id])).rows[0];
  const payload = { id: row.id, ...row.data, updated_at: row.updated_at, updatedAt: row.updated_at };
  broadcast('/ws/offers', { type: 'offer', data: payload });
  res.json(payload);
});

// Status write that does NOT touch updated_at.
//
// The generic PATCH above stamps updated_at=NOW(), which is what made every
// card show "il y a 3 h" for the user's last tap instead of the posting age,
// and made the Vu view impossible to sort honestly. This route keeps
// updated_at as the posting time and records statusAt separately, so
// "Postul�e il y a 2 jours" is true.
app.patch('/api/offers/:id/status', async (req, res) => {
  const status = String(req.body?.status || '').trim();
  if (!status) return res.status(400).json({ error: 'status required' });
  try {
    const cur = await pool.query('SELECT data FROM offers WHERE id=$1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'not found' });
const merged = { ...cur.rows[0].data, statusAt: new Date().toISOString() };
      await pool.query(
        'UPDATE offers SET data=$1, status=$2 WHERE id=$3',
        [JSON.stringify(merged), status, req.params.id]
      );
      // Engagement signal for relevance feedback. "applied" is the strongest
      // positive the user can give; "dismissed"/"not_interested" are explicit
      // negatives. Recorded here because this is the only place the status
      // actually changes, so the app needs no new call.
      if (status === 'applied') await recordEvent(req.params.id, 'applied', { source: 'status' });
      else if (status === 'dismissed') await recordEvent(req.params.id, 'dismissed', { source: 'status' });
      else if (status === 'not_interested') await recordEvent(req.params.id, 'not_interested', { source: 'status' });
      else if (status === 'saved') await recordEvent(req.params.id, 'saved', { source: 'status' });
    const row = (await pool.query('SELECT id, data, updated_at FROM offers WHERE id=$1', [req.params.id])).rows[0];
    const payload = { id: row.id, ...row.data, updated_at: row.updated_at, updatedAt: row.updated_at };
    broadcast('/ws/offers', { type: 'offer', data: payload });
    res.json(payload);
  } catch (e) {
    console.error('offers status failed', e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Marks an offer as opened ("Vu"). Bumps updated_at on purpose: a freshly
// opened offer IS new information and should float up the default feed.
//
// Idempotent: a second open of the same offer does not move seenAt, so
// re-reading a posting cannot reset the "Vu il y a 2 h" memory. Backed by the
// partial idx_offers_seen index.
app.post('/api/offers/:id/seen', async (req, res) => {
  try {
    const cur = await pool.query('SELECT data, updated_at FROM offers WHERE id=$1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'not found' });
    const data = cur.rows[0].data;
const first = !data?.seenAt;
      const merged = { ...data, seenAt: first ? new Date().toISOString() : data.seenAt };
      await pool.query(
        'UPDATE offers SET data=$1, updated_at=NOW() WHERE id=$2',
        [JSON.stringify(merged), req.params.id]
      );
      // Only the FIRST open counts. The route is idempotent for seenAt, and a
      // re-read must not inflate the "opened" signal into a fake preference.
      if (first) await recordEvent(req.params.id, 'opened', { source: 'seen' });
    const row = (await pool.query('SELECT id, data, updated_at FROM offers WHERE id=$1', [req.params.id])).rows[0];
    const payload = { id: row.id, ...row.data, updated_at: row.updated_at, updatedAt: row.updated_at };
    if (first) broadcast('/ws/offers', { type: 'offer', data: payload });
    res.json(payload);
  } catch (e) {
    console.error('offers seen failed', e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// docs
app.get('/api/docs', async (req, res) => {
  const order = String(req.query.order || 'updated_at.desc');
  const q = order.includes('asc') ? 'ASC' : 'DESC';
  const r = await pool.query(`SELECT id, data, updated_at, pdf_path FROM docs ORDER BY updated_at ${q} LIMIT 500`);
  res.json(r.rows.map((row) => ({ id: row.id, ...row.data, updated_at: row.updated_at, updatedAt: row.updated_at, pdf_path: row.pdf_path })));
});
app.get('/api/docs/:id', async (req, res) => {
  const r = await pool.query('SELECT id, data, updated_at, pdf_path FROM docs WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  const row = r.rows[0];
  res.json({ id: row.id, ...row.data, updated_at: row.updated_at, updatedAt: row.updated_at, pdf_path: row.pdf_path });
});
app.get('/api/docs/:id/pdf', async (req, res) => {
  const r = await pool.query('SELECT pdf_path, data FROM docs WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).send('not found');
  const p = r.rows[0].pdf_path;
  if (p && fs.existsSync(p)) return res.sendFile(path.resolve(p));
  // fallback: data.pdfBase64 or pdfBytes inline
  const data = r.rows[0].data;
  if (data.pdfBase64) {
    const buf = Buffer.from(data.pdfBase64, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    return res.send(buf);
  }
  res.status(404).send('no pdf');
});
app.post('/api/docs', async (req, res) => {
  const b = req.body || {};
  const id = String(b.id || ('doc-' + Date.now())).slice(0, 128);
  let pdfPath = b.pdf_path || null;
  if (b.pdfBase64 && !pdfPath) {
    pdfPath = path.join(PDF_DIR, id + '.pdf');
    try { fs.writeFileSync(pdfPath, Buffer.from(b.pdfBase64, 'base64')); } catch (e) { return res.status(500).json({ error: String(e.message) }); }
  }
  const data = { ...b, id };
  // do not store huge base64 in JSON if we wrote file
  if (pdfPath && data.pdfBase64) delete data.pdfBase64;
  await pool.query(
    `INSERT INTO docs(id,data,updated_at,pdf_path,offer_ref) VALUES($1,$2,NOW(),$3,$4)
     ON CONFLICT (id) DO UPDATE SET data=$2, updated_at=NOW(), pdf_path=$3, offer_ref=$4`,
    [id, JSON.stringify(data), pdfPath, b.offerRef || b.offer_ref || null]
  );
  const row = (await pool.query('SELECT id, data, updated_at, pdf_path FROM docs WHERE id=$1', [id])).rows[0];
  const payload = { id: row.id, ...row.data, updated_at: row.updated_at, updatedAt: row.updated_at, pdf_path: row.pdf_path };
  broadcast('/ws/docs', { type: 'doc', data: payload });
  res.json(payload);
});
app.delete('/api/docs/:id', async (req, res) => {
  const r = await pool.query('SELECT pdf_path FROM docs WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  const p = r.rows[0].pdf_path;
  if (p) try { fs.unlinkSync(p); } catch (_) {}
  await pool.query('DELETE FROM docs WHERE id=$1', [req.params.id]);
  broadcast('/ws/docs', { type: 'doc_deleted', id: req.params.id });
  res.json({ ok: true });
});

// sources
app.get('/api/sources', async (_req, res) => {
  const r = await pool.query('SELECT id, data, enabled, updated_at FROM sources ORDER BY id');
  res.json(r.rows.map((row) => ({ id: row.id, ...row.data, enabled: row.enabled, updated_at: row.updated_at })));
});
app.post('/api/sources', async (req, res) => {
  const b = req.body || {};
  const id = String(b.id || b.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || ('src-' + Date.now());
  const data = { ...b, id };
  await pool.query(
    `INSERT INTO sources(id,data,enabled,updated_at) VALUES($1,$2,$3,NOW())
     ON CONFLICT (id) DO UPDATE SET data=$2, enabled=$3, updated_at=NOW()`,
    [id, JSON.stringify(data), b.enabled !== false]
  );
  const row = (await pool.query('SELECT id, data, enabled, updated_at FROM sources WHERE id=$1', [id])).rows[0];
  const payload = { id: row.id, ...row.data, enabled: row.enabled, updated_at: row.updated_at };
  broadcast('/ws/sources', { type: 'source', data: payload });
  res.json(payload);
});
app.patch('/api/sources/:id', async (req, res) => {
  const cur = await pool.query('SELECT data, enabled FROM sources WHERE id=$1', [req.params.id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'not found' });
  const merged = { ...cur.rows[0].data, ...req.body, id: req.params.id };
  const enabled = req.body.enabled !== undefined ? !!req.body.enabled : cur.rows[0].enabled;
  await pool.query('UPDATE sources SET data=$1, enabled=$2, updated_at=NOW() WHERE id=$3', [JSON.stringify(merged), enabled, req.params.id]);
  const row = (await pool.query('SELECT id, data, enabled, updated_at FROM sources WHERE id=$1', [req.params.id])).rows[0];
  const payload = { id: row.id, ...row.data, enabled: row.enabled, updated_at: row.updated_at };
  broadcast('/ws/sources', { type: 'source', data: payload });
  res.json(payload);
});

// tasks
app.get('/api/tasks', async (req, res) => {
  const status = req.query.status;
  const limit = Math.min(Number(req.query.limit || 100), 500);
  let sql = 'SELECT id, data, status, created_at, updated_at FROM tasks';
  const params = [];
  if (status) { sql += ' WHERE status=$1'; params.push(status); }
  sql += ' ORDER BY updated_at DESC LIMIT $' + (params.length + 1);
  params.push(limit);
  const r = await pool.query(sql, params);
  res.json(r.rows.map((row) => ({ id: row.id, ...row.data, status: row.status, created_at: row.created_at, updated_at: row.updated_at })));
});
app.post('/api/tasks', async (req, res) => {
  const b = req.body || {};
  const id = String(b.id || ('task-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6))).slice(0, 128);
  const status = b.status || 'queued';
  const data = { ...b, id, status };
  await pool.query(
    `INSERT INTO tasks(id,data,status,created_at,updated_at) VALUES($1,$2,$3,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET data=$2, status=$3, updated_at=NOW()`,
    [id, JSON.stringify(data), status]
  );
  const row = (await pool.query('SELECT id, data, status, created_at, updated_at FROM tasks WHERE id=$1', [id])).rows[0];
  const payload = { id: row.id, ...row.data, status: row.status, created_at: row.created_at, updated_at: row.updated_at };
  broadcast('/ws/tasks', { type: 'task', data: payload });
  res.json(payload);
});
app.patch('/api/tasks/:id', async (req, res) => {
  const cur = await pool.query('SELECT data FROM tasks WHERE id=$1', [req.params.id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'not found' });
  const merged = { ...cur.rows[0].data, ...req.body, id: req.params.id };
  const status = req.body.status || merged.status || 'queued';
  await pool.query('UPDATE tasks SET data=$1, status=$2, updated_at=NOW() WHERE id=$3', [JSON.stringify(merged), status, req.params.id]);
  const row = (await pool.query('SELECT id, data, status, created_at, updated_at FROM tasks WHERE id=$1', [req.params.id])).rows[0];
  const payload = { id: row.id, ...row.data, status: row.status, created_at: row.created_at, updated_at: row.updated_at };
  broadcast('/ws/tasks', { type: 'task', data: payload });
  res.json(payload);
});
app.get('/api/tasks/:id', async (req, res) => {
  const r = await pool.query('SELECT id, data, status, created_at, updated_at FROM tasks WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  const row = r.rows[0];
  res.json({ id: row.id, ...row.data, status: row.status, created_at: row.created_at, updated_at: row.updated_at });
});

// profile
app.get('/api/profile', async (_req, res) => {
  const r = await pool.query('SELECT data, updated_at FROM profile WHERE id=$1', ['me']);
  res.json({ id: 'me', ...r.rows[0].data, updated_at: r.rows[0].updated_at });
});
app.put('/api/profile', async (req, res) => {
  const cur = await pool.query('SELECT data FROM profile WHERE id=$1', ['me']);
  const merged = { ...(cur.rows[0]?.data || {}), ...req.body, id: 'me' };
  await pool.query('UPDATE profile SET data=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(merged), 'me']);
  const row = (await pool.query('SELECT data, updated_at FROM profile WHERE id=$1', ['me'])).rows[0];
  res.json({ id: 'me', ...row.data, updated_at: row.updated_at });
});

// chat
// channel=all (or omitted) returns every channel; otherwise filtered to one channel.
app.get('/api/chat/messages', async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 1000);
  const channel = String(req.query.channel || 'main').slice(0, 32);
  const all = channel === 'all';
  const base = 'SELECT m.id, m.text, m.sender, m.channel, m.created_at, m.reply_to, r.sender AS reply_sender, r.text AS reply_text FROM chat_messages m LEFT JOIN chat_messages r ON r.id = m.reply_to';
  const r = all
    ? await pool.query(base + ' ORDER BY m.created_at DESC LIMIT $1', [limit])
    : await pool.query(base + ' WHERE m.channel=$1 ORDER BY m.created_at DESC LIMIT $2', [channel, limit]);
  res.json(r.rows.reverse().map((row) => ({
    id: row.id, key: row.id, text: row.text, sender: row.sender, channel: row.channel, createdAt: row.created_at,
    replyTo: row.reply_to, replySender: row.reply_sender, replyText: row.reply_text,
  })));
});
app.post('/api/chat/messages', async (req, res) => {
  const text = String(req.body?.text || '').slice(0, 4000);
  if (!text.trim()) return res.status(400).json({ error: 'text required' });
  const sender = String(req.body?.sender || 'user').slice(0, 32);
  const channel = String(req.body?.channel || 'main').slice(0, 32);
  const replyTo = String(req.body?.replyTo || req.body?.reply_to || '').slice(0, 64) || null;
  const id = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  if (replyTo) {
    const t = await pool.query('SELECT id FROM chat_messages WHERE id=$1', [replyTo]);
    if (!t.rows.length) {
      return res.json({ error: 'replyTo not found' });
    }
  }
  await pool.query('INSERT INTO chat_messages(id,text,sender,channel,reply_to,created_at) VALUES($1,$2,$3,$4,$5,NOW())', [id, text, sender, channel, replyTo]);
  const row = (await pool.query(
    'SELECT m.id, m.text, m.sender, m.channel, m.created_at, m.reply_to, r.sender AS reply_sender, r.text AS reply_text FROM chat_messages m LEFT JOIN chat_messages r ON r.id = m.reply_to WHERE m.id=$1',
    [id])).rows[0];
  const payload = {
    id: row.id, key: row.id, text: row.text, sender: row.sender, channel: row.channel, createdAt: row.created_at,
    replyTo: row.reply_to, replySender: row.reply_sender, replyText: row.reply_text,
  };
  broadcast('/ws/chat', { type: 'chat', data: payload });
  res.json(payload);
});

// agent status
app.get('/api/agent/status', async (_req, res) => {
  const r = await pool.query('SELECT data, updated_at FROM agent_status WHERE id=$1', ['agent']);
  res.json({ ...r.rows[0].data, updated_at: r.rows[0].updated_at });
});
app.put('/api/agent/status', async (req, res) => {
  const cur = await pool.query('SELECT data FROM agent_status WHERE id=$1', ['agent']);
  const merged = { ...(cur.rows[0]?.data || {}), ...req.body };
  await pool.query('UPDATE agent_status SET data=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(merged), 'agent']);
  const row = (await pool.query('SELECT data, updated_at FROM agent_status WHERE id=$1', ['agent'])).rows[0];
  const payload = { ...row.data, updated_at: row.updated_at };
  broadcast('/ws/agent', { type: 'agent', data: payload });
  res.json(payload);
});

// devices
app.get('/api/devices', async (_req, res) => {
  const r = await pool.query('SELECT id, token, platform, updated_at FROM devices ORDER BY updated_at DESC LIMIT 100');
  res.json(r.rows.map((row) => ({ id: row.id, token: row.token, platform: row.platform, updatedAt: row.updated_at })));
});
app.delete('/api/devices/:id', async (req, res) => {
  await pool.query('DELETE FROM devices WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});
app.post('/api/devices', async (req, res) => {
  const id = String(req.body?.id || 'android').slice(0, 64);
  const token = String(req.body?.token || '').slice(0, 1024);
  if (!token) return res.status(400).json({ error: 'token required' });
  const platform = String(req.body?.platform || 'android').slice(0, 32);
  await pool.query(
    `INSERT INTO devices(id,token,platform,updated_at) VALUES($1,$2,$3,NOW())
     ON CONFLICT (id) DO UPDATE SET token=$2, platform=$3, updated_at=NOW()`,
    [id, token, platform]
  );
  res.json({ ok: true, id });
});

async function start() {
  await init();
  await redisConnect().catch((e) => console.warn('redis connect failed', e.message));
  const server = http.createServer(app);
  const wssMap = wssByPath;
  // single WSS handling multiple paths
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    // register by path prefix
    const key = p.startsWith('/ws/') ? p : '/ws/chat';
    let set = wssMap.get(key);
    if (!set) { set = { clients: new Set() }; wssMap.set(key, set); }
    // also add to generic set for broadcast helper that uses same map
    // we keep per-path sets; broadcast checks exact key
    if (!wssMap.has(key)) wssMap.set(key, { clients: new Set() });
    wssMap.get(key).clients.add(ws);
    ws.on('close', () => wssMap.get(key)?.clients.delete(ws));
    ws.send(JSON.stringify({ type: 'hello', path: key }));
  });
  // also support path-specific servers via upgrade routing
  server.on('upgrade', (req, socket, head) => {
    // let wss handle it generically; path distinction done in connection
  });
  server.listen(PORT, '0.0.0.0', () => console.log(`jobcenter-api listening on ${PORT}`));
}
start().catch((e) => { console.error(e); process.exit(1); });
