// One-off: apply the Tunisia 300s cadence cap to legacy (non-registry) TN sources
// that already exist in the API. seed-registry.js only owns registry:true boards,
// so keejob/tunisiejob/tanisjobs/sagemcom/capgemini-tn kept their 600-2700s
// cadence until this ran.
const api = require('./api_client.js');

const CAP = 300000;
const isTN = (s) => /^(tn|tunisie|tunisia)$/i.test(String(s.country || '').trim());

(async () => {
  const all = (await api.listSources()) || [];
  const targets = all.filter((s) => isTN(s) && Number(s.intervalMs || 0) > CAP);
  if (!targets.length) { console.log('nothing to cap'); return; }
  for (const s of targets) {
    try {
      await api.updateSource(s.id, { intervalMs: CAP });
      console.log(`${s.id}: ${Math.round(s.intervalMs / 1000)}s -> ${CAP / 1000}s`);
    } catch (e) {
      console.log(`${s.id}: FAILED ${String((e && e.message) || e).slice(0, 90)}`);
    }
  }
  console.log('capped ' + targets.length + ' sources');
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });