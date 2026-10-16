'use strict';
// Offers ingested today. Pages /api/offers/search with ?since=<today 00:00>
// (the only /api/offers path with an offset) and tallies by day/flags.
// Usage: node scripts/offers-today.js [YYYY-MM-DD]
const DAY = String(process.argv[2] || new Date().toISOString().slice(0, 10));
const API = process.env.API_URL || 'http://localhost:3144';
const SINCE = new Date(DAY + 'T00:00:00Z').toISOString();

let token = null;
async function tok() {
  if (token) return token;
  const r = await fetch(API + '/api/auth/anon', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: 'daemon-pc' }),
  });
  token = (await r.json()).token;
  return token;
}
async function search(qs) {
  await tok();
  const r = await fetch(API + '/api/offers/search?' + qs, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('search ' + r.status);
  return r.json();
}

(async () => {
  const dayItems = [];
  let total = null;
  for (let off = 0; ; off += 200) {
    const j = await search('since=' + encodeURIComponent(SINCE) + '&limit=200&offset=' + off + '&sort=updated_at');
    if (total === null) total = j.total;
    dayItems.push(...j.items);
    if (!j.hasMore || !j.items.length) break;
  }
  const postedToday = dayItems.filter((o) => String(o.postedAt || '').slice(0, 10) === DAY);
  const tally = (arr, key) => arr.reduce((a, o) => { const k = String((o[key] == null ? '' : o[key]) || '?'); a[k] = (a[k] || 0) + 1; return a; }, {});
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => k + ':' + v).join('  ');

  const all = await search('limit=1');
  console.log('day              : ' + DAY);
  console.log('offers in DB     : ' + all.total + ' (non-archived)');
  console.log('touched since 00h: ' + total);
  console.log('postedAt = today : ' + postedToday.length);
  console.log('  matched        : ' + postedToday.filter((o) => o.match || (o.score || 0) >= 2).length);
  console.log('  score >= 3     : ' + postedToday.filter((o) => (o.score || 0) >= 3).length);
  console.log('  score >= 4     : ' + postedToday.filter((o) => (o.score || 0) >= 4).length);
  console.log('  status         : ' + JSON.stringify(tally(postedToday, 'status')));
  console.log('  top sources    : ' + top(tally(postedToday, 'sourceId'), 10));
  console.log('  top countries  : ' + top(tally(postedToday, 'country'), 8));
  console.log('  top 5 by score :');
  for (const o of postedToday.filter((x) => (x.score || 0) >= 4).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5)) {
    console.log('    [' + o.ref + '] ' + o.title + ' - ' + o.company + ' (' + (o.location || o.country || '?') + ') tailor=' + (o.tailorStatus || '-'));
  }
})().catch((e) => { console.error('ERR ' + String((e && e.message) || e)); process.exit(1); });
