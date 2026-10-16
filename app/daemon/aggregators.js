'use strict';
// Aggregator boards.
//
// WHY THESE EXIST
// Verified per-company ATS boards are the accurate source, but they cap out at a
// few hundred reachable companies: you need the company to publish a board on a
// platform you already know. Aggregators invert that. One request to Arbeitnow or
// Jobicy returns postings from hundreds of companies, each already carrying its
// own company name and location, so a single poll widens the funnel far more
// than a poll of one more company board.
//
// All of these are free, key-less, public JSON endpoints. Every response is
// filtered by the caller (matchedOnly), so adding an aggregator never lets
// off-profile jobs into the feed.

const { getJson, getText, clean, stripHtml, contractOf, countryOf } = require('./adapters.js');
const LEGACY = require('./legacy-adapters.js');
const sleep = LEGACY.sleep;
// legacy-adapters.js keeps its logger private and routes events through
// setLogSink, so the fleet binds one sink that receives both the legacy board
// events and the aggregator events. Single channel, one events-fleet.log.
let sink = () => {};
const log = (e) => { try { sink(e); } catch (_) {} };
LEGACY.setLogSink(log);
const bindLog = (fn) => { sink = typeof fn === 'function' ? fn : () => {}; };

function offer(id, title, company, link, extra = {}) {
  return {
    ref: id,
    title: clean(title),
    company: clean(company || ''),
    link: link || '',
    location: extra.location || '',
    country: extra.country || countryOf(extra.location || '', title || ''),
    contract: extra.contract || contractOf(title || '', extra.tags || ''),
    salary: extra.salary || '',
    remote: extra.remote || '',
    pubDate: extra.pubDate || '',
    description: stripHtml(extra.description || '').slice(0, 4000),
  };
}

// Arbeitnow: free API, Berlin-based, no key, ~1000 remote EU/world postings
// across many companies. Supports ?page= for a couple of pages.
async function arbeitnow(src) {
  const pages = Math.min(3, Number(src.pages || 2));
  const out = [];
  for (let p = 1; p <= pages; p++) {
    let arr = [];
    try { arr = await getJson('https://www.arbeitnow.com/api/job-board-api?page=' + p); } catch (e) { log({ type: 'board_error', board: 'arbeitnow', page: p, error: String(e.message || e) }); break; }
    for (const j of (arr.data || arr)) {
      out.push(offer(String(j.slug || j.id), j.title, j.company_name, j.url, {
        location: j.location || '', remote: j.remote ? 'oui' : '', pubDate: j.created_at || '',
        tags: (j.tags || []).join(' '),
        description: (j.description || '') + ' ' + (j.requirements || ''),
      }));
    }
    if (!arr || !arr.length) break;
    if (p < pages) await sleep(1200);
  }
  return out;
}

// Jobicy: free, no key, remote jobs. The API rejects `page` and caps the
// response at 200 postings, so there is a single request per poll.
async function jobicy(src) {
  let j = null;
  try { j = await getJson('https://jobicy.com/api/v2/remote-jobs'); } catch (e) { log({ type: 'board_error', board: 'jobicy', error: String(e.message || e) }); return []; }
  const arr = j && j.jobs;
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => offer(x.id, x.jobTitle, x.companyName, x.url, {
    location: [x.jobGeo, x.location].filter(Boolean).join(', '),
    remote: 'oui', pubDate: x.pubDate || '',
    tags: (x.jobIndustry || []) + ' ' + (x.jobType || []) + ' ' + (x.experienceLevel || ''),
    description: x.jobDescription || '',
  }));
}

// Remotive (already covered by the legacy adapter) and RemoteOK live in
// legacy-adapters.js. These two are additions with broader Europe/global reach.

// Arbeitnow's Europe-only sibling with country spread: Remotive already exists,
// so this is the German-language aggregator that carries EU industrial employers
// (Siemens/Bosch/SAP contractors) that rarely publish an English ATS board.
async function stepstone(src) {
  // Stepstone has no free public JSON API. Not registered as a source; kept here
  // as a documented gap rather than shipping a source that always 403s.
  return [];
}

// Indeed/LinkedIn cannot be scraped at this rate: both return interstitial HTML
// to datacenter IPs and block on the second concurrent request. They are not
// registered. Tunisia's own portals (keejob, tanitjobs, tunisiejob) are covered
// by the legacy 'html' adapter instead, which is the reason the Tunisian side of
// this registry is board-based rather than aggregator-based.

// Keejob is the single highest-value source for the Tunisian half of this
// registry: ~960 active offers from ~400 Tunisian employers, in one request.
//
// Two things made the old 'html'/keejob source useless:
//   - it scraped /jobs?query=..., which now 404s (the real search path is
//     /offres-emploi/recherche/), so every poll returned 0 items for months;
//   - it parsed the result cards for an 'apartment' icon for the company, which
//     no longer exists in the markup, so offers arrived unattributed.
// Keejob publishes an llms-full.txt index (one line per offer: title, company,
// city, contract, work mode, date, detail link). Parsing that is both cheaper and
// correct, and it is the documented machine-readable surface.
async function keejob(src) {
  let text = '';
  try { text = await getText('https://www.keejob.com/llms-full.txt'); } catch (e) { log({ type: 'board_error', board: 'keejob', error: String(e.message || e) }); return []; }
  const out = [];
  // - [Title](url.md): Company · City, Country · Contract · Work mode · published YYYY-MM-DD
  const re = /^\s*[-*]\s*\[([^\]]*)\]\((https?:\/\/[^\s)]+?)(?:\.md)?\)\s*:\s*(.*)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const title = clean(m[1]);
    const url = m[2].replace(/\.md$/, '/');
    const rest = m[3];
    // Fields are '·'-separated; the last one is the publication date.
    const parts = rest.split('·').map((s) => clean(s)).filter(Boolean);
    if (!parts.length) continue;
    // The trailing field is the publication date ("publiée le 2026-09-28"), but it
    // is only present on some lines and it carries accents, so match the ISO date
    // directly instead of stripping a label by string.
    const dm = rest.match(/(\d{4}-\d{2}-\d{2})/);
    const date = dm ? dm[1] : '';
    const company = parts[0] || '';
    const location = parts[1] || 'Tunisie';
    const contract = parts.find((p) => /CDI|CDD|SIVP|Stage|Freelance|Alternance|Intérim/i.test(p)) || '';
    const remote = /Télétravail|Hybride/i.test(rest) ? clean((parts.find((p) => /Télétravail|Hybride/i.test(p)) || '').split(' ')[0]) : '';
    const idm = url.match(/\/offres-emploi\/(\d+)/);
    out.push({
      ref: idm ? idm[1] : url,
      title,
      company,
      link: url,
      applyUrl: url,
      location,
      country: 'Tunisie',
      contract,
      remote,
      pubDate: date,
      description: '',
    });
  }
  return out;
}

module.exports = {
  arbeitnow,
  jobicy,
  keejob,
  bindLog,
  aggregatorSources() {
    return [
      { id: 'arbeitnow', type: 'arbeitnow', name: 'Arbeitnow (remote EU)', company: '', country: 'Remote', sector: 'remote', intervalMs: 600000, pages: 2, matchedOnly: true },
      { id: 'jobicy', type: 'jobicy', name: 'Jobicy (remote)', company: '', country: 'Remote', sector: 'remote', intervalMs: 600000, matchedOnly: true },
      { id: 'keejob-index', type: 'keejob', name: 'Keejob Tunisie (index llms)', company: '', country: 'Tunisie', sector: 'tunisie', intervalMs: 300000, matchedOnly: true },
    ];
  },
};
