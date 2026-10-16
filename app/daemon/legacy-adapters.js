'use strict';
// Legacy board adapters, extracted verbatim from hunter-agent.js on 2026-09-27 so
// that hunter-agent.js (one process per source) and hunter-fleet.js (one process
// for every source) run the exact same code. Do not fork these: a divergence here
// would mean the fleet and the single-source agents disagree about what an offer
// is.
//
// Nothing in this file is source-specific. The log sink is injected by the caller
// because the two callers write to different event logs.

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const DIR = __dirname;

let LOG_SINK = () => {};
function setLogSink(fn) { LOG_SINK = typeof fn === 'function' ? fn : () => {}; }
function log(ev) { try { LOG_SINK(ev); } catch (_) {} }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let expCookie = '';
let expLastRefresh = 0;
function expLoadCookies() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, 'experteer.session.json'), 'utf8'));
    if (j.valid !== true) return '';
    expCookie = j.header || (Array.isArray(j.cookies) ? j.cookies.map((c) => c.name + '=' + c.value).join('; ') : '');
  } catch (_) { expCookie = ''; }
  return expCookie;
}
function expTryRefresh() {
  const now = Date.now();
  if (now - expLastRefresh < 10 * 60 * 1000) return false;
  expLastRefresh = now;
  try {
    require('child_process').spawnSync('node', ['exp-login.js'], { cwd: DIR, timeout: 120000, stdio: 'ignore' });
  } catch (_) {}
  return !!expLoadCookies();
}
async function http(url, opts = {}, redirects = 3) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 JobHunter/2.0', Accept: '*/*', ...opts.headers },
    signal: AbortSignal.timeout(30000),
    ...opts,
  });
  if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location') && redirects > 0) {
    return http(new URL(res.headers.get('location'), url).toString(), opts, redirects - 1);
  }
  return res;
}
async function getText(url) {
  const res = await http(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  let s = buf.toString('utf8');
  if (s.includes('\uFFFD')) s = buf.toString('latin1');
  return s;
}
async function getJson(url, opts) {
  const res = await http(url, opts);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + String(await res.text()).slice(0, 120));
  return res.json();
}
function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', iacute: 'í', oacute: 'ó', aacute: 'á', ucirc: 'û', egrave: 'è' };
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/g, (m, n) => named[n] || m);
}
function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}
// ---------------- adapters ----------------
function parseRssItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const pick = (tag) => { const t = b.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>')); return t ? decodeEntities(t[1]).trim() : ''; };
    const link = pick('link');
    let title = pick('title');
    const desc = pick('description');
    const cats = [...b.matchAll(/<category>([\s\S]*?)<\/category>/g)].map((x) => decodeEntities(x[1]).trim());
    const refm = link.match(/offerReference=([A-Za-z0-9-]+)/);
    let ref = refm ? refm[1] : '';
    if (!ref) { const tm = title.match(/^(\d{4}-\d+)\s*[-–]/); if (tm) ref = tm[1]; }
    title = title.replace(/^\d{4}-\d+\s*[-–]\s*/, '').replace(/\s+H\/F\s*$/i, '').trim();
    let contract = '';
    for (const c of cats) { if (/^(CDI|CDD|CIVP|Stage|VIE|Alternant|CAIP)$/i.test(c)) { contract = c.toUpperCase(); break; } }
    if (!contract) { const cm = desc.match(/Contrat\s*:\s*<\/b>\s*(CDI|CDD|CIVP|Stage)/i); if (cm) contract = cm[1].toUpperCase(); }
    items.push({ ref, link, title, contract, desc: decodeEntities(desc).slice(0, 2500), pubDate: pick('pubDate') });
  }
  return items;
}

