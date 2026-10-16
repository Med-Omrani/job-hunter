'use strict';
// Zero-auth ATS adapters for per-company career feeds (2026-09-27).
//
// Every endpoint here was verified live before being written down; the shapes
// in the comments are copied from the real responses, not from memory:
//
//   Greenhouse  GET boards-api.greenhouse.io/v1/boards/{token}/jobs
//               -> { jobs:[{id,title,updated_at,first_published,location:{name},
//                   absolute_url,company_name,departments,offices,metadata}],
//                    companies, meta }            ETag: yes
//   Lever       GET api.lever.co/v0/postings/{site}?mode=json
//               -> [ {id,text,categories:{location,team,department,commitment},
//                   descriptionPlain,description,createdAt(ms),applyUrl,
//                   hostedUrl,country,lists} ]    ETag: yes
//   Ashby       GET api.ashbyhq.com/posting-api/job-board/{slug}
//               -> { jobs:[{id,title,location,employmentType,isListed,isRemote,
//                   publishedAt,applyUrl,jobUrl,descriptionHtml}],
//                    organization:{name}, apiVersion }  ETag: yes
//   Personio    GET {sub}.jobs.personio.de/xml   (Workzag-flavoured XML)
//               -> <workzag-jobs><position><id>..<title>..<categories>..  ETag: yes
//   Recruitee   GET {sub}.recruitee.com/api/offers/?limit=100&offset=N
//   Workable    GET apply.workable.com/api/v2/accounts/{sub}/jobs
//
// Greenhouse/Lever/Ashby/Personio are confirmed working and carry an ETag, which
// is what lets the fleet poll them every 60s for the price of a 304.
// Recruitee and Workable are only reachable for the accounts that actually use
// them, so ats-prober.js verifies them before a source is ever created: if the
// endpoint does not answer with postings, the company is dropped from the
// registry instead of becoming a permanently broken source.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 JobCenter/2.0';

async function http(url, opts = {}, redirects = 3) {
  // Big boards (a 780-posting Lever site, a Workday tenant with several
  // thousand jobs) regularly need more than the legacy 30s budget, and missing a
  // cycle is worse than waiting: every request here is idempotent and re-run.
  const timeout = Number(opts.timeout || process.env.FLEET_HTTP_TIMEOUT_MS || 60000);
  const headers = { 'User-Agent': UA, Accept: '*/*', ...opts.headers };
  const res = await fetch(url, {
    ...opts,
    headers,
    signal: AbortSignal.timeout(timeout),
  });
  if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location') && redirects > 0) {
    return http(new URL(res.headers.get('location'), url).toString(), opts, redirects - 1);
  }
  return res;
}

async function getJson(url, opts) {
  const res = await http(url, opts);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + String(await res.text()).slice(0, 120));
  return res.json();
}

async function getText(url) {
  const res = await http(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  let s = buf.toString('utf8');
  if (s.includes('\uFFFD')) s = buf.toString('latin1');
  return s;
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', iacute: 'í', oacute: 'ó', aacute: 'á', ucirc: 'û' };
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/g, (m, n) => named[n] || m);
}

function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

// Conditional GET cache. Greenhouse, Lever, Ashby and Personio all answer with
// an ETag, so re-polling a board that has not changed costs a 304 (~200 bytes)
// instead of a full posting list. That is the whole reason a 60s cadence over
// hundreds of boards is affordable: the poll always happens, the body almost
// never transfers. Entries are held in memory and flushed to disk by the fleet.
const etagCache = new Map();
const stats = { requests: 0, cond200: 0, cond304: 0 };
function etagGet(key) { return etagCache.get(key) || null; }
function etagSet(key, etag, lastModified) { etagCache.set(key, { etag: etag || '', lm: lastModified || '', t: Date.now() }); }
function etagAll() { return Object.fromEntries(etagCache); }
function etagLoad(obj) {
  try { for (const [k, v] of Object.entries(obj || {})) etagCache.set(k, v); } catch (_) {}
}

// Returns { notModified: true } on 304, otherwise { j } with the raw text kept
// so text feeds (Personio XML) can be parsed the same way.
async function condFetch(url, key) {
  stats.requests++;
  const headers = {};
  const prev = key ? etagGet(key) : null;
  if (prev && prev.etag) headers['If-None-Match'] = prev.etag;
  if (prev && prev.lm) headers['If-Modified-Since'] = prev.lm;
  const res = await http(url, { headers });
  if (res.status === 304) { stats.cond304++; return { notModified: true, text: '' }; }
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + String(await res.text()).slice(0, 120));
  stats.cond200++;
  const buf = Buffer.from(await res.arrayBuffer());
  let text = buf.toString('utf8');
  if (text.includes('\uFFFD')) text = buf.toString('latin1');
  if (key) etagSet(key, res.headers.get('etag'), res.headers.get('last-modified'));
  return { notModified: false, text, headers: res.headers };
}

