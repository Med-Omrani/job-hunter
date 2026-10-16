'use strict';
const API = process.env.API_URL || process.env.JOBCENTER_API_URL || 'http://localhost:3144';
let token = null;
async function ensureToken() {
  if (token) return token;
  const res = await fetch(API + '/api/auth/anon', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: 'daemon-' + (process.env.SOURCE_ID || 'pc') }),
  });
  if (!res.ok) throw new Error('auth failed ' + res.status);
  const j = await res.json();
  token = j.token;
  return token;
}
async function api(path, opts = {}) {
  await ensureToken();
  const headers = { ...(opts.headers || {}), Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const res = await fetch(API + path, { ...opts, headers });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`API ${opts.method || 'GET'} ${path} ${res.status} ${txt.slice(0,200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}
// offers
async function listOffers(params = {}) {
  const q = new URLSearchParams(params).toString();
  return api('/api/offers' + (q ? '?' + q : ''));
}
async function getOffer(id) { return api('/api/offers/' + encodeURIComponent(id)); }
// Targeted lookup: listOffers({limit:1000}) only ever returns the newest
// thousand rows, so a task naming an older offer could not be resolved. The
// search endpoint queries the whole table.
async function searchOffers(q, limit) {
  const params = new URLSearchParams({ q: String(q || ''), limit: String(limit || 25) });
  const res = await api('/api/offers/search?' + params.toString());
  return Array.isArray(res) ? res : (res.items || res.results || []);
}
async function createOffer(data) { return api('/api/offers', { method: 'POST', body: JSON.stringify(data) }); }
async function updateOffer(id, patch) { return api('/api/offers/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(patch) }); }
async function upsertOffer(id, data) { return createOffer({ id, ...data }); }
// Bulk insert that never touches existing rows, so re-crawling a board cannot
// reset updated_at and make old postings look new. Returns { inserted, ids }.
async function insertNewOffers(offers) {
  if (!Array.isArray(offers) || !offers.length) return { inserted: 0, ids: [] };
  return api('/api/offers/insert-new', { method: 'POST', body: JSON.stringify({ offers }) });
}

// Relevance band: offers the keyword engine rejected but that carry enough
// description for the LLM to judge. Stored with match=false / band='pending' so
// they stay out of the feed until a verdict promotes them.
async function insertBandOffers(offers) {
  if (!Array.isArray(offers) || !offers.length) return { inserted: 0, ids: [] };
  return api('/api/offers/insert-band', { method: 'POST', body: JSON.stringify({ offers }) });
}
// owner/leaseSec make this a real claim: the API stamps the rows so a concurrent
// worker cannot pick up the same offers (which would double-spend the provider's
// token quota). Omitting them still works for read-only inspection.
async function listBandPending(limit, owner, leaseSec) {
   let q = '/api/offers/band/pending?limit=' + Math.min(Math.max(Number(limit || 20), 1), 100);
   if (owner) q += '&owner=' + encodeURIComponent(owner);
   if (leaseSec) q += '&leaseSec=' + Number(leaseSec);
   const r = await api(q);
   return Array.isArray(r.items) ? r.items : [];
   }
async function bandVerdict(v) {
  return api('/api/offers/band/verdict', { method: 'POST', body: JSON.stringify(v) });
}
async function pruneBand() {
  return api('/api/offers/band/prune', { method: 'POST', body: '{}' });
}

// docs
async function listDocs() { return api('/api/docs'); }
async function createDoc(data) { return api('/api/docs', { method: 'POST', body: JSON.stringify(data) }); }
async function deleteDoc(id) { return api('/api/docs/' + encodeURIComponent(id), { method: 'DELETE' }); }

// sources
async function listSources() { return api('/api/sources'); }
async function getSource(id) { const all = await listSources(); return all.find((s) => s.id === id) || null; }
async function createSource(data) { return api('/api/sources', { method: 'POST', body: JSON.stringify(data) }); }
async function updateSource(id, patch) { return api('/api/sources/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(patch) }); }

// tasks
async function listTasks(params = {}) {
  const q = new URLSearchParams(params).toString();
  return api('/api/tasks' + (q ? '?' + q : ''));
}
async function createTask(data) { return api('/api/tasks', { method: 'POST', body: JSON.stringify(data) }); }
async function updateTask(id, patch) { return api('/api/tasks/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(patch) }); }
async function getTask(id) { return api('/api/tasks/' + encodeURIComponent(id)); }

// chat
async function listChat(limit = 200, channel) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (channel) q.set('channel', channel);
  return api('/api/chat/messages?' + q.toString());
}
async function sendChat(text, sender = 'user', channel) {
  return api('/api/chat/messages', { method: 'POST', body: JSON.stringify({ text, sender, ...(channel ? { channel } : {}) }) });
}

// profile
async function getProfile() { return api('/api/profile'); }
async function putProfile(data) { return api('/api/profile', { method: 'PUT', body: JSON.stringify(data) }); }

// agent status
async function getAgentStatus() { return api('/api/agent/status'); }
async function putAgentStatus(data) { return api('/api/agent/status', { method: 'PUT', body: JSON.stringify(data) }); }

// devices
async function saveDevice(tokenStr) { return api('/api/devices', { method: 'POST', body: JSON.stringify({ id: 'android', token: tokenStr, platform: 'android' }) }); }
async function listDevices() { return api('/api/devices'); }
async function deleteDevice(id) { return api('/api/devices/' + encodeURIComponent(id), { method: 'DELETE' }); }

// docs PDF bytes (for apply attachments)
async function docPdf(id) {
  await ensureToken();
  const res = await fetch(API + '/api/docs/' + encodeURIComponent(id) + '/pdf', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error('pdf ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = {
  API,
  listOffers, getOffer, searchOffers, createOffer, updateOffer, upsertOffer, insertNewOffers,
  insertBandOffers, listBandPending, bandVerdict, pruneBand,
  listDocs, createDoc, deleteDoc,
  listSources, getSource, createSource, updateSource,
  listTasks, createTask, updateTask, getTask,
  docPdf,
  listChat, sendChat,
  getProfile, putProfile,
  getAgentStatus, putAgentStatus,
  saveDevice, listDevices, deleteDevice,
};
