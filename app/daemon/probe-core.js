'use strict';
// Probing core: turn "a company" or "a URL" into a verified, crawlable board.
//
// WHY THIS FILE EXISTS
// probe-registry.js grew out of a one-off CLI run. It read process.argv[2] at
// module scope and exported nothing, so it could only be used by typing a command.
// Self-expanding discovery needs to call the same verification gate in-process,
// thousands of times, with per-call options -- so the logic moved here and the CLI
// became a thin wrapper (probe-registry.js).
//
// Everything that decides whether a board is trustworthy lives here and nowhere
// else, which is the point: a discovery loop that could reach a *different*
// verification path than the one-off script would be a loop that fills the
// registry with boards nobody ever confirmed.
//
// The gate, unchanged and deliberately not "improved": crawl the board, crawl it
// AGAIN, and only accept it if the first crawl returned postings. The second crawl
// also tells us whether the platform honours ETags (cheap304), which is what sets
// the poll interval -- an ETag-capable board can be polled every 3 minutes for the
// price of a 304, a full-body board cannot.
//
// Polfteness is not optional here. An early run fired 10 concurrent requests at
// *.jobs.personio.de and got the whole host 429-banned for the rest of the pass.
// Failing 190 of 230 candidates was a fact about the prober, not the candidates.

const a = require('./adapters.js');
const LEGACY = require('./legacy-adapters.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 JobCenter/2.0';

// Verification MUST use the same adapter map the fleet crawls with
// (LEGACY.ADAPTERS u adapters.ATS -- the expression from hunter-fleet.js:76).
// It used to call a.ATS alone, which only implements greenhouse/lever/ashby/
// personio/recruitee/workable: a smartrecruiters or eightfold board was found,
// a.ATS[type] was undefined, the TypeError was swallowed by the catch, and the
// company was filed as 'ats-found-but-empty' even though the fleet could crawl it.
const CRAWL = { ...LEGACY.ADAPTERS, ...a.ATS };

function envNum(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
function envBool(name, dflt) {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  return v !== '0' && String(v).toLowerCase() !== 'false';
}

// Per-call options win over env, so the discovery agent can run a tight,
// cheap verification pass without mutating global env for everyone else.
function options(over = {}) {
  return {
    maxTries: envNum('PROBE_MAX_TRIES', 26) || over.maxTries,
    timeoutMs: over.timeoutMs || envNum('PROBE_TIMEOUT_MS', 12000),
    hostGapMs: over.hostGapMs !== undefined ? over.hostGapMs : envNum('PROBE_HOST_GAP_MS', 1200),
    depth: over.depth !== undefined ? over.depth : 2,
    verify: over.verify !== undefined ? over.verify : envBool('PROBE_VERIFY', true),
    robots: over.robots !== undefined ? over.robots : envBool('PROBE_ROBOTS', true),
    browser: over.browser !== undefined ? over.browser : envBool('PROBE_BROWSER', true),
    noGuess: over.noGuess !== undefined ? over.noGuess : envBool('PROBE_NO_GUESS', false),
  };
}

// ---------------------------------------------------------------- host pacing

const hostNext = new Map();

function resetPacing() { hostNext.clear(); robotsCache.clear(); }

async function slot(url, hostGapMs) {
  let host;
  try { host = new URL(url).hostname; } catch (_) { return; }
  const now = Date.now();
  const at = hostNext.get(host) || 0;
  if (at > now) await new Promise((r) => setTimeout(r, Math.min(at - now, 15000)));
  hostNext.set(host, Date.now() + (hostGapMs !== undefined ? hostGapMs : envNum('PROBE_HOST_GAP_MS', 1200)));
}

// ------------------------------------------------------------------- robots

// There was no robots.txt handling anywhere in this codebase before this file.
// A prober that walks into hundreds of unfamiliar hosts has to ask first: the ATS
// platforms used here are meant to be read, but the crawl rules are set by the
// site and we honour them rather than assuming. Checked once per host per process.
const robotsCache = new Map(); // host -> { disallow:Set, allow:Set } | null

function parseRobots(txt) {
  const disallow = new Set();
  const allow = new Set();
  const lines = String(txt || '').split(/\r?\n/);
  let applies = false; // false = we are before any User-agent group
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      // A new group only applies to us if we are the named agent; we are the only
      // agent that matters here, so the first group ends any wildcard group.
      applies = val === '*' || /jobcenter/i.test(val);
      continue;
    }
    if (!applies) continue;
    if (key === 'disallow' && val) disallow.add(val);
    if (key === 'allow' && val) allow.add(val);
  }
  return { disallow, allow };
}

async function robotsFor(url, o) {
  let host;
  try { host = new URL(url).hostname; } catch (_) { return null; }
  if (robotsCache.has(host)) return robotsCache.get(host);
  let res = null;
  try {
    await slot(url, o.hostGapMs);
    const r = await a.http(new URL('/robots.txt', url).toString(), { timeout: Math.min(o.timeoutMs, 10000) });
    if (r.ok) res = parseRobots(await r.text());
  } catch (_) { res = null; }
  robotsCache.set(host, res);
  return res;
}

// Longest-match wins, per the de-facto standard, with Allow beating Disallow at
// equal length. An empty robots.txt (or a host we could not fetch) allows.
async function robotsAllows(url, o) {
  if (!o.robots) return true;
  const rules = await robotsFor(url, o);
  if (!rules) return true;
  let path;
  try { path = new URL(url).pathname + new URL(url).search; } catch (_) { return true; }
  let bestD = -1, bestA = -1;
  for (const d of rules.disallow) if (path.startsWith(d) && d.length > bestD) bestD = d.length;
  for (const al of rules.allow) if (path.startsWith(al) && al.length > bestA) bestA = al.length;
  if (bestA >= 0 && bestA >= bestD) return true;
  return bestD < 0;
}

// --------------------------------------------------------------- fetch layer

// Cloudflare's interstitial. Detected by status PLUS the vendor header, because a
// bare 403 is also what a genuinely missing board returns -- and those must NOT be
// retried in a browser, or "this company has no board" turns into a 25-second
// browser launch per candidate.
function looksLikeBotWall(status, headers) {
  if (status !== 403 && status !== 503 && status !== 429) return false;
  let server = '';
  try { server = String(headers && headers.get && headers.get('server') || '').toLowerCase(); } catch (_) { server = ''; }
  if (!server) return false;
  return /cloudflare/.test(server);
}

// The escape hatch for a bot-walled host: load the page in the real browser
// already installed on this machine and read the DOM after the JS challenge runs.
// This is a normal page visit -- the same request a human makes -- not an attempt
// to defeat anything. If a board hard-blocks even that we record it and move on.
let browserMod = null;
function loadBrowser() {
  if (browserMod !== null) return browserMod;
  try { browserMod = require('./probe-browser.js'); } catch (_) { browserMod = false; }
  return browserMod;
}

async function fetchDoc(url, o) {
  if (!(await robotsAllows(url, o))) return { ok: false, status: 0, body: '', via: 'robots', blocked: true };
  let html = '';
  let status = 0;
  let headers = null;
  try {
    await slot(url, o.hostGapMs);
    const r = await a.http(url, { timeout: o.timeoutMs });
    status = r.status;
    headers = r.headers;
    if (r.ok) html = Buffer.from(await r.arrayBuffer()).toString('utf8');
  } catch (e) {
    return { ok: false, status: 0, body: '', via: 'err', error: String((e && e.message) || e).slice(0, 120) };
  }
  if (o.browser && looksLikeBotWall(status, headers)) {
    const b = loadBrowser();
    if (b && typeof b.renderText === 'function') {
      try {
        const res = await b.renderText(url, o.timeoutMs);
        if (res && res.text && res.text.length > 400) {
          return { ok: true, status: res.status || 200, body: res.text, via: 'browser', rendered: true };
        }
        return { ok: false, status, body: '', via: 'browser-blocked', blocked: true };
      } catch (e) {
        return { ok: false, status, body: '', via: 'browser-err', error: String((e && e.message) || e).slice(0, 120) };
      }
    }
    // No browser available: report the wall so the caller records the reason
    // instead of silently treating the host as having no board.
    return { ok: false, status, body: '', via: 'botwall', blocked: true };
  }
  if (!html) return { ok: false, status, body: '', via: status ? 'http' + status : 'empty' };
  return { ok: true, status, body: html, via: 'fetch' };
}

// ------------------------------------------------------------ careers pages

// TN-only paths first: a multinational's Tunisia subsidiary usually hangs its
// openings off a locale path, so /tn/careers and friends are the ones that carry a
// Tunisian ATS link. The generic paths stay as a fallback for local firms.
const CAREERS_PATHS = [
  '/tn/careers', '/tn/job', '/tn/emploi', '/careers/tunisie', '/fr-tn/careers',
  '/fr-tn/carrieres', '/emploi-tunisie', '/tunisie/careers', '/tn/carrieres',
  '/careers', '/jobs', '/career', '/en/careers', '/nous-joindre', '/carrieres', '/offres-d-emploi',
];
const CAREER_HOSTS = ['careers.', 'jobs.', 'job.', 'recruit.', 'career.'];

// Career subdomains of a company's own domain: careers.acme.com, jobs.acme.com.
//
// The original version destructured the domain and dropped the FIRST label --
// ['sagemcom', 'com'] -> prefixed the remainder, so 'sagemcom.com' produced
// 'careers.com', 'jobs.com', 'recruit.com' and 'career.com'. Those are three real,
// unrelated, heavily-trafficked job boards, and the guess phase spent its entire
// request budget on them for every bare-domain candidate, which is most of them.
// It looked correct for 'www.acme.com' (dropping 'www' happens to be what we
// want), which is why it survived: the bug is invisible on exactly the input
// nobody tested.
//
// Correct construction is PREFIX + the registrable domain, minus a leading www.
function hostOfCareer(d) {
  let dom = String(d || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
  if (!dom || !dom.includes('.')) return [];
  // Drop an existing career prefix so 'careers.acme.com' does not turn into
  // 'jobs.careers.acme.com'.
  const stripped = dom.replace(new RegExp('^(?:[a-z]{2}\\.)?(?:' + CAREER_HOSTS.map((p) => p.replace(/\./g, '')).join('|') + ')\\.'), '');
  const base = stripped.includes('.') ? stripped : dom;
  const out = new Set();
  for (const p of CAREER_HOSTS) out.add(p + base);
  return [...out];
}

// Two-label public suffix approximation. Not a full PSL, but the hosts we care
// about (greenhouse.io, lever.co, taleo.net) are all plain, and being wrong here
// only makes us stay on the starting host.
function baseDomain(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const two = parts.slice(-2).join('.');
  if (/^(co|com|net|org|gov|edu|ac)\.[a-z]{2}$/.test(two)) return parts.slice(-3).join('.');
  return two;
}
function sameSite(h1, h2) {
  return !!h1 && !!h2 && baseDomain(h1) === baseDomain(h2);
}

// A WHOLE path segment naming a careers/jobs area. Deliberately anchored per
// segment: the earlier version matched anywhere in the URL, and `job-boards.` in
// the HOSTNAME of every Greenhouse board satisfied the "is this a careers link?"
// test -- which is precisely what let a venture firm's portfolio page hand us one
// of its portfolio companies' boards.
const CAREERS_SEGMENT = /^(?:careers?|jobs?|job-boards?|jobs-board|vacancies|emploi|emplois|offres?|stellenangebote?|stellen|vacantes|puestos?|vagas)$/i;

function pathLooksLikeCareers(url) {
  let pathname = '';
  try { pathname = new URL(url).pathname; } catch (_) { return false; }
  return pathname.split('/').some((seg) => seg && CAREERS_SEGMENT.test(seg));
}
const CAREERS_HREF = /career|job|emploi|recrut|vacanc|offre|stellen|puesto|vaga|carriere/i;

function extractCareerLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  let baseHost = '';
  try { baseHost = new URL(baseUrl).hostname; } catch (_) { return out; }
  const re = /href\s*=\s*["']([^"'#?][^"']*)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let u;
    try { u = new URL(m[1], baseUrl); } catch (_) { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    if (!sameSite(u.hostname, baseHost)) continue;
    const path = (u.pathname + u.search).replace(/\/$/, '');
    // A careers HOSTNAME alone is not enough to follow every link on it: on
    // careers.com that meant fetching stylesheets, /login and favicons. Only
    // follow a shallow, listing-looking path there; anywhere else, require the
    // link itself to look like careers.
    const isCareerHost = /^(?:[a-z]{2}\.)?(?:www\.)?(?:careers?|jobs?|recruit)\./i.test(u.hostname);
    const shallow = path === '' || path.split('/').filter(Boolean).length <= 1;
    if (!CAREERS_HREF.test(path) && !(isCareerHost && shallow)) continue;
    if (/\.(?:css|m?js|jpe?g|png|gif|svg|ico|webp|woff2?|ttf|eot|pdf|zip|gz|xml|json)$/i.test(path)) continue;
    if (/\/(?:login|signin|register|password|user|account|search)(?:[/?]|$)/i.test(path)) continue;
    const key = u.hostname + path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u.origin + path);
    if (out.length >= 60) break;
  }
  return out;
}

// A multinational serves the locale of whoever is asking: accenture.com handed this
// machine /de-de/careers from a Tunisian request, and a prober that trusts the
// homepage lands on German content and reports "no board" -- a false negative that
// is indistinguishable from a real one. So the locale prefix is stripped and every
// plausible one re-tried, the profile's own country first.
function localeVariants(pathname, prefer) {
  const out = [];
  const add = (p) => { if (p && p !== '/' && !out.includes(p)) out.push(p); };
  add(pathname);
  const stripped = pathname.replace(/^\/[a-z]{2}(?:[-_][A-Za-z]{2,4})?(?=\/)/i, '');
  if (stripped && stripped !== pathname) {
    add(stripped);
    const locales = [prefer, 'fr-fr', 'fr', 'en', 'en-gb'].filter(Boolean).map(String);
    for (const l of locales) add('/' + l.toLowerCase() + stripped);
  }
  return out.slice(0, 8);
}

// ---------------------------------------------------------- ATS fingerprints

// A board link only counts if it sits on a careers path. Without this, a venture
// firm's portfolio page yields its portfolio company's board (a16z -> Anduril,
// 2372 jobs credited to the wrong company) and an NGO's "local entities" page
// yields a foreign subsidiary's board. Wrong company attribution is worse than a
// missing company: the CV generator would address the wrong employer.
const ATS_URL_RX = [
  { type: 'greenhouse', rx: /https?:\/\/[a-z0-9.-]*(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9_-]+)/gi, ix: [1], host: /greenhouse\.io$/i },
  { type: 'lever', rx: /https?:\/\/[a-z0-9.-]*\.?jobs\.lever\.co\/([a-z0-9_-]+)/gi, ix: [1], host: /lever\.co$/i },
  { type: 'ashby', rx: /https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9_-]+)/gi, ix: [1], host: /ashbyhq\.com$/i },
  { type: 'personio', rx: /https?:\/\/([a-z0-9_-]+)\.jobs\.personio\.de/gi, ix: [1], host: /personio\.de$/i },
  { type: 'workable', rx: /https?:\/\/apply\.workable\.com\/[a-z0-9_-]+\/([a-z0-9_-]+)/gi, ix: [1], host: /workable\.com$/i },
  { type: 'recruitee', rx: /https?:\/\/([a-z0-9_-]+)\.recruitee\.com/gi, ix: [1], host: /recruitee\.com$/i },
  { type: 'smartrecruiters', rx: /https?:\/\/jobs\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/gi, ix: [1], host: /smartrecruiters\.com$/i },
  { type: 'eightfold', rx: /https?:\/\/([a-z0-9_-]+)\.eightfold\.ai\/careers/gi, ix: [1], host: /eightfold\.ai$/i },
];

