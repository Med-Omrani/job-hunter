'use strict';
/*
 * purge-docs.js — delete generated CV/letter documents.
 *
 * Generated pairs live in two places: a `docs` row in Postgres and a PDF in the
 * `pdfdata` Docker volume (mounted at /app/data/pdfs inside the api container).
 * Only the API can unlink the PDF, so this script goes through the API rather
 * than SQL: DELETE /api/docs/:id unlinks the file, drops the row and notifies
 * the app over the websocket, so the Documents tab updates itself.
 *
 * It also clears `tailorStatus` / `tailoredOfferRef` on the offers that lost
 * their documents, otherwise the UI keeps showing "Ré-adapter" and the manual
 * apply sheet keeps claiming a tailored CV exists for offers that have none.
 *
 * Usage (from the repo root):
 *   node scripts/purge-docs.js --dry-run
 *   node scripts/purge-docs.js
 *   node scripts/purge-docs.js --keep-hours 12          # keep the last 12h
 *   node scripts/purge-docs.js --keep-ref R-10066672    # keep one offer (repeatable)
 *   node scripts/purge-docs.js --keep-refs-from-stdin  # one ref per line
 *   node scripts/purge-docs.js --no-offer-reset        # leave offer flags alone
 *   node scripts/purge-docs.js --prune-auto-tasks      # also drop tailor-hunter-* rows
 *
 * Env: API_URL (default http://localhost:3144, same default as the daemon).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const API = process.env.API_URL || process.env.JOBCENTER_API_URL || 'http://localhost:3144';
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { keepHours: null, keepRefs: new Set(), dryRun: false, offerReset: true, pruneAutoTasks: false, resetStaleOffers: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-offer-reset') out.offerReset = false;
    else if (a === '--prune-auto-tasks') out.pruneAutoTasks = true;
    else if (a === '--reset-stale-offers') { out.resetStaleOffers = true; out.offerReset = true; }
    else if (a === '--keep-hours') out.keepHours = Number(argv[++i]);
    else if (a === '--keep-ref') out.keepRefs.add(String(argv[++i] || '').trim());
    else if (a === '--keep-refs-from-stdin') {
      for (const line of fs.readFileSync(0, 'utf8').split(/\r?\n/)) {
        const v = line.trim();
        if (v) out.keepRefs.add(v);
      }
    } else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

const HELP = [
  'purge-docs.js — delete generated CV/letter documents (docs rows + PDF files)',
  '',
  '  --dry-run                 list what would be deleted, change nothing',
  '  --keep-hours N            keep documents newer than N hours',
  '  --keep-ref REF            keep this offer ref (repeatable)',
  '  --keep-refs-from-stdin    keep every ref listed on stdin, one per line',
  '  --no-offer-reset          do not clear tailorStatus on the affected offers',
  '  --reset-stale-offers      only clear tailorStatus on offers whose documents are gone',
  '  --prune-auto-tasks        also delete the tailor-hunter-* task rows',
].join('\n');

let token = null;
async function auth() {
  if (token) return token;
  const res = await fetch(API + '/api/auth/anon', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: 'purge-docs' }),
  });
  if (!res.ok) throw new Error('auth failed ' + res.status + ' (is the api up at ' + API + '?)');
  token = (await res.json()).token;
  return token;
}
async function call(p, opts = {}) {
  await auth();
  const res = await fetch(API + p, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error('API ' + (opts.method || 'GET') + ' ' + p + ' -> ' + res.status + ' ' + (await res.text().catch(() => '')).slice(0, 200));
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

async function listAllDocs() {
  // /api/docs is hard-capped at 500 rows server-side (api/server.js), so warn
  // instead of pretending the list is complete when the backlog is bigger.
  const docs = await call('/api/docs?order=asc');
  if (!Array.isArray(docs)) throw new Error('unexpected /api/docs response');
  if (docs.length >= 500) console.warn('! /api/docs returned the 500-row server cap — older documents may exist beyond it and are not listed here.');
  return docs;
}

// /api/offers has no offset support (it is kept byte-identical for the hunters)
// and returns a bare array, so paging has to go through /api/offers/search,
// which returns { items, total } and caps the page at 200.
async function forEachOffer(fn) {
  let offset = 0, total = Infinity;
  for (let page = 0; page < 200 && offset < total; page++) {
    const res = await call('/api/offers/search?limit=200&offset=' + offset + '&all=1&sort=updated_at&order=asc');
    const items = res && Array.isArray(res.items) ? res.items : [];
    if (!items.length) return;
    total = Number(res.total) || total;
    for (const o of items) fn(o);
    offset += items.length;
  }
}

async function resetStaleOfferFlags(args) {
  // Offers still flagged tailorStatus:'ready' whose documents are gone (purged,
  // deleted by hand, or never generated because the task failed). The UI would
  // otherwise keep showing "Ré-adapter" and the apply sheet would keep pointing
  // at a CV that is not there.
  const have = new Set((await listAllDocs()).map((d) => String(d.offerRef || '')));
  const candidates = [];
  await forEachOffer((o) => {
    if (!o.tailorStatus) return;
    const ref = String(o.tailoredOfferRef || o.ref || o.id);
    if (have.has(ref)) return;
    candidates.push({ id: o.id, ref, tailorStatus: o.tailorStatus });
  });
  console.log('offers with tailorStatus but no document: ' + candidates.length);
  let done = 0;
  for (const c of candidates) {
    if (args.dryRun) { console.log('  [dry-run] clear tailorStatus on offer ' + c.id + ' (' + c.ref + ', was ' + c.tailorStatus + ')'); continue; }
    try { await call('/api/offers/' + encodeURIComponent(c.id), { method: 'PATCH', body: JSON.stringify({ tailorStatus: null, tailoredOfferRef: null }) }); done++; }
    catch (e) { console.error('  ! offer ' + c.id + ' (' + c.ref + '): ' + e.message); }
  }
  if (!args.dryRun) console.log('offer flags cleared on ' + done + ' offer(s)');
  return candidates.length;
}

function pruneAutoTasks() {
  // No DELETE route for tasks, and the rows are worthless once the docs are
  // gone, so this one goes straight to Postgres through the container.
  // Covers both auto tailor id schemes still in the wild: 'tailor-hunter-<ref>'
  // (live hunter path) and 'tailor-auto-<ref>' (older batch-apply path). Matched
  // by id on purpose: the looser data->>'autoChained' test also catches the
  // frozen auto-APPLY chain rows, and this script is not the place to wipe that
  // history. Queued rows are left alone: something may still run them.
  const cid = execFileSync('docker', ['compose', 'ps', '-q', 'postgres'], { cwd: ROOT, encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  if (!cid) throw new Error('postgres container not found (docker compose ps -q postgres)');
  const sql = "DELETE FROM tasks WHERE (id LIKE 'tailor-hunter-%' OR id LIKE 'tailor-auto-%') AND status <> 'queued'";
  const out = execFileSync('docker', ['exec', cid, 'psql', '-U', 'jobcenter', '-d', 'jobcenter', '-t', '-c', sql], { encoding: 'utf8' });
  return out.trim();
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }

  if (args.resetStaleOffers) { await resetStaleOfferFlags(args); return; }

  const docs = await listAllDocs();
  if (!docs.length) {
    console.log('No documents to purge.');
    // --prune-auto-tasks is independent of the documents: stale auto task rows
    // can outlive them.
    if (args.pruneAutoTasks && !args.dryRun) console.log('pruned auto tailor tasks: ' + pruneAutoTasks());
    return;
  }

  const cutoff = Number.isFinite(args.keepHours) ? Date.now() - args.keepHours * 3600e3 : null;
  const stamp = (d) => Date.parse(d.updated_at || d.updatedAt || '') || 0;
  const doomed = docs.filter((d) => {
    const ref = String(d.offerRef || d.offer_ref || '');
    if (args.keepRefs.has(ref)) return false;
    if (cutoff && stamp(d) >= cutoff) return false;
    return true;
  });
  const kept = docs.filter((d) => !doomed.includes(d));

  const byType = (list) => list.reduce((a, d) => ((a[d.type || '?'] = (a[d.type || '?'] || 0) + 1), a), {});
  console.log('documents: ' + docs.length + ' total, ' + doomed.length + ' to delete, ' + kept.length + ' kept');
  console.log('  delete by type: ' + JSON.stringify(byType(doomed)));
  if (kept.length) console.log('  kept refs: ' + [...new Set(kept.map((d) => d.offerRef).filter(Boolean))].join(', '));

  let failed = 0;
  for (const d of doomed) {
    if (args.dryRun) { console.log('  [dry-run] DELETE /api/docs/' + d.id); continue; }
    try { await call('/api/docs/' + encodeURIComponent(d.id), { method: 'DELETE' }); }
    catch (e) { failed++; console.error('  ! ' + d.id + ': ' + e.message); }
  }
  if (!args.dryRun) console.log('deleted ' + (doomed.length - failed) + ' document(s)' + (failed ? ', ' + failed + ' FAILED' : ''));

  if (args.offerReset) await resetStaleOfferFlags(args);

  if (args.pruneAutoTasks) {
    if (args.dryRun) console.log('  [dry-run] DELETE auto-chained adapter tasks');
    else console.log('pruned auto tailor tasks: ' + pruneAutoTasks());
  }
})().catch((e) => { console.error('purge-docs failed: ' + (e && e.message ? e.message : e)); process.exit(1); });
