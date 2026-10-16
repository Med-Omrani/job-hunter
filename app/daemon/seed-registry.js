'use strict';
// Seeds the `sources` table from the verified board registry.
//
// Only boards that were LIVE-VERIFIED by probe-registry.js get in. A company with
// no reachable board is simply absent, which is honest: the app would otherwise
// show a source card that can never produce an offer.
//
// Usage:
//   node seed-registry.js --dry-run
//   node seed-registry.js                 # create missing, update existing
//   node seed-registry.js --prune         # disable registry sources that vanished
//
// Idempotent: re-running never duplicates a source and never resets the
// lastCrawlAt of a board that is already being crawled.

const fs = require('fs');
const path = require('path');
const api = require('./api_client.js');
const AGG = require('./aggregators.js');

const REGISTRY_FILES = [
  path.join(__dirname, 'registry', 'companies.json'),
  path.join(__dirname, 'companies.json'),
];

function loadRegistry() {
  const byId = new Map();
  for (const f of REGISTRY_FILES) {
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
    for (const c of Array.isArray(arr) ? arr : []) {
      if (!c || !c.id || !c.type || !c.token) continue;
      if (byId.has(c.id)) continue;
      byId.set(c.id, c);
    }
  }
  return [...byId.values()];
}

// Cadence by what the platform can actually support, verified by measurement:
// greenhouse/ashby/personio answer a conditional GET with 304, so a single poll
// is cheap. The cost is aggregate: every greenhouse board in the registry is the
// same host (boards.greenhouse.io), every ashby the same (jobs.ashbyhq.com). At
// 60s a few hundred boards is several requests a second from one IP to one
// vendor, which is what got this fleet throttled. 180s keeps a board current
// every third poll round while staying under the noise.
const INTERVAL = {
  greenhouse: 180000,
  ashby: 180000,
  personio: 180000,
  lever: 900000,
  workday: 900000,
  smartrecruiters: 900000,
  eightfold: 900000,
  recruitee: 900000,
  workable: 900000,
  capgemini: 900000,
  rss: 900000,
  html: 900000,
  linkedin: 1800000,
  experteer: 1800000,
  remotive: 600000,
  remoteok: 600000,
  render: 1800000,
  arbeitnow: 600000,
  jobicy: 600000,
};

// Only these extra keys are copied off a registry entry. A blanket spread would
// drag probe bookkeeping (items, cheap304, foundBy, via) into the source record.
const PASSTHROUGH = ['tenant', 'site', 'host', 'companySlug', 'num', 'limit', 'domain', 'searchText'];

// Tunisia is the target market, so its boards are polled on a tighter clock than
// the same ATS type needs elsewhere: a Workday/SmartRecruiters/RSS board otherwise
// only refreshes every 900s, which alone blew the "notify me quickly" budget.
// Capped, never lowered: greenhouse/ashby keep their 180s floor, and 300s stays
// well clear of the 60s that got this fleet throttled.
const TN_INTERVAL_CAP = 300000;
const isTN = (c) => /^(tn|tunisie|tunisia)$/i.test(String(c.country || '').trim());

function toSource(c) {
  const s = {
    id: c.id,
    type: c.type,
    token: c.token || '',
    company: c.company || '',
    name: c.name || c.company || c.id,
    country: c.country || '',
    sector: c.sector || '',
    board: c.board || '',
    url: c.url || '',
    intervalMs: isTN(c) ? Math.min(INTERVAL[c.type] || 900000, TN_INTERVAL_CAP) : (INTERVAL[c.type] || 900000),
    matchedOnly: true,
    enabled: true,
    registry: true,
  };
  for (const k of PASSTHROUGH) if (c[k] !== undefined && c[k] !== '') s[k] = c[k];
  return s;
}

(async () => {
  const dry = process.argv.includes('--dry-run');
  const prune = process.argv.includes('--prune');

  const boards = loadRegistry().map(toSource);
  const aggs = AGG.aggregatorSources();
  const wanted = [...boards, ...aggs];
  const byId = new Map(wanted.map((s) => [s.id, s]));
  console.log('registry: ' + boards.length + ' verified boards + ' + aggs.length + ' aggregators = ' + byId.size + ' sources');
  const byType = {};
  for (const s of byId.values()) byType[s.type] = (byType[s.type] || 0) + 1;
  console.log('by type: ' + JSON.stringify(byType));
  const byCountry = {};
  for (const s of byId.values()) { const k = s.country || 'INTL'; byCountry[k] = (byCountry[k] || 0) + 1; }
  console.log('TN boards: ' + (byCountry.TN || 0) + ', international: ' + (byCountry.INTL || 0));
  if (dry) { console.log('--dry-run, nothing written'); return; }

  let existing = [];
  try { existing = await api.listSources(); } catch (e) { console.log('cannot list sources: ' + e.message); process.exit(1); }
  const have = new Map(existing.map((s) => [s.id, s]));

  let created = 0;
  let updated = 0;
  for (const s of byId.values()) {
    const cur = have.get(s.id);
    if (!cur) {
      try { await api.createSource(s); created++; } catch (e) { console.log('create failed ' + s.id + ': ' + String(e.message).slice(0, 90)); }
      continue;
    }
    // Drift is detected on the addressing fields too, not just on the flags. A
    // source seeded before the passthrough keys existed keeps whatever partial
    // addressing it was created with (or none), and its adapter then throws on
    // every poll; without this check those rows are never revisited.
    const drift = PASSTHROUGH.some((k) => s[k] !== undefined && String(cur[k] || '') !== String(s[k]));
    if (cur.registry !== true || cur.enabled === false || cur.intervalMs !== s.intervalMs || cur.type !== s.type || drift) {
      // Never touch crawl bookkeeping (lastCrawlAt/lastError) here.
      const patch = { registry: true, enabled: true, intervalMs: s.intervalMs, type: s.type, token: s.token, company: s.company, matchedOnly: true };
      for (const k of PASSTHROUGH) if (s[k] !== undefined) patch[k] = s[k];
      try { await api.updateSource(s.id, patch); updated++; } catch (e) { console.log('update failed ' + s.id + ': ' + String(e.message).slice(0, 90)); }
    }
  }
  console.log('created ' + created + ', updated ' + updated);

  if (prune) {
    let disabled = 0;
    for (const cur of existing) {
      if (cur.registry !== true) continue;           // only prune our own entries
      if (byId.has(cur.id)) continue;
      try { await api.updateSource(cur.id, { enabled: false }); disabled++; } catch (_) {}
    }
    console.log('disabled ' + disabled + ' registry sources that are no longer verified');
  }
  const total = existing.length + created;
  console.log('total sources in API: ~' + total);
})();
