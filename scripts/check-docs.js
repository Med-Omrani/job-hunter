'use strict';
// Verify generated docs for one offer: exists, size, page count.
// Usage: node scripts/check-docs.js <offerRef>
const api = require('../app/daemon/api_client.js');
const REF = String(process.argv[2] || '').trim();

function pageCount(buf) {
  const s = buf.toString('latin1');
  const c = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
  if (c) return c;
  const m = s.match(/\/Count\s+(\d+)/g);
  return m ? Math.max(...m.map((x) => Number(x.replace(/\D+/g, '')))) : -1;
}

(async () => {
  const docs = await api.listDocs();
  const mine = docs.filter((d) => String(d.offerRef || '') === REF);
  if (!mine.length) { console.log('no docs for ' + REF); process.exit(1); }
  for (const d of mine) {
    let size = 0, pages = -1, ok = false;
    try { const b = await api.docPdf(d.id); size = b.length; pages = pageCount(b); ok = b.slice(0, 5).toString() === '%PDF-'; } catch (e) { size = -1; }
    console.log([d.id, d.type, (size / 1024).toFixed(0) + 'KB', 'pages=' + pages, ok ? 'valid-pdf' : 'BAD'].join('  '));
  }
  const off = docs.length && (await api.listOffers({ limit: 1000 })).find((o) => String(o.ref) === REF);
  if (off) console.log('offer tailorStatus=' + (off.tailorStatus || 'none') + ' tailoredOfferRef=' + (off.tailoredOfferRef || 'none'));
})().catch((e) => { console.error('ERR ' + String((e && e.message) || e)); process.exit(1); });
