'use strict';
// Hotline helper: queue the SAME adapter task the app chat button creates,
// then poll until done/failed. Usage: node scripts/hotline-adapter.js <offerIdOrRef>
const api = require('../app/daemon/api_client.js');

const REF = String(process.argv[2] || '').trim();
if (!REF) { console.error('usage: node scripts/hotline-adapter.js <offerIdOrRef>'); process.exit(2); }

async function findOffer(q) {
  const s = String(q).trim();
  if (s.length <= 6) return null;
  const byId = await api.getOffer(s).catch(() => null);
  if (byId && byId.id) return byId;
  // /api/offers is capped at 1000 rows, so fall back to the paged search.
  for (let off = 0; off < 2000; off += 200) {
    const j = await api_search(off);
    const items = (j && j.items) || [];
    const hit = items.find((o) => o.id === s) || items.find((o) => o.ref === s);
    if (hit) return hit;
    if (!items.length || j.hasMore === false) break;
  }
  return null;
}

async function api_search(offset) {
  const r = await fetch(api.API + '/api/offers/search?limit=200&offset=' + offset + '&matchOnly=0', {
    headers: { Authorization: 'Bearer ' + (await anonToken()) },
  });
  if (!r.ok) return { items: [], hasMore: false };
  return r.json();
}
let _token = null;
async function anonToken() {
  if (_token) return _token;
  const r = await fetch(api.API + '/api/auth/anon', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: 'daemon-pc' }),
  });
  _token = (await r.json()).token;
  return _token;
}

(async () => {
  const offer = await findOffer(REF);
  if (!offer) { console.error('offer not found: ' + REF); process.exit(3); }
  console.log('offer: ' + offer.id + ' | ref=' + offer.ref + ' | ' + offer.title + ' | tailorStatus=' + (offer.tailorStatus || 'none'));

  const docs = await api.listDocs();
  const existing = (docs.items || docs || []).filter((d) => String(d.offerRef || '') === String(offer.ref || ''));
  if (existing.length) console.log('docs already present: ' + existing.map((d) => d.id).join(', '));

  const task = await api.createTask({
    request: 'adapter ' + offer.id,
    kind: 'adapter',
    status: 'queued',
    offerRef: offer.ref,
    offerId: offer.id,
  });
  console.log('task: ' + task.id);

  const deadline = Date.now() + 5 * 60 * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 8000));
    const t = await api.getTask(task.id).catch(() => null);
    if (!t) { console.log('status: <task vanished>'); break; }
    console.log('status: ' + t.status);
    if (['done', 'failed', 'confirmed'].includes(String(t.status))) {
      console.log('result: ' + (t.result || ''));
      const after = await api.listDocs();
      const made = (after.items || after || []).filter((d) => String(d.offerRef || '') === String(offer.ref || ''));
      console.log('docs: ' + (made.map((d) => d.id).join(', ') || 'none'));
      process.exit(t.status === 'done' ? 0 : 1);
    }
    if (Date.now() > deadline) { console.log('status: timeout'); process.exit(4); }
  }
})().catch((e) => { console.error('ERR ' + String((e && e.message) || e)); process.exit(1); });