// Workday needs its own extractor. Every other ATS is one hostname + one slug;
// Workday is {tenant}.wd{1..9}.myworkdayjobs.com/{locale}/{site}, so the board is
// only addressable with BOTH the wd-number and the site segment. `valeo` vs
// `valeo_jobs` and `Careers` are all real, so guessing one from the other
// produces a 404 -- which is why Workday used to be invisible.
// The site segment must end at a non-word character or end of string. The
// previous lookahead `(?=[/"'?#]|$)` did not allow whitespace, so on a board
// followed by prose -- "...myworkdayjobs.com/en-US/External_Career_Site Airbus
// jobs" -- the regex backtracked past the locale group and captured `en-US` as
// the site, producing a board addressed as /en-US that can only ever 404.
const WORKDAY_RX = /https?:\/\/([a-z0-9][a-z0-9-]*)\.(wd[1-9])\.myworkdayjobs\.com\/(?:[a-z]{2}(?:[-_][A-Za-z]{2,4})?\/)?([A-Za-z0-9][A-Za-z0-9_-]*)(?=[^A-Za-z0-9_-]|$)/gi;

// Vendor fallback slugs. A careers page that links a job board by its generic
// shell rather than a company org hands us a board that belongs to nobody:
// Assystem's careers page linked jobs.smartrecruiters.com/oneclick-ui, SmartRecruiters'
// default container, which would have been crawled and attributed to Assystem.
const GENERIC_SLUG = /^(?:oneclick(?:-ui|-jobs)?|default|generic|template|demo|sample|test|recruit(?:er|ment)?|hiring|careers?|jobs?|mycareers?|career(?:site|portal)?|talent|apply|backoffice)$/i;

// A vendor token is a path/slug segment, not a sentence. Kept deliberately narrow:
// a loose /[\w-]+/ here is what lets prose ("taleoutput", "oneclick-ui") masquerade
// as a board token, and a phantom board that later "verifies" empty costs a real
// verification request and a confusing registry entry.
const TOKEN_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;

// Score on the SITE, not the tenant. A Workday tenant is an arbitrary routing code
// with no relation to the employer -- Airbus is tenant 'ag' at site
// 'External_Career_Site', and requiring the tenant to look like the company name
// rejected Airbus outright.
//
// The site name is a strong RANKING signal but cannot be a filter: vendors ship
// generic labels ('External', 'External_Career_Site', 'Careers', 'Jobs') that carry
// no employer name at all, and those are exactly the boards a small Tunisian
// employer runs. So a hit is accepted when the HTML came from the employer's OWN
// careers page (`trusted`) -- the page is on the employer's domain, so a board it
// links belongs to that employer -- and scored only to order several boards on one
// page. Untrusted text (a search result, a directory listing) keeps the strict
// score>=0 rule and gets flagged low-confidence so the caller can drop it.
//
// The accepted risk, stated plainly: a16z.com/careers links Anduril's board, and
// `trusted` accepts it. Rejecting every low-score hit instead would lose the real
// 'External_Career_Site' boards that make up most of a TN registry, and losing a
// real employer is worse than one venture board being polled for nothing.
function findWorkdayIn(text, company, opt) {
  const trusted = !!(opt && opt.trusted);
  const allowed = new Set(a.slugVariants(company).map((v) => v.toLowerCase()));
  WORKDAY_RX.lastIndex = 0;
  let m;
  const hits = [];
  while ((m = WORKDAY_RX.exec(text)) !== null) {
    const tenant = String(m[1] || '').toLowerCase();
    const site = String(m[3] || '');
    if (!tenant || !site) continue;
    const siteKey = site.toLowerCase().replace(/[^a-z0-9]+/g, '');
    let score = 0;
    if (allowed.has(tenant)) score += 4;
    for (const v of allowed) {
      const vk = v.replace(/[^a-z0-9]+/g, '');
      if (!vk) continue;
      if (siteKey === vk) { score += 8; break; }
      if (siteKey.startsWith(vk)) { score += 5; break; }
      if (siteKey.includes(vk)) { score += 3; break; }
    }
    // A generic site name ('External', 'Careers', 'Jobs') contributes NOTHING to
    // the score on purpose. Giving it +1 was enough to let an untrusted page -- a
    // directory listing, a search result -- smuggle in a board with no employer
    // signal at all, which is the case the trust flag exists to control. Trusted
    // pages still accept it via the `score === 0 && !trusted` check below.
    if (score === 0 && !trusted) continue;
    hits.push({
      type: 'workday', token: tenant, tenant, site, score,
      confidence: score >= 5 ? 'high' : (score > 0 || trusted ? 'medium' : 'low'),
      host: tenant + '.' + m[2] + '.myworkdayjobs.com',
      boardUrl: 'https://' + tenant + '.' + m[2] + '.myworkdayjobs.com/' + site,
    });
  }
  hits.sort((x, y) => y.score - x.score);
  const seenBoard = new Set();
  const uniq = [];
  for (const h of hits) {
    const k = h.tenant + '\u0000' + h.site;
    if (seenBoard.has(k)) continue;
    seenBoard.add(k);
    uniq.push(h);
  }
  return uniq.slice(0, 3);
}