async function condJson(url, key) {
  const r = await condFetch(url, key);
  if (r.notModified) return { notModified: true };
  try { return { notModified: false, j: JSON.parse(r.text) }; } catch (e) { throw new Error('bad json: ' + String(e.message || e).slice(0, 80)); }
}

function stripHtml(s) {
  return clean(decodeEntities(String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?(p|li|ul|ol|tr|div|h[1-6]|strong|b|em)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')));
}

// Same place list the legacy boards use, so location strings stay comparable.
const REGION_PLACES = ['Tunisie', 'Tunis', 'Ben Arous', 'Megrine', 'Sousse', 'Sfax', 'Ariana', 'Nabeul', 'France', 'Paris', 'Lyon', 'Grenoble', 'Toulouse', 'Bordeaux', 'Nantes', 'Rennes', 'La Ciotat', 'Marcoussis', 'Aix', 'Cherbourg', 'Strasbourg', 'Lille', 'Marseille', 'Béja', 'Beja', 'Monastir', 'Gabès', 'Gabes', 'Kairouan', 'El Mida', 'Zaghouan', 'Bizerte', 'Gafsa', 'Tozeur', 'Kebili'];
function extractLocation(text) {
  const hay = (' ' + clean(text) + ' ').toLowerCase();
  const found = [];
  for (const p of REGION_PLACES) if (hay.includes(p.toLowerCase())) found.push(p);
  return [...new Set(found)].slice(0, 3).join(', ');
}

const TN_HINTS = /tunis|tunisie|tunisia|sousse|sfax|monastir|nabeul|gab[eè]s|bizerte|ariana|ben\s*arous|megrine|kairouan|b[eé]ja|el\s*mida|zaghouan|gafsa|tozeur|kebili|manouba|hamamet|mahdia|jeben|douz/i;

// WHY src.country IS NOT AN ARGUMENT HERE
// Every adapter used to call countryOf(loc, src.country) || (src.country || '').
// Two failures came out of that. (1) The board's country was treated as if it
// were offer text, so a source registered as country 'Tunisie' made TN_HINTS
// match on EVERY posting it served and stamped all of them 'Tunisie' whatever
// their location. (2) When the location matched nothing, the `||` fallback
// stamped the board's country onto the offer, which is how 18 Vinci postings
// with no real address ended up country 'TN' under a location of 'Palo Alto HQ'
// (Ashby's default placeholder), alongside New York, London and Dusseldorf jobs.
//
// An offer's country is now derived from the offer alone. The employer's own
// country stays on the source, and the fleet copies it to `companyCountry` on
// the offer so nothing is lost — it is just no longer passed off as where the
// job is.
function countryOf(...texts) {
  const hay = texts.filter(Boolean).join(' ');
  if (TN_HINTS.test(hay)) return 'Tunisie';
  if (/france|paris|lyon|grenoble|toulouse|nantes|rennes|marseille|lille|bordeaux|strasbourg|aix|marcoussis|la\s*ciotat|cherbourg|france/i.test(hay)) return 'France';
  if (/remote|worldwide|anywhere|world/i.test(hay)) return 'Remote';
  return '';
}

const CONTRACT_MAP = [
  [/\b(full[\s-]?time|fulltime|permanent|cdi|ind[eé]termini|unbounded)\b/i, 'CDI'],
  [/\b(part[\s-]?time|temps\s*partiel)\b/i, 'Temps partiel'],
  [/\b(fixed[\s-]?term|cdd|contract|determinate|temporaire|temporary)\b/i, 'CDD'],
  [/\b(intern|internship|stag|stage|stagiaire)\b/i, 'Stage'],
  [/\b(contractor|freelance|consultant|consulting|self[\s-]?employed|independ)\b/i, 'Freelance'],
  [/\b(apprentic|alternance|apprentissage)\b/i, 'Alternance'],
];

function contractOf(...texts) {
  const hay = ' ' + texts.filter(Boolean).join(' ') + ' ';
  for (const [re, out] of CONTRACT_MAP) if (re.test(hay)) return out;
  return '';
}

// Slug variants to try when guessing an ATS board token from a company name.
function slugVariants(name, domain) {
  const base = String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
  const parts = String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(' ').filter(Boolean);
  const out = new Set();
  if (base) out.add(base);
  if (parts.length) {
    out.add(parts.join(''));
    out.add(parts.join('-'));
    out.add(parts.join('_'));
    out.add(parts[0]);
    if (parts.length > 1) out.add(parts.slice(0, 2).join(''));
  }
  if (domain) {
    const d = String(domain).toLowerCase().replace(/^www\./, '');
    out.add(d.split('.')[0].replace(/[^a-z0-9]/g, ''));
  }
  return [...out].filter((s) => s.length >= 3 && s.length <= 40);
}

const ATS = {
  async greenhouse(src) {
    const token = src.token || src.atsSlug || '';
    if (!token) throw new Error('greenhouse: token required');
    // content=false keeps the poll cheap; descriptions are fetched per match.
    const r = await condJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`, 'gh:' + token);
    if (r.notModified) return [];
    const j = r.j;
    const jobs = Array.isArray(j.jobs) ? j.jobs : [];
    const company = src.company || (jobs[0] && jobs[0].company_name) || token;
    return jobs.map((p) => {
      const loc = (p.location && p.location.name) || '';
      const dept = Array.isArray(p.departments) && p.departments[0] ? p.departments[0].name : '';
      return {
        ref: String(p.id),
        title: clean(p.title),
        company,
        link: p.absolute_url || `https://job-boards.greenhouse.io/${token}/jobs/${p.id}`,
        applyUrl: p.absolute_url || `https://job-boards.greenhouse.io/${token}/jobs/${p.id}`,
        location: extractLocation(loc) || clean(loc),
        country: countryOf(loc),
        contract: contractOf(dept, loc),
        description: '',
        // Greenhouse exposes updated_at + first_published, not a posted date.
        postedAtHint: p.first_published || p.updated_at || '',
        _detail: { ats: 'greenhouse', token, id: p.id },
      };
    });
  },

  async lever(src) {
    const site = src.token || src.atsSlug || '';
    if (!site) throw new Error('lever: token required');
    const r = await condJson(`https://api.lever.co/v0/postings/${encodeURIComponent(site)}?mode=json`, 'lv:' + site);
    if (r.notModified) return [];
    const arr = r.j;
    const list = Array.isArray(arr) ? arr : [];
    return list.map((p) => {
      const cat = p.categories || {};
      const loc = cat.location || '';
      const commitment = cat.commitment || '';
      return {
        ref: String(p.id),
        title: clean(p.text),
        company: src.company || site,
        link: p.hostedUrl || `https://jobs.lever.co/${site}/${p.id}`,
        applyUrl: p.applyUrl || p.hostedUrl || '',
        location: extractLocation(loc) || clean(loc),
        country: countryOf(loc, p.country),
        contract: contractOf(commitment) || (commitment ? clean(commitment) : ''),
        description: clean(p.descriptionPlain || '').slice(0, 4000),
        // Lever createdAt is epoch MILLISECONDS.
        postedAtHint: p.createdAt || '',
        _detail: { ats: 'lever', site, id: p.id },
      };
    });
  },

  async ashby(src) {
    const slug = src.token || src.atsSlug || '';
    if (!slug) throw new Error('ashby: token required');
    const r = await condJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`, 'as:' + slug);
    if (r.notModified) return [];
    const j = r.j;
    const jobs = Array.isArray(j.jobs) ? j.jobs : [];
    const org = (j.organization && j.organization.name) || '';
    return jobs.filter((p) => p.isListed !== false).map((p) => {
      const loc = p.location || '';
      return {
        ref: String(p.id),
        title: clean(p.title),
        company: src.company || org || slug,
        link: p.jobUrl || p.applyUrl || `https://jobs.ashbyhq.com/${slug}/${p.id}`,
        applyUrl: p.applyUrl || p.jobUrl || '',
        location: extractLocation(loc) || clean(loc),
        country: countryOf(loc),
        contract: contractOf(p.employmentType) || clean(p.employmentType || ''),
        remote: p.isRemote ? 'Oui' : '',
        description: clean(p.descriptionPlain || '').slice(0, 4000),
        postedAtHint: p.publishedAt || '',
        _detail: { ats: 'ashby', slug, id: p.id },
      };
    });
  },

  async personio(src) {
    const sub = src.token || src.atsSlug || '';
    if (!sub) throw new Error('personio: token required');
    const r = await condFetch(`https://${encodeURIComponent(sub)}.jobs.personio.de/xml`, 'pe:' + sub);
    if (r.notModified) return [];
    const xml = r.text;
    const items = [];
    // Real Personio feed (verified): <workzag-jobs><position> with <id>, <name>
    // for the title, <office>/<additionalOffices> for the location,
    // <employmentType>/<schedule>, <department>, <createdAt>. There is no
    // description and no URL in the feed, so the detail page is only fetched
    // for offers that already matched the profile.
    const re = /<position>([\s\S]*?)<\/position>/g;
    let m;
    const pick = (b, tag) => {
      const t = b.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
      return t ? decodeEntities(t[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() : '';
    };
    while ((m = re.exec(xml)) !== null) {
      const b = m[1];
      const id = pick(b, 'id');
      const title = pick(b, 'name') || pick(b, 'title');
      if (!id || !title) continue;
      const extraOffices = [...b.matchAll(/<additionalOffices>([\s\S]*?)<\/additionalOffices>/g)]
        .flatMap((x) => [...x[1].matchAll(/<office>([\s\S]*?)<\/office>/g)].map((y) => decodeEntities(y[1]).trim()))
        .filter(Boolean);
      const loc = [pick(b, 'office'), ...extraOffices].filter(Boolean).join(', ');
      items.push({
        ref: id,
        title: clean(title),
        company: src.company || pick(b, 'subcompany') || sub,
        link: `https://${sub}.jobs.personio.de/job/${id}`,
        applyUrl: `https://${sub}.jobs.personio.de/job/${id}`,
        location: extractLocation(loc) || clean(loc),
        country: countryOf(loc),
        contract: contractOf(pick(b, 'employmentType'), pick(b, 'schedule')) || clean(pick(b, 'employmentType')),
        description: clean([pick(b, 'department'), pick(b, 'recruitingCategory'), pick(b, 'occupation')].filter(Boolean).join(' - ')),
        postedAtHint: pick(b, 'createdAt') || '',
        _detail: { ats: 'personio', sub, id },
      });
    }
    return items;
  },

  async recruitee(src) {
    const sub = src.token || src.atsSlug || '';
    if (!sub) throw new Error('recruitee: token required');
    const out = [];
    for (let offset = 0; offset < (src.limit || 200); offset += 100) {
      const j = await getJson(`https://${encodeURIComponent(sub)}.recruitee.com/api/offers/?limit=100&offset=${offset}`);
      const offers = Array.isArray(j.offers) ? j.offers : [];
      for (const p of offers) {
        const loc = [p.location && p.location.city, p.location && p.location.country].filter(Boolean).join(', ');
        out.push({
          ref: String(p.id),
          title: clean(p.title),
          company: src.company || sub,
          link: p.url || p.careers_url || '',
          applyUrl: p.apply_url || p.url || '',
          location: extractLocation(loc) || clean(loc),
          country: countryOf(loc),
          contract: contractOf(p.employment_type) || clean(p.employment_type || ''),
          description: stripHtml(p.description).slice(0, 4000),
          postedAtHint: p.created_at || '',
        });
      }
      if (!offers.length) break;
      await sleep(400);
    }
    return out;
  },

  async workable(src) {
    const sub = src.token || src.atsSlug || '';
    if (!sub) throw new Error('workable: token required');
    const j = await getJson(`https://apply.workable.com/api/v2/accounts/${encodeURIComponent(sub)}/jobs`);
    const list = Array.isArray(j.jobs) ? j.jobs : Array.isArray(j.results) ? j.results : [];
    return list.map((p) => {
      const loc = [p.city, p.state, p.country].filter(Boolean).join(', ');
      return {
        ref: String(p.id || p.shortcode || p.url),
        title: clean(p.title),
        company: src.company || sub,
        link: p.url || `https://apply.workable.com/${sub}/j/${p.id || p.shortcode}/`,
        applyUrl: p.application_url || p.url || '',
        location: extractLocation(loc) || clean(loc),
        country: countryOf(loc),
        contract: contractOf(p.employment_type),
        remote: p.remote ? 'Oui' : '',
        description: stripHtml(p.description).slice(0, 4000),
        postedAtHint: p.published_on || p.created_at || '',
      };
    });
  },
};

// Which slug-based ATS can be probed from a company name alone (no careers
// page needed). Used by ats-prober.js to auto-discover feeds.
const SLUG_PROBES = [
  { type: 'greenhouse', probe: (slug) => ({ url: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, pick: (j) => (Array.isArray(j.jobs) ? j.jobs.length : -1) }) },
  { type: 'lever', probe: (slug) => ({ url: `https://api.lever.co/v0/postings/${slug}?mode=json`, pick: (j) => (Array.isArray(j) ? j.length : -1) }) },
  { type: 'ashby', probe: (slug) => ({ url: `https://api.ashbyhq.com/posting-api/job-board/${slug}`, pick: (j) => (Array.isArray(j.jobs) ? j.jobs.length : -1) }) },
  { type: 'personio', probe: (slug) => ({ url: `https://${slug}.jobs.personio.de/xml`, pick: (t) => ((t.match(/<position>/g) || []).length) }) },
  { type: 'smartrecruiters', probe: (slug) => ({ url: `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`, pick: (j) => (Array.isArray(j.content) ? j.content.length : -1) }) },
  { type: 'recruitee', probe: (slug) => ({ url: `https://${slug}.recruitee.com/api/offers/?limit=1`, pick: (j) => (Array.isArray(j.offers) ? j.offers.length : -1) }) },
  { type: 'workable', probe: (slug) => ({ url: `https://apply.workable.com/api/v2/accounts/${slug}/jobs`, pick: (j) => (Array.isArray(j.jobs) ? j.jobs.length : (Array.isArray(j.results) ? j.results.length : -1)) }) },
];

// ATS fingerprints that can be recognised inside a company's careers page HTML,
// for the platforms whose feed URL cannot be guessed (Workday, SuccessFactors,
// Teamtailor, Onlyfy, Taleo, iCIMS, Jobvite, Phenom, Recruitee JS boards).
const HTML_FINGERPRINTS = [
  { type: 'workday', rx: /https?:\/\/([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com\/([a-z0-9_-]+)\/?/i, cfg: (m) => ({ tenant: m[1], site: m[2] }) },
  { type: 'successfactors', rx: /([a-z0-9-]+)\.sapsf\.com\/([^"'\s]+)/i, cfg: (m) => ({ token: m[1] }) },
  { type: 'taleo', rx: /([a-z0-9-]+)\.taleo\.net\//i, cfg: (m) => ({ token: m[1] }) },
  { type: 'teamtailor', rx: /([a-z0-9-]+)\.teamtailor\.com\/jobs/i, cfg: (m) => ({ token: m[1] }) },
  { type: 'onlyfy', rx: /([a-z0-9-]+)\.jobs\.onlyfy\.io/i, cfg: (m) => ({ token: m[1] }) },
  { type: 'icims', rx: /([a-z0-9-]+)\.icims\.com/i, cfg: (m) => ({ token: m[1] }) },
  { type: 'jobvite', rx: /([a-z0-9-]+)\.jobvite\.com/i, cfg: (m) => ({ token: m[1] }) },
  { type: 'greenhouse', rx: /boards\.greenhouse\.io\/([a-z0-9_-]+)/i, cfg: (m) => ({ token: m[1] }) },
  { type: 'lever', rx: /jobs\.lever\.co\/([a-z0-9_-]+)/i, cfg: (m) => ({ token: m[1] }) },
  { type: 'ashby', rx: /jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i, cfg: (m) => ({ token: m[1] }) },
  { type: 'workable', rx: /apply\.workable\.com\/([a-z0-9_-]+)\//i, cfg: (m) => ({ token: m[1] }) },
  { type: 'personio', rx: /([a-z0-9-]+)\.jobs\.personio\.(de|com)/i, cfg: (m) => ({ token: m[1] }) },
  { type: 'smartrecruiters', rx: /jobs\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/i, cfg: (m) => ({ token: m[1] }) },
  { type: 'eightfold', rx: /([a-z0-9-]+)\.eightfold\.ai/i, cfg: (m) => ({ token: m[1] }) },
  { type: 'recruitee', rx: /([a-z0-9-]+)\.recruitee\.com/i, cfg: (m) => ({ token: m[1] }) },
];

module.exports = {
  ATS, SLUG_PROBES, HTML_FINGERPRINTS, slugVariants,
  http, getJson, getText, condFetch, condJson, etagAll, etagLoad, etagGet, etagSet,
  clean, stripHtml, decodeEntities, extractLocation, countryOf, contractOf, sleep, stats,
};