function parseLinkedinCards(html) {
  const cards = [];
  const re = /<li>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const b = m[1];
    const urn = b.match(/data-entity-urn="urn:li:jobPosting:(\d+)"/);
    if (!urn) continue;
    const id = urn[1];
    const title = clean((b.match(/<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/) || [])[1] || '');
    const company = clean((b.match(/<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/) || [])[1] || '');
    const location = clean((b.match(/<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '');
    const date = (b.match(/<time[^>]*datetime="([\d-]+)"/) || [])[1] || '';
    const href = (b.match(/<a[^>]*class="[^"]*base-card__full-link[^"]*"[^>]*href="([^"]+)"/) || [])[1] || '';
    const link = decodeURIComponent((href || '').split('?')[0]);
    cards.push({ ref: id, id, title, company, location, date, link });
  }
  return cards;
}
function parseLinkedinDetail(html, id) {
  const title = clean((html.match(/<h1[^>]*class="[^"]*top-card-layout__title[^"]*"[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '');
  const md = html.match(/<div[^>]*class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  let desc = '';
  if (md) desc = clean(md[1].replace(/<br\s*\/?>/g, '\n').replace(/<\/?(ul|ol|li|p|strong|b|em|h3)[^>]*>/g, (t) => (t.startsWith('</') ? '\n' : '')).replace(/<[^>]+>/g, ' '));
  desc = decodeEntities(desc).slice(0, 4000);
  let remote = false;
  if (/remote/i.test(html.slice(0, 200000))) remote = true;
  return { title: clean(title) || undefined, description: desc, remote, link: 'https://www.linkedin.com/jobs/view/' + id };
}

function parseKeejob(html, base) {
  const items = [];
  const re = /<article\b[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const b = m[1];
    const href = (b.match(/<a[^>]*href="(\/offres-emploi\/(\d+)\/[^"]+)"[^>]*>/)) || (b.match(/href="(\/offres-emploi\/(\d+)\/[^"]+)"[^>]*/));
    if (!href) continue;
    const id = href[2];
    const title = clean((b.match(/<a[^>]*\/offres-emploi\/\d+\/[^"]*"[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '');
    const company = clean((b.match(/<a[^>]*href="\/offres-emploi\/companies\/\d+[^"]*"[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '');
    const contract = clean(((b.match(/<i class="[^"]*fa-briefcase[^"]*"><\/i>([\s\S]*?)<\/span>/) || [])[1] || ''));
    const salary = clean(((b.match(/<i class="[^"]*fa-money-bill-wave[^"]*"><\/i>([\s\S]*?)<\/span>/) || [])[1] || ''));
    const location = clean(((b.match(/<i class="[^"]*fa-map-marker-alt[^"]*"><\/i>([\s\S]*?)<\/span>/) || [])[1] || ''));
    const date = clean(((b.match(/<i class="[^"]*fa-clock[^"]*"><\/i>([\s\S]*?)<\/span>/) || [])[1] || ''));
    const excerpt = clean((b.match(/<p class="text-sm text-gray-700[\s\S]*?>([\s\S]*?)<\/p>/) || [])[1] || '').slice(0, 900);
    items.push({ ref: id, id, title: title || ('job-' + id), company, contract, salary, location, date, excerpt, detailUrl: base + href[1] });
  }
  return items;
}
function parseKeejobDetail(html) {
  const md = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (md) {
    try {
      const j = JSON.parse(md[1]);
      if (j['@type'] === 'JobPosting') {
        const desc = decodeEntities(String(j.description || '')).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        return { description: desc.slice(0, 4000), salary: j.baseSalary ? clean(j.baseSalary.value.minValue + ' - ' + j.baseSalary.value.maxValue + ' ' + j.baseSalary.currency) : '', location: clean(j.jobLocation && j.jobLocation.address ? [j.jobLocation.address.addressLocality, j.jobLocation.address.addressRegion].filter(Boolean).join(', ') : (j.jobLocation && j.jobLocation.name) || '') };
      }
    } catch (_) {}
  }
  const d = html.match(/<div class="prose dark:prose-invert max-w-none">([\s\S]*?)<\/div>/);
  let desc = '';
  if (d) desc = decodeEntities(d[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 4000);
  return { description: desc };
}
function parseJobijoba(html) {
  const items = [];
  const re = /<div class="offer" data-id="(ad_[0-9a-f]{32})"[^>]*>([\s\S]*?)(?=<div class="offer"|<\/section>|<\/main>|$)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[1].replace('ad_', '');
    const b = m[2];
    const title = clean((b.match(/<h3[^>]*class="offer-header-title"[^>]*>([\s\S]*?)<\/h3>/) || [])[1] || '');
    const feats = {};
    const fRe = /<span class="feature"[^>]*>([\s\S]*?)<\/span>|<div class="feature"[^>]*>([\s\S]*?)<\/div>/g;
    let f;
    const order = [];
    while ((f = fRe.exec(b)) !== null) {
      const raw = f[0];
      const icon = (raw.match(/icon-([a-z-]+)"/) || [])[1] || '';
      const txt = clean(raw.replace(/<[^>]+>/g, ' ').replace(/icon-[\S]+/g, ''));
      if (icon) { feats[icon] = txt; order.push(icon); }
    }
    const loc = feats['map-marker'] || '';
    const contract = feats['register'] || '';
    // The company used to be read from an 'apartment' feature icon, which
    // jobijoba stopped emitting: every offer came through with company='' and
    // landed in the DB unattributed. The advertiser is in the data-product JSON
    // on the same node as the title, so read it from there and keep the icon as
    // a fallback.
    let company = feats['apartment'] || '';
    if (!company) {
      const dp = (b.match(/data-product="([^"]*)"/) || [])[1] || '';
      const brand = (dp.match(/&quot;brand&quot;:&quot;([^&]*)&quot;/) || [])[1]
        || (dp.match(/"brand"\s*:\s*"([^"]*)"/) || [])[1] || '';
      const cust = (dp.match(/&quot;customerName&quot;:&quot;([^&]*)&quot;/) || [])[1]
        || (dp.match(/"customerName"\s*:\s*"([^"]*)"/) || [])[1] || '';
      company = clean(decodeEntities(brand || cust || ''));
    }
    const salary = feats['banknot'] || '';
    const remote = feats['home'] || '';
    const date = clean((b.match(/<span class="text-primary publication_date">([\s\S]*?)<\/span>/) || [])[1] || '');
    const excerpt = clean(((b.match(/<span class="description">([\s\S]*?)<\/span>/) || [])[1] || '')).slice(0, 900);
    items.push({ ref: id, id, title, company, contract, location: loc, salary, remote: /télétravail/i.test(remote) ? remote : '', date, excerpt, detailUrl: 'https://www.jobijoba.com/fr/annonce/54/' + id });
  }
  return items;
}
function parseJobijobaDetail(html) {
  const title = clean((html.match(/<h1[^>]*class="permalink-title"[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '');
  const blocks = [...html.matchAll(/<div class="permalink-description">([\s\S]*?)<\/div>/g)].map((x) => decodeEntities(x[1].replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ' '))).join('\n').replace(/\s+/g, ' ').trim();
  return { description: blocks.slice(0, 4000), title: clean(title) || undefined };
}

function parseTunisiejob(html) {
  const items = [];
  const seen = new Set();
  const re = /data-source="[^"]*"[^>]*?data-location="([^"]*)"[^>]*?data-contract="([^"]*)"[^>]*?data-date="([^"]*)"[^>]*?data-title="([^"]*)"[^>]*?data-company="([^"]*)"[^>]*?data-description="([\s\S]*?)"[^>]*?data-url="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, location, contract, date, title, company, description, urlPath] = m;
    let id;
    const m24 = urlPath.match(/\/([0-9a-f]{24})\/?$/);
    const mext = urlPath.match(/\/jobs\/external\/([^/]+)\/([^/]+)\//);
    if (m24) id = m24[1];
    else if (mext) id = 'ext-' + mext[2];
    else { const g = urlPath.match(/\/jobs\/([^/]+)/); if (!g) continue; id = g[1]; }
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      ref: id, id, title: clean(decodeEntities(title)), company: clean(decodeEntities(company)),
      link: 'https://tunisiejob.tn' + urlPath, location: clean(decodeEntities(location)), country: postingCountry(location) || 'Tunisie',
      contract: clean(decodeEntities(contract)), date: clean(decodeEntities(date)),
      remote: /teletravail|remote|freelance|distance/i.test(location) ? 'Oui' : '',
      description: clean(decodeEntities(description)).slice(0, 4000),
    });
  }
  return items;
}

const REGION_PLACES = ['Tunisie', 'Tunis', 'Ben Arous', 'Megrine', 'Sousse', 'Sfax', 'Ariana', 'Nabeul', 'France', 'Paris', 'Lyon', 'Grenoble', 'Toulouse', 'Bordeaux', 'Nantes', 'Rennes', 'La Ciotat', 'Marcoussis', 'Aix', 'Cherbourg', 'Strasbourg', 'Lille', 'Marseille'];
function extractLocation(text) {
  const hay = (' ' + clean(text) + ' ').toLowerCase();
  const found = [];
  for (const p of REGION_PLACES) if (hay.includes(p.toLowerCase())) found.push(p);
  return [...new Set(found)].slice(0, 3).join(', ');
}

// Same contract as adapters.js countryOf, and the same reason it is separate:
// derive the country from the POSTING, never from the employer's source record.
// src.country is the company's country; using it as a fallback is what made
// offers with an unrecognised location come back tagged as the source's country.
const POSTING_COUNTRY = /tunis|tunisie|tunisia|sousse|sfax|monastir|nabeul|gab[eè]s|bizerte|ariana|ben\s*arous|megrine|kairouan|b[eé]ja|el\s*mida|zaghouan|gafsa|tozeur|kebili|manouba|hamamet|mahdia|jeben|douz/i;
function postingCountry(...texts) {
  const hay = texts.filter(Boolean).join(' ');
  if (POSTING_COUNTRY.test(hay)) return 'Tunisie';
  if (/france|paris|lyon|grenoble|toulouse|nantes|rennes|marseille|lille|bordeaux|strasbourg|aix|marcoussis|la\s*ciotat|cherbourg|montpellier|reims|dijon|metz|brest|angers|le\s*mans/i.test(hay)) return 'France';
  if (/remote|worldwide|anywhere|world\s*wide/i.test(hay)) return 'Remote';
  return '';
}

// For the Tunisia-only job boards (keejob, tunisiejob, tanitjobs) a posting often
// carries no location at all, and dropping the label would lose ~19 real Tunisian
// offers. Those boards publish nothing but Tunisian work, so an unrecognised
// location there still means Tunisia. The exemption is deliberately narrow: only
// a source registered as Tunisia gets it. That is the exact boundary the 40
// ghost offers fell through — a source registered 'TN' used to be able to
// override the posting's own location, which is what stamped 'TN' onto New York,
// London and Berlin jobs.
function postingCountryOrTN(...texts) {
  const last = texts[texts.length - 1];
  const src = (last && typeof last === 'object') ? texts.pop() : null;
  const found = postingCountry.apply(null, texts);
  if (found) return found;
  return src && /^(tunisie|tn)$/i.test(String(src.country || '').trim()) ? 'Tunisie' : '';
}

function parseExperteer(html, base) {
  const items = [];
  const seen = new Set();
  const push = (it) => {
    if (!it.title) return;
    if (it.link && it.link === base) return;
    if (/^[a-zàâäéèêëîïôöùûüç -]+ \((fr|france)\)$/i.test(it.title)) return;
    const key = (it.link || it.title + it.company).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const ref = it.ref || crypto.createHash('md5').update(it.link || (it.title + '|' + it.company)).digest('hex');
    items.push({ ...it, ref });
  };
  const ld = [];
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let j = null;
    try { j = JSON.parse(m[1]); } catch (_) { continue; }
    const t = Array.isArray(j) ? j : [j];
    for (const x of t) ld.push(x);
  }
  const scan = (x) => {
    if (!x || typeof x !== 'object') return;
    if (x['@type'] === 'JobPosting' || (Array.isArray(x['@type']) && x['@type'].includes('JobPosting'))) {
      const title0 = clean(x.title || '');
      const desc0 = clean(String(x.description || '').replace(/<[^>]+>/g, ' '));
      if (title0.length < 3 || !x.datePosted || !desc0 || !(x.hiringOrganization || x.jobLocation)) return;
      const jl = x.jobLocation || {};
      const addr = (jl.address || jl) || {};
      const loc = [addr.addressLocality, addr.addressRegion].filter(Boolean).join(', ');
      const cc = addr.addressCountry || '';
      const ccName = (cc && typeof cc === 'object') ? cc.name : cc;
      const country = postingCountry(ccName, loc) || (/^fr$/i.test(String(ccName || '').trim()) ? 'France' : '');
      const ident = (x.identifier && (typeof x.identifier === 'object' ? x.identifier.value : x.identifier)) || '';
      const link = x.url || (ident ? 'https://www.experteer.fr/offre/' + ident : '');
      const ctm = /(FULL_TIME|PART_TIME|CONTRACTOR|TEMPORARY|INTERN|VOLUNTEER|PER_DIEM|OTHER)/i;
      const contract = String(x.employmentType || '').replace(ctm, (s) => ({ FULL_TIME: 'CDI', PART_TIME: 'Temps partiel', CONTRACTOR: 'Prestation', TEMPORARY: 'CDD', INTERN: 'Stage', VOLUNTEER: 'Bénévolat', PER_DIEM: 'Mission', OTHER: 'Autre' }[s.toUpperCase()] || s));
      push({
        title: clean(x.title || ''),
        company: (x.hiringOrganization && x.hiringOrganization.name) || '',
        link,
        ref: String(ident),
        location: clean(loc),
        country,
        contract,
        description: clean(String(x.description || '').replace(/<[^>]+>/g, ' ')).slice(0, 4000),
        date: x.datePosted || '',
      });
      return;
    }
    if (x['@graph']) for (const y of x['@graph']) scan(y);
  };
  for (const x of ld) scan(x);

  if (!items.length) {
    const re = /<a[^>]*href="(https:\/\/www\.experteer\.fr\/(?:offre|emploi|job|search)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const link = m[1];
      const title = clean(m[2].replace(/<[^>]+>/g, ' '));
      if (title.length < 280) push({ title, link, company: '', location: '', country: 'France', contract: '', description: '', date: '' });
    }
  }
  return items.slice(0, 60);
}

// ---------------- crawl per source kind ----------------
// ---- Aggregator redirect resolution (WP5) ------------------------------------
// remotive / remoteok / remote.co / himalayas / sagemcom give us an AGGREGATOR
// link, not the employer's ATS page. The documented strategy for these
// sources is the same bypass we use everywhere else: resolve to the real ATS
// host, then apply the per-ATS flow (session injection / guest / shadow DOM).
// So we unwrap the redirect HERE, at harvest time, and store the result as
// offer.applyUrl; apply-driver then detects a real board (greenhouse, workday,
// smartrecruiters…) instead of falling back to "outbound = manual".
//
// Three shapes are handled, in order of reliability:
//   1. HTTP 3xx chain (http() already follows it, so res.url is the destination)
//   2. remoteok.com/l/<slug> — a JS page whose real target sits in the API
//   3. meta refresh / window.location in the HTML body
// Returns '' when nothing resolves, so callers keep the original link.
const AGGREGATOR_RX = /(^|\.)(remotive\.com|remoteok\.com|remote\.co|himalayas\.(com|app)|sagemcom\.com|arbeitnow\.com|weworkremotely\.com)$/i;

function isAggregator(url) { try { return AGGREGATOR_RX.test(new URL(url).hostname); } catch (_) { return false; } }

async function resolveApplyUrl(url) {
  const start = String(url || '').trim();
  if (!start) return '';
  if (!isAggregator(start)) return start; // already a direct ATS link

  // remoteok exposes the canonical employer URL in its API. The /l/<slug>
  // landing page is JS-only, so scraping it yields nothing useful.
  const slugMatch = start.match(/remoteok\.com\/l\/([^/?#]+)/i);
  if (slugMatch) {
    try {
      const res = await http('https://remoteok.com/api', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' } });
      if (res.ok) {
        const list = await res.json();
        if (Array.isArray(list)) {
          const hit = list.find((p) => p && p.slug === slugMatch[1]);
          if (hit && hit.apply_url && !isAggregator(hit.apply_url)) return hit.apply_url;
        }
      }
    } catch (_) {}
  }

  // HTTP 3xx: http() follows redirects, so the final response URL is the target.
  try {
    const res = await http(start, { method: 'GET' });
    if (res && res.url && !isAggregator(res.url)) return res.url;
  } catch (_) {}

  // Last resort: meta refresh / JS redirect in the body.
  try {
    const res = await http(start, { method: 'GET' });
    if (res && res.ok) {
      const html = (await res.text()).slice(0, 200000);
      const m = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+url=([^"'\s>]+)/i)
        || html.match(/window\.location(?:\.href)?\s*=\s*["'](https?:\/\/[^"']{6,300})["']/i)
        || html.match(/<link[^>]+rel=["']?canonical["']?[^>]+href=["'](https?:\/\/[^"']{6,300})["']/i);
      if (m && m[1] && !isAggregator(m[1])) return decodeEntities(m[1]);
    }
  } catch (_) {}

  return '';
}
const ADAPTERS = {
  async rss(src) {
    const xml = await getText(src.url);
    const items = parseRssItems(xml);
    return items.map((i) => ({ ref: i.ref, title: i.title, company: src.company || '', link: i.link, location: extractLocation(i.desc + ' ' + i.title), country: postingCountry(i.desc, i.title, i.location), contract: i.contract, pubDate: i.pubDate || '', description: i.desc.slice(0, 4000) }));
  },
  async html(src) {
    const kind = src.board || 'keejob';
    if (kind === 'keejob') {
      // The cap used to be 4, which silently ignored every query past the
      // fourth: a source configured with 30 sector keywords crawled 4 of them
      // and looked like it was working. The list is now bounded by time budget
      // (queries are sequential with a politeness delay) rather than by a magic
      // number, and the count actually used is logged.
      const qs = (src.queries || ['automatisme', 'embarqué', 'électronique', 'iot']).slice(0, Number(src.maxQueries || 30));
      const out = [];
      for (const q of qs) {
        let html = '';
        try { html = await getText(src.url.replace('%Q%', encodeURIComponent(q))); } catch (e) { log({ type: 'board_error', board: 'keejob', query: q, error: String(e.message || e) }); continue; }
        try {
          for (const it of parseKeejob(html, 'https://www.keejob.com')) {
            if (it.ref === 'undefined') continue;
            out.push({ ref: it.ref, title: it.title, company: it.company, link: it.detailUrl, location: extractLocation(it.location + ' ' + (it.excerpt || '')), country: postingCountry(it.location, it.excerpt, it.title) || 'Tunisie', contract: it.contract, salary: it.salary, description: it.excerpt || '', _detailUrl: it.detailUrl });
          }
        } catch (e) { log({ type: 'board_parse_error', board: 'keejob', error: String(e.message || e) }); }
        await sleep(1500);
      }
      return out;
    }
    if (kind === 'tunisiejob') {
      const urls = [src.url || 'https://tunisiejob.tn/jobs/', 'https://tunisiejob.tn/emploi/informatique/', 'https://tunisiejob.tn/emploi/ingenieur/'];
      const out = [];
      for (const u of urls) {
        try {
          const html = await getText(u);
          for (const it of parseTunisiejob(html)) out.push(it);
        } catch (e) { log({ type: 'board_error', board: 'tunisiejob', url: u, error: String(e.message || e) }); }
        await sleep(2000);
      }
      return out;
    }
    if (kind === 'tanitjobs') {
      try {
        const html = await getText(src.url.replace('%Q%', encodeURIComponent((src.queries || ['automatisme'])[0])));
        const items = [];
        const re = /<a[^>]*href="(\/emploi\/[^"]+)"[^>]*class="[^"]*job-link[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
        let m;
        while ((m = re.exec(html)) !== null) {
          const href = m[1];
          const title = clean(m[2].replace(/<[^>]+>/g, ' '));
          const idm = href.match(/\/emploi\/(\d+)/);
          if (!idm) continue;
          // The location used to be a literal 'Tunisie' string, so every tanitjobs
          // posting looked like it was based in the country rather than the city.
          // The board is Tunisia-only, so the country holds; the city, if the
          // title names one, is now preserved.
          items.push({ ref: idm[1], title: title || ('tanit-' + idm[1]), company: src.company || '', link: 'https://www.tanitjobs.com' + href, location: extractLocation(title) || 'Tunisie', country: postingCountry(title) || 'Tunisie', contract: '', description: '' });
        }
        return items;
      } catch (e) {
        const s = String(e.message || e);
        if (/HTTP 4/i.test(s)) log({ type: 'board_blocked', board: 'tanitjobs', error: s });
        else throw e;
        return [];
      }
    }
    if (kind === 'jobijoba') {
      const paths = (src.queries || ['automatisme', 'systeme+embarque', 'electrotechnique', 'iot', 'robotique']).slice(0, Number(src.maxQueries || 12));
      const out = [];
      for (const p of paths) {
        try {
          const html = await getText('https://www.jobijoba.com/fr/emploi/' + p + '/');
          for (const it of parseJobijoba(html)) {
            const hours = (it.date.match(/Il y a (\d+) h/i) || [])[1];
            out.push({ ref: it.ref, title: it.title, company: it.company, link: it.detailUrl, location: extractLocation(it.location + ' ' + (it.excerpt || '')), country: 'France', contract: it.contract, salary: it.salary, remote: it.remote, description: it.excerpt || '', postedHoursAgo: hours ? Number(hours) : -1, _detailUrl: it.detailUrl });
          }
        } catch (e) { log({ type: 'board_error', board: 'jobijoba', error: String(e.message || e) }); }
        await sleep(2000);
      }
      return out;
    }
    throw new Error('unsupported html board: ' + kind);
  },
  async experteer(src) {
    if (!expCookie) expLoadCookies();
    const urls = [src.url || 'https://www.experteer.fr/offres-paris-cid1414675', ...(src.urls || [])];
    const out = [];
    const seenRef = new Set();
    let guard = false;
    const expCountryFromUrl = (u) => {
      if (/(cid1414675)/.test(u)) return 'France';
      if (/cid12964574|cid12965140/.test(u)) return 'Irlande';
      if (/cid2100453|cid2102276|cid2103422|cid5530/.test(u)) return 'Norvège';
      if (/cid2200754|cid2208912/.test(u)) return 'Suède';
      if (/cid12618425/.test(u)) return 'Danemark';
      if (/cid1700001/.test(u)) return 'Luxembourg';
      if (/cid2300001/.test(u)) return 'Finlande';
      if (/cid12524098/.test(u)) return 'Monaco';
      return '';
    };
    const fetchOne = async (url) => {
      const res = await http(url, { headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8', 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8', ...(expCookie ? { Cookie: expCookie } : {}) } });
      if (!res.ok) { const s = 'HTTP ' + res.status; if (/HTTP 4/.test(s)) log({ type: 'board_blocked', board: 'experteer', url, error: s }); else log({ type: 'board_error', board: 'experteer', url, error: s }); return ''; }
      return Buffer.from(await res.arrayBuffer()).toString('utf8');
    };
    for (const url of urls) {
      let html = '';
      try { html = await fetchOne(url); } catch (e) { log({ type: 'board_error', board: 'experteer', url, error: String(e.message || e) }); continue; }
      if (!html || !/<!doctype html/i.test(html.slice(0, 256)) || /Checking your browser|recaptcha|\/recaptcha\//i.test(html.slice(0, 120000))) {
        if (expCookie && !guard) {
          guard = true;
          log({ type: 'board_blocked', board: 'experteer', url, error: 'challenge-with-session, refreshing' });
          if (expTryRefresh()) { try { html = await fetchOne(url); } catch (e) { html = ''; } }
        }
        if (!html || !/<!doctype html/i.test(html.slice(0, 256)) || /Checking your browser|recaptcha|\/recaptcha\//i.test(html.slice(0, 120000))) {
          log({ type: 'board_blocked', board: 'experteer', url, error: 'bot-challenge' });
          continue;
        }
      }
      const country = expCountryFromUrl(url);
      for (const it of parseExperteer(html, url)) {
        if (it.ref) { if (seenRef.has(it.ref)) continue; seenRef.add(it.ref); }
        out.push({ ...it, country: country || it.country });
      }
      await sleep(2000);
    }
    if (!out.length && process.env.EXP_BROWSER === '1') {
      let crawl;
      try { crawl = require('./exp-browser.js'); } catch (_) { crawl = null; }
      if (crawl) {
        log({ type: 'board_browser_fallback', board: 'experteer', note: 'http yielded nothing, using headless browser' });
        try {
          const res = await crawl.crawlListings(urls, {});
          for (const r of res) {
            if (r.error) log({ type: 'board_error', board: 'experteer', url: r.url, error: r.error });
            const country = expCountryFromUrl(r.url);
            for (const c of r.offers) {
              if (seenRef.has(c.id)) continue;
              seenRef.add(c.id);
              out.push({ ref: c.id, title: c.title, company: c.company, link: c.link.startsWith('http') ? c.link : 'https://www.experteer.fr' + c.link, location: '', country, salary: c.salary, date: c.published, description: '', _via: 'browser' });
            }
          }
          if (out.length) log({ type: 'board_browser_ok', board: 'experteer', count: out.length });
        } catch (e) { log({ type: 'board_error', board: 'experteer', error: 'browser-fallback: ' + String((e && e.message) || e) }); }
      }
    }
    return out;
  },
  async linkedin(src) {
    const queries = src.queries || ['automatisme', 'systèmes embarqués', 'électrotechnique', 'iot', 'ingénieur automatisme'];
    const locations = src.locations || ['Tunisie', 'France', 'Remote'];
    const out = [];
    const seen = new Set();
    for (const q of queries) {
      for (const loc of locations) {
        if (out.length > 40) break;
        const url = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=' + encodeURIComponent(q) + '&location=' + encodeURIComponent(loc) + '&start=0&f_TPR=r604800';
        let html = '';
        try { html = await getText(url); } catch (e) { log({ type: 'board_error', board: 'linkedin', query: q, loc: loc, error: String(e.message || e) }); continue; }
        if (!html || html.includes('jobs-guest') && html.trim().length < 200) { log({ type: 'board_empty', board: 'linkedin', query: q, loc: loc }); }
        for (const c of parseLinkedinCards(html)) {
          const key = c.ref;
          if (seen.has(key)) continue;
          seen.add(key);
          // The search geo is a fallback, not the answer. The old ternary read
          // only the geo and had no Remote arm, so every job returned by the
          // 'Remote' pass was tagged France. Prefer what the posting itself says.
          const country = postingCountry(c.location, c.title) || (/remote/i.test(loc) ? 'Remote' : /tunis/i.test(loc) ? 'Tunisie' : /france|^fr$/i.test(loc) ? 'France' : '');
          out.push({ ref: key, title: c.title, company: c.company, link: c.link || ('https://www.linkedin.com/jobs/view/' + c.ref), location: extractLocation(c.location), country, _detailId: c.ref, _date: c.date });
        }
        await sleep(1500);
      }
    }
    return out;
  },
  async smartrecruiters(src) {
    // Used to default to 'Talan', so a source that lost its companySlug crawled
    // Talan's board and attributed ~180 postings to the wrong employer. Fail
    // loudly instead: a missing slug is a bug in the source, not a fallback.
    const company = src.companySlug || src.token || '';
    if (!company) throw new Error('smartrecruiters: companySlug required');
    const all = await getJson('https://api.smartrecruiters.com/v1/companies/' + encodeURIComponent(company) + '/postings?limit=100');
    return (all.content || all || []).map((p) => {
      const loc = p.location || {};
      return { ref: p.id, title: p.name, company: (p.company && p.company.name) || company, link: 'https://jobs.smartrecruiters.com/' + company + '/' + p.id + (p.jobAdId ? '-' + p.jobAdId : ''), location: extractLocation(loc.fullLocation || [loc.city, loc.region, loc.country].filter(Boolean).join(', ')), country: String(loc.country || '').toUpperCase() === 'TN' ? 'Tunisie' : String(loc.country || '').toUpperCase() === 'FR' ? 'France' : '', contract: p.typeOfEmployment || '', description: '' };
    });
  },
  async eightfold(src) {
    // Was pinned to stmicroelectronics.eightfold.ai, so any other Eightfold
    // tenant silently returned STMicro's postings under its own company name.
    // `host` comes from the prober; the legacy STMicro source (which carries only
    // `domain`) keeps working because the tenant is the domain without its TLD.
    const tenant = src.tenant || String(src.domain || '').split('.')[0] || '';
    const host = src.host || (tenant ? tenant + '.eightfold.ai' : '');
    if (!host) throw new Error('eightfold: host/tenant/domain required');
    const num = src.num || 500;
    // NO domain parameter. Measured against stmicroelectronics.eightfold.ai:
    // omitting it returns the board (first posting "HR Partner Senior
    // Specialist @ Tunis, Tunisia"), while passing domain= as the tenant, as the
    // bare token, as the full eightfold host, or as the corporate domain (st.com)
    // each returns 404. The hostname alone identifies the tenant, and adding a
    // domain filter is what used to make this board unreadable.
    const j = await getJson('https://' + host + '/api/apply/v2/jobs?start=0&num=' + num);
    return (j.positions || []).map((p) => ({ ref: String(p.display_job_id || p.ats_job_id || p.id), title: p.name, company: src.company || src.tenant || '', link: p.canonicalPositionUrl || ('https://' + host + '/careers/job/' + p.id), location: extractLocation(p.location), country: /tunis/i.test(p.location || '') ? 'Tunisie' : /france/i.test(p.location || '') ? 'France' : '', contract: '', description: clean(p.job_description || '').slice(0, 2500) }));
  },
  async capgemini(src) {
    const cc = src.countryCode || 'tn-en';
    const search = src.search || '';
    const out = [];
    for (let page = 1; page <= (src.pages || 1); page++) {
      const url = 'https://cg-jobstream-api.azurewebsites.net/api/job-search?page=' + page + '&size=100&country_code=' + cc + (search ? '&search=' + encodeURIComponent(search) : '');
      const j = await getJson(url);
      const list = j.data || [];
      for (const p of list) {
        out.push({ ref: String(p.id || p._id || p.source_ref || p.aws_id), title: p.title, company: 'Capgemini ' + (p.brand || ''), link: p.apply_job_url || '', location: extractLocation(p.location || ''), country: /tn/i.test(cc) ? 'Tunisie' : 'France', contract: p.contract_type || '', experience: p.experience_level, description: clean(p.description_stripped || p.description || '').slice(0, 4000) });
      }
      if (!list.length) break;
      await sleep(800);
    }
    return out;
  },
  async workday(src) {
    // Was hardcoded to tenant 'ag' / site 'Airbus' on host wd3, so every tenant
    // except Airbus produced a 404. Workday tenants are spread over wd1..wd5 and
    // the site segment is company-specific ('Careers', 'valeo_jobs', ...), so
    // both come from the source: `host` is the full hostname the prober read off
    // the careers page, and site/tenant are its path pieces.
    const tenant = src.tenant || '';
    const site = src.site || '';
    const host = src.host || (tenant ? tenant + '.wd3.myworkdayjobs.com' : '');
    if (!tenant || !site || !host) throw new Error('workday: tenant/site/host required');
    const url = 'https://' + host + '/wday/cxs/' + tenant + '/' + site + '/jobs';
    const BASE_URL = 'https://' + host + '/wday/cxs/' + tenant + '/' + site;

    // A TN employer's Workday board is usually GLOBAL, and the Tunisia slice is
    // a rounding error inside it: Valeo's board serves 1,015 postings of which
    // exactly 10 are Tunisian, and they sit past the first 100 — the head of the
    // board is Pune. The board ignores the `location` request field entirely
    // (measured: location=Tunisia still returns total=1015), so paging the head
    // can never reach them. searchText does. For a source registered as TN we
    // therefore ask for the Tunisia slice first and union it with the head, so
    // a Tunisian opening is never missed just because a Pune one sorts above it.
    const terms = [];
    if (src.searchText) terms.push(String(src.searchText));
    if (String(src.country || '').toUpperCase() === 'TN') terms.push('Tunisie', 'Tunisia');
    terms.push('');   // always include the head: a TN board is still a global board

    const out = [];
    const seen = new Set();
    for (const term of terms) {
      for (let offset = 0; offset < (src.limit || 100); offset += 20) {
        let jobs = [];
        try {
          const j = await getJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: term, location: '' }) });
          jobs = j.jobPostings || [];
        } catch (_) { break; }
        for (const p of jobs) {
          const path = (p.externalPath || '').split('?')[0];
          const ref = String(p.bulletFields && p.bulletFields[0] || path.split('_').pop() || offset);
          if (seen.has(ref)) continue;
          seen.add(ref);
          // `_wdBase`/`_wdPath` let the fleet fetch the real description later. The LIST
          // endpoint returns only {title, externalPath, locationsText, postedOn, bulletFields} --
          // it has NO jobPostingInfo at all, so jobPostingInfo.JobDescription above is
          // ALWAYS undefined and every Workday offer was stored with an empty body.
          // Verified live against valeo_jobs: the detail endpoint
          // /wday/cxs/{tenant}/{site}{externalPath} returns jobPostingInfo.jobDescription
          // (lowercase j) with ~1.7 kB of HTML. Descriptions are fetched lazily, only
          // for postings we intend to keep, because a single tenant board can carry
          // 1,004 postings and fetching all of them would be an absurd request storm.
          out.push({ ref, title: p.title, company: src.company || site, link: 'https://' + host + '/en-US/' + site + path, location: extractLocation(p.locationsText || ''), country: /france/i.test(p.locationsText || '') ? 'France' : '', contract: '', description: clean(p.jobPostingInfo && p.jobPostingInfo.JobDescription || '').slice(0, 3000), _wdBase: BASE_URL, _wdPath: path });
        }
        if (!jobs.length) break;
        await sleep(1200);
      }
    }
    return out;
  },
  async remotive(src) {
    const j = await getJson('https://remotive.com/api/remote-jobs');
    const out = [];
    const jobs = Array.isArray(j.jobs) ? j.jobs : [];
    for (const p of jobs) {
      if (!p.id && !p.url) continue;
      const tags = Array.isArray(p.tags) ? p.tags.join(' ') : '';
      const desc = clean(decodeEntities(String(p.description || '').replace(/<[^>]+>/g, ' '))).slice(0, 4000);
      const link = p.url || '';
      // Unwrap the aggregator link to the employer's ATS page.
      const applyUrl = await resolveApplyUrl(link).catch(() => '');
      out.push({ ref: String(p.id), title: clean(p.title), company: clean(p.company_name || ''), link, applyUrl, location: clean(p.candidate_required_location || 'Remote'), country: '', contract: clean(p.job_type || ''), salary: clean(p.salary || ''), remote: 'Oui', description: desc });
    }
    return out;
  },
  async remoteok(src) {
    const res = await http('https://remoteok.com/api', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (!Array.isArray(j) || !j.length) return [];
    const out = [];
    for (const p of j.slice(1)) {
      if (!p || !p.id || !p.position) continue;
      const tags = Array.isArray(p.tags) ? p.tags.join(' ') : '';
      const desc = clean(decodeEntities(String(p.description || '').replace(/<[^>]+>/g, ' '))).slice(0, 4000);
      const salary = p.salary_min ? '$' + p.salary_min + ' - $' + p.salary_max : '';
      out.push({ ref: String(p.id), title: clean(p.position), company: clean(p.company || ''), link: p.apply_url ? ('https://remoteok.com/l/' + p.slug) : '', applyUrl: clean(p.apply_url || ''), location: clean(p.location || 'Remote'), country: '', contract: (p.types && p.types.length ? p.types[0] : '') || '', salary, remote: 'Oui', description: desc });
    }
    return out;
  },
  async render(src) {
    const { crawlRenderListings } = require('./render-boards');
    const siteId = String(src.id || src.board || 'render');
    const urls = [src.renderUrl || src.url].concat(src.urls || []).filter(Boolean).slice(0, 8);
    const recs = await crawlRenderListings(urls, siteId);
    const out = [];
    for (const r of recs) {
      for (const it of r.offers) {
        if (!it.title) continue;
        const href = it.link || it.href || '';
        if (!href) continue;
        // src.country used to be concatenated into the text handed to
        // extractLocation, which manufactured a location out of the employer's
        // own country for every posting on the page. Now the location is what
        // the posting actually says, and an empty location stays empty.
        out.push({ ref: String(it.ref || Math.abs(hash(href + it.title))), title: clean(it.title), company: src.company || '', link: href, location: extractLocation([it.location, it.city, it.title].filter(Boolean).join(' ')), country: postingCountry(it.location, it.city, it.title, it.description), contract: '', description: '' });
      }
    }
    return out;
  },
};
async function enrichDetail(it, src) {
  try {
    if (src.type === 'html' && src.board === 'keejob' && it._detailUrl) {
      const html = await getText(it._detailUrl);
      const d = parseKeejobDetail(html);
      return { description: d.description || it.description, salary: d.salary || it.salary, location: d.location || it.location };
    }
    if (src.type === 'html' && src.board === 'jobijoba' && it._detailUrl) {
      const html = await getText(it._detailUrl);
      const d = parseJobijobaDetail(html);
      return { description: d.description || it.description, title: d.title || it.title };
    }
    if (src.type === 'linkedin' && it._detailId) {
      await sleep(1500);
      const html = await getText('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/' + it._detailId);
      const d = parseLinkedinDetail(html, it._detailId);
      return { description: d.description || it.description, remote: d.remote, link: d.link || it.link };
    }
  } catch (e) {
    log({ type: 'enrich_error', ref: it.ref, error: String(e.message || e) });
  }
  return {};
}

// The render adapter called hash(), which never existed in this file, so every
// 'render' source (jobteaser, wttj) threw a ReferenceError instead of returning
// listings. Same expression, now defined.
function hash(s) { return crypto.createHash('md5').update(String(s)).digest('hex'); }

module.exports = {
  ADAPTERS, enrichDetail, setLogSink, http, getText, getJson, clean, decodeEntities,
  extractLocation, sleep, isAggregator, resolveApplyUrl, parseRssItems,
  parseLinkedinCards, parseLinkedinDetail, parseKeejob, parseKeejobDetail,
  parseJobijoba, parseJobijobaDetail, parseTunisiejob, parseExperteer,
};