function findAtsIn(text, company, opt) {
  const trusted = !!(opt && opt.trusted);
  const hits = findWorkdayIn(text, company, { trusted });
  const allowed = new Set(a.slugVariants(company).map((v) => v.toLowerCase()));
  for (const spec of ATS_URL_RX) {
    spec.rx.lastIndex = 0;
    let m;
    while ((m = spec.rx.exec(text)) !== null) {
      // Host check. The regex already names the vendor host, but this makes the
      // guarantee explicit and testable rather than a property of one regex.
      let h = '';
      try { h = new URL(m[0]).hostname; } catch (_) { continue; }
      if (spec.host && !spec.host.test(h)) continue;
      const token = m[spec.ix[0]];
      if (!token || !TOKEN_SHAPE.test(token)) continue;
      if (/^(embed|api|www)$/i.test(token)) continue;
      if (GENERIC_SLUG.test(token)) continue;
      const onCareersPath = pathLooksLikeCareers(m[0]);
      const tokenLooksRight = allowed.has(String(token).toLowerCase());
      // A board link counts when it sits on a careers path, or when the page we
      // read is the employer's own careers page (trusted), or when the token is
      // the company itself. Anything else is a link to someone else's board -- the
      // a16z page that links Anduril's, a consultancy that links its client's.
      if (!onCareersPath && !trusted && !tokenLooksRight) continue;
      hits.push({
        type: spec.type, token, boardUrl: m[0].split('?')[0],
        score: onCareersPath ? 3 : (tokenLooksRight ? 4 : 0),
        confidence: (onCareersPath || tokenLooksRight) ? 'high' : 'low',
      });
      break;
    }
  }
  return hits;
}

// ------------------------------------------------------------ fingerprinting

// Old behaviour, kept as the fallback: guess paths. It is a shotgun -- 5 host
// variants x 17 paths is up to 85 requests for ONE company, which is why a
// 61-company pass once stalled for 27 minutes. Reading links off the homepage is
// now tried first and this is only reached when that finds nothing.
async function fingerprintGuess(c, o) {
  const hosts = [String(c.domain || ''), ...hostOfCareer(c.domain)].filter(Boolean);
  const tried = [];
  let budget = o.maxTries;
  for (const host of hosts) {
    for (const p of ['', ...CAREERS_PATHS]) {
      if (budget-- <= 0) return { hits: [], via: tried[0] || '' };
      const url = `https://${host}${p}`;
      const doc = await fetchDoc(url, o);
      if (!doc.ok) continue;
      tried.push(url);
      if (doc.body.length < 400) continue;
      const hits = findAtsIn(doc.body, c.company, { trusted: true });
      if (hits.length) return { hits, via: doc.via === 'browser' ? url + ' (browser)' : url };
    }
  }
  return { hits: [], via: tried[0] || '' };
}

// Read-first. One request to the site, then follow the careers links it actually
// publishes, trying every locale variant of each. Valeo's Workday board comes out
// of this in a single request, where the path guesser could never have derived
// 'wd3' + 'valeo_jobs'.
async function fingerprintRead(c, o) {
  const roots = [c.domain ? 'https://' + String(c.domain).replace(/^https?:\/\//, '') : ''].filter(Boolean);
  for (const h of hostOfCareer(c.domain)) roots.push('https://' + h);
  const seen = new Set();
  let budget = Math.min(o.maxTries, 14);
  const tried = [];

  for (const root of roots) {
    const doc = await fetchDoc(root + '/', o);
    if (doc.ok && doc.body.length > 200) {
      tried.push(root + '/');
      const direct = findAtsIn(doc.body, c.company, { trusted: true });
      if (direct.length) return { hits: direct, via: doc.via === 'browser' ? root + '/ (browser)' : root + '/' };
      const links = extractCareerLinks(doc.body, root + '/');
      for (const link of links) {
        for (const p of localeVariants(safePath(link), c.preferLocale)) {
          if (budget-- <= 0) break;
          const u = originOf(link) + p;
          if (seen.has(u)) continue;
          seen.add(u);
          const d = await fetchDoc(u, o);
          if (!d.ok || d.body.length < 400) continue;
          tried.push(u);
          const hits = findAtsIn(d.body, c.company, { trusted: true });
          if (hits.length) return { hits, via: d.via === 'browser' ? u + ' (browser)' : u };
        }
      }
    }
  }
  if (!tried.length) return { hits: [], via: '' };
  return { hits: [], via: tried[0] };
}

function safePath(u) { try { return new URL(u).pathname + new URL(u).search; } catch (_) { return '/'; } }
function originOf(u) { try { return new URL(u).origin; } catch (_) { return ''; } }

// Read first, guess only if reading found nothing. Reading costs a handful of
// requests on the company's own site; guessing costs up to o.maxTries per host, so
// it stays the fallback and not the default. Set PROBE_NO_GUESS=1 to disable it
// entirely (the discovery loop points straight at ATS boards and never needs it).
async function fingerprint(c, over) {
  const o = options(over);
  if (!c.domain) return { hits: [], via: '' };
  const read = await fingerprintRead(c, o);
  if (read.hits.length) return read;
  if (o.noGuess) return read;
  return fingerprintGuess(c, o);
}

// --------------------------------------------------------------- slug probing

async function slugProbe(c, over) {
  const o = options(over);
  const variants = a.slugVariants(c.company, c.domain);
  for (const vt of ['greenhouse', 'lever', 'ashby', 'personio', 'smartrecruiters']) {
    const pr = a.SLUG_PROBES.find((p) => p.type === vt);
    if (!pr) continue;
    for (const v of variants) {
      const u = pr.probe(v);
      if (!u || !u.url) continue;
      if (!(await robotsAllows(u.url, o))) continue;
      try {
        await slot(u.url, o.hostGapMs);
        const r = await a.http(u.url, { timeout: Math.max(o.timeoutMs, 25000) });
        if (!r.ok) continue;
        const n = u.pick(await r.json());
        if (typeof n === 'number' && n > 0) return [{ type: vt, token: v, boardUrl: u.url.split('?')[0] }];
      } catch (_) {}
    }
  }
  return [];
}

// ------------------------------------------------------------ source shaping

// Cadence is decided by what the platform supports, not by wishful thinking.
//   greenhouse/ashby/personio -> ETag 304, but every board of a given vendor is the
//     same host, so 60s across a few hundred boards is a few requests a second to
//     one vendor from one IP. 180s.
const INTERVAL = {
  greenhouse: 180000, ashby: 180000, personio: 180000,
  lever: 900000, workday: 900000, smartrecruiters: 900000, eightfold: 900000,
  recruitee: 900000, workable: 900000, capgemini: 900000,
  taleo: 900000, successfactors: 900000, breezy: 900000, onlyfy: 900000,
  rss: 900000, html: 900000, linkedin: 1800000, experteer: 1800000,
  remotive: 600000, remoteok: 600000, render: 1800000,
};

// One board discovery, three different source shapes. The ATS in adapters.js all
// read `token`, but the legacy adapters predate the registry and each grew its own
// field names (workday: tenant+site+host, smartrecruiters: companySlug,
// eightfold: host+domain). Emitting a source without them yields a board the
// prober verified and the fleet cannot actually crawl.
function normalizeSrc(c, h, id) {
  const src = {
    id, type: h.type, token: h.token,
    company: c.company, name: c.name || c.company,
    country: c.country || '', sector: c.sector || '',
    intervalMs: INTERVAL[h.type] || 900000, matchedOnly: true,
  };
  if (h.type === 'workday') {
    src.tenant = h.tenant || h.token;
    src.site = h.site;
    src.host = h.host;
    src.limit = 100;
    src.country = c.country || '';
  } else if (h.type === 'smartrecruiters') {
    src.companySlug = h.token;
  } else if (h.type === 'eightfold') {
    src.tenant = h.token;
    src.host = h.token + '.eightfold.ai';
    src.domain = c.domain || '';
    src.num = 200;
  } else if (h.type === 'taleo') {
    src.tenant = h.tenant || h.token;
    src.site = h.site;
    src.host = h.host;
  } else if (h.type === 'successfactors') {
    src.companyId = h.companyId || h.token;
  }
  return src;
}

// Every addressing field the rebuild path will need. seed-registry.js reconstructs
// a source from the registry, and token alone does not identify a Workday, Taleo,
// SmartRecruiters or Eightfold board -- without these the source verifies here and
// then throws on every poll forever.
function passthroughFields(h) {
  const p = {};
  if (h.type === 'workday') { p.tenant = h.tenant; p.site = h.site; p.host = h.host; }
  if (h.type === 'smartrecruiters') { p.companySlug = h.token; }
  if (h.type === 'eightfold') { p.tenant = h.token; p.host = h.token + '.eightfold.ai'; p.num = 200; }
  if (h.type === 'taleo') { p.tenant = h.tenant || h.token; p.site = h.site; p.host = h.host; }
  if (h.type === 'successfactors') { p.companyId = h.companyId || h.token; }
  return p;
}

// ------------------------------------------------------------------- verify

// The single gate. Crawl, crawl again, accept only real postings. `cheap304` is
// the second crawl coming back empty because the platform answered 304 -- that is
// what earns a board the short interval.
async function verifyHit(h, c, o, via, foundBy) {
  // Gate on the CRAWL map, not on SLUG_PROBES: SLUG_PROBES only lists what a blind
  // slug guess can reach, so requiring an entry there threw away every
  // fingerprint-only hit -- Workday above all.
  const crawl = CRAWL[h.type];
  if (typeof crawl !== 'function') return { ok: false, reason: 'no-adapter:' + h.type };
  const id = `${h.type}-${String(h.token || c.id || c.company || 'x').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
  const src = normalizeSrc(c, h, id);
  let items, again;
  try {
    items = await crawl(src);
  } catch (e) { return { ok: false, reason: h.type + ':threw:' + String((e && e.message) || e).slice(0, 60) }; }
  if (!items || !items.length) return { ok: false, reason: h.type + ':empty' };
  try { again = await crawl(src); } catch (_) { again = null; }
  return {
    ok: true,
    board: {
      ...c,
      id, type: h.type, token: h.token,
      company: h.token ? (c.company || h.token) : (c.company || h.type),
      items: items.length,
      cheap304: !!(again && again.length === 0),
      via, foundBy: foundBy || '',
      siteUrl: c.domain ? 'https://' + String(c.domain).replace(/^https?:\/\//, '') : '',
      boardUrl: h.boardUrl || '',
      ...passthroughFields(h),
    },
  };
}

// Full verification over ranked hits, best first, with a reason for every failure
// so "this company runs no board we can reach" and "a board exists but our
// adapter could not read it" never collapse into the same bucket.
async function verifyHits(hits, c, over, via, foundBy) {
  const o = options(over);
  const failed = [];
  for (const h of (hits || []).slice(0, 3)) {
    const r = await verifyHit(h, c, o, via, foundBy);
    if (r.ok) return { board: r.board, failed };
    failed.push(r.reason);
  }
  return { board: null, failed };
}

module.exports = {
  // constants
  CRAWL, UA, CAREERS_PATHS, CAREER_HOSTS, ATS_URL_RX, WORKDAY_RX, INTERVAL,
  // fetch + politeness
  options, slot, fetchDoc, robotsAllows, robotsFor, parseRobots, resetPacing,
  looksLikeBotWall, baseDomain, sameSite,
  // discovery
  hostOfCareer, extractCareerLinks, localeVariants,
  findAtsIn, findWorkdayIn, fingerprint, fingerprintGuess, fingerprintRead, slugProbe,
  // shaping + gate
  normalizeSrc, passthroughFields, verifyHit, verifyHits,
};