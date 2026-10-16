'use strict';
// A crawled job-board URL -> an addressable source.
//
// WHY THIS EXISTS
// Common Crawl hands us a URL and nothing else. This turns it into the addressing
// fields an adapter needs, which is the whole difficulty: a Workday board is only
// crawlable with tenant AND wd-number AND site, and the site is an arbitrary vendor
// label ('External_Career_Site', 'external_global'), so it cannot be derived from
// the company name. It has to be READ off the URL. Get it wrong and the source
// looks fine in the registry and throws on every poll forever.
//
// The ATS patterns are imported from probe-core rather than restated, on purpose.
// Two copies of "what a Workday URL looks like" would drift, and the drift would
// only show up as a board that verifies at discovery time and then fails silently
// in the fleet.

const core = require('./probe-core.js');

// Oracle Taleo. Two very different shapes in the wild:
//   careers.<company>.tal.net/talentsearch/...          (on-premise Taleo)
//   <tenant>.talent-<n>.<region>.oraclecloud.com/<site> (Oracle Cloud recruiting)
// The cloud form needs tenant+site; the tal.net form only the host.
const TALEO_TALNET_RX = /^https?:\/\/careers\.([a-z0-9][a-z0-9-]*)\.tal\.net\//i;
const TALEO_OC_RX = /^https?:\/\/([a-z0-9][a-z0-9-]*)\.talent-\d+\.[a-z0-9-]+\.oraclecloud\.com\/(?:[a-z]{2}(?:-[A-Za-z]{2,4})?\/)?([A-Za-z0-9][A-Za-z0-9_-]*)/i;

// SAP SuccessFactors. Recruiting Marketing (RMK) with a requisition id is a posting
// URL and is useless as a source; the site root is the board.
const SF_RMK_RX = /^https?:\/\/([a-z0-9][a-z0-9-]*)\.careers\.[a-z0-9-]+\.successfactors\.com\//i;
const SF_EU_RX = /^https?:\/\/(?:careers\.)?([a-z0-9][a-z0-9-]*)\.successfactors\.eu\//i;
const SF_GENERIC_RX = /^https?:\/\/([a-z0-9][a-z0-9-]*)\.(?:careers\.)?[a-z0-9-]*\.successfactors\.(?:com|eu|net|ca|com\.au)\//i;

// A path segment that is an id, not a board token.
const NUMERIC = /^\d+$/;

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch (_) { return ''; }
}
function segments(u) {
  try { return new URL(u).pathname.split('/').filter(Boolean); } catch (_) { return []; }
}
function stripLocale(seg) {
  // Both 'fr' and 'fr-fr' are used as path prefixes by various vendors.
  return /^[a-z]{2}(?:-[A-Za-z]{2,4})?$/i.test(seg) ? null : seg;
}

// Greenhouse. boards.greenhouse.io/<token> is the apex form and is by far the most
// common; some tenants get their own subdomain. The token is the FIRST segment
// either way.
//
// Numeric tokens are legitimate: real boards exist as '0x', '103644278' and
// '1945bce8d3924ece9421ba8630f57b0c', so no numeric filter is applied here. An
// earlier attempt to reject long numerics as job ids was wrong and would have
// dropped working boards.
function greenhouse(u) {
  if (!/(?:^|\.)boards\.greenhouse\.io$/.test(hostOf(u))) return null;
  const segs = segments(u);
  if (!segs.length) return null;
  const token = segs[0];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(token)) return null;
  return { type: 'greenhouse', token, boardUrl: 'https://boards.greenhouse.io/' + token };
}

function lever(u) {
  if (!/(?:^|\.)jobs\.lever\.co$/.test(hostOf(u)) && !/(?:^|\.)lever\.co$/.test(hostOf(u))) return null;
  const segs = segments(u);
  // Some tenants carry a locale prefix (/fr-fr/acme); the slug is the first
  // segment that is NOT a locale. stripLocale returns null for a locale, so the
  // predicate is truthiness of its result.
  const token = segs.find((s) => stripLocale(s)) || segs[0];
  if (!token || NUMERIC.test(token)) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(token)) return null;
  return { type: 'lever', token, boardUrl: 'https://jobs.lever.co/' + token };
}

function ashby(u) {
  if (!/(?:^|\.)jobs\.ashbyhq\.com$/.test(hostOf(u))) return null;
  const token = segments(u)[0];
  if (!token || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(token)) return null;
  return { type: 'ashby', token, boardUrl: 'https://jobs.ashbyhq.com/' + token };
}

function personio(u) {
  const m = /^([a-z0-9][a-z0-9-]*)\.jobs\.personio\.(?:de|com)$/i.exec(hostOf(u));
  if (!m) return null;
  return { type: 'personio', token: m[1], boardUrl: 'https://' + m[1] + '.jobs.personio.de' };
}

// Workable posting URLs are apply.workable.com/<account>/j/<jobId>/, where 'j' is
// a literal path segment, not a board. The account IS the board in the common case.
// Multi-board accounts look like apply.workable.com/<account>/<board>/, so a
// second segment is only treated as a board when it is not that literal 'j'.
// Reading the account as segment 2 instead yields a board called 'j'.
function workable(u) {
  if (!/^apply\.workable\.com$/.test(hostOf(u))) return null;
  const segs = segments(u);
  if (!segs.length) return null;
  const account = segs[0];
  let token = account;
  if (segs.length >= 2 && segs[1] && !/^j$/i.test(segs[1]) && stripLocale(segs[1])) {
    token = segs[1];
  }
  return {
    type: 'workable', token, account,
    boardUrl: 'https://apply.workable.com/' + account + '/',
  };
}

function recruitee(u) {
  const m = /^([a-z0-9][a-z0-9-]*)\.recruitee\.com$/.exec(hostOf(u));
  if (!m) return null;
  return { type: 'recruitee', token: m[1], boardUrl: 'https://' + m[1] + '.recruitee.com/' };
}

function smartrecruiters(u) {
  if (!/^jobs\.smartrecruiters\.com$/.test(hostOf(u))) return null;
  const segs = segments(u);
  const token = segs.find((s) => !/^(?:i|jobs?)$/i.test(s));
  if (!token || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(token)) return null;
  // The vendor's default container, which every customer shares. Treating it as a
  // board attributes one company's postings to another (the Assystem bug).
  if (/^(?:oneclick|default|generic|careers?|template|demo)(?:[-_.]?(?:ui|jobs?|careers?|portal))?$/i.test(token)) return null;
  return { type: 'smartrecruiters', token, companySlug: token, boardUrl: 'https://jobs.smartrecruiters.com/' + token };
}

function eightfold(u) {
  const m = /^([a-z0-9][a-z0-9-]*)\.(?:[a-z0-9-]+\.)?eightfold\.ai$/.exec(hostOf(u));
  if (!m) return null;
  return {
    type: 'eightfold', token: m[1], tenant: m[1],
    host: m[1] + '.eightfold.ai',
    boardUrl: 'https://' + m[1] + '.eightfold.ai/careers',
  };
}

// Workday. Reuses probe-core's own regex (and its fixed lookahead) so the two can
// never disagree about what the site segment is.
function workday(u) {
  core.WORKDAY_RX.lastIndex = 0;
  const m = core.WORKDAY_RX.exec(u);
  if (!m) return null;
  const tenant = String(m[1]).toLowerCase();
  const wd = m[2];
  const site = m[3];
  if (!tenant || !site) return null;
  return {
    type: 'workday', token: tenant, tenant, site, host: tenant + '.' + wd + '.myworkdayjobs.com',
    boardUrl: 'https://' + tenant + '.' + wd + '.myworkdayjobs.com/' + site,
  };
}

function taleo(u) {
  let m = TALEO_TALNET_RX.exec(u);
  if (m) {
    return {
      type: 'taleo', token: m[1], tenant: m[1],
      host: 'careers.' + m[1] + '.tal.net', site: '',
      boardUrl: 'https://careers.' + m[1] + '.tal.net/talentsearch',
    };
  }
  m = TALEO_OC_RX.exec(u);
  if (m) {
    const host = hostOf(u);
    return {
      type: 'taleo', token: String(m[1]).toLowerCase(), tenant: String(m[1]).toLowerCase(),
      host, site: m[2], boardUrl: 'https://' + host + '/' + m[2],
    };
  }
  return null;
}

// Each pattern is tried in turn rather than chained with ||. The chained version
// aborted on the FIRST regex that matched, and the broad generic pattern matches
// 'careers.acme.successfactors.eu' with companyId='careers' -- which then tripped
// the generic-name guard and returned null, so the specific EU pattern was never
// reached.
function successfactors(u) {
  const host = hostOf(u);
  for (const rx of [SF_RMK_RX, SF_EU_RX, SF_GENERIC_RX]) {
    const m = rx.exec(u);
    if (!m) continue;
    const companyId = String(m[1] || '').toLowerCase();
    // The company segment is a placeholder word rather than an employer.
    if (!companyId || /^(?:careers?|jobs?|successfactors|sf|career)$/i.test(companyId)) continue;
    return { type: 'successfactors', token: companyId, companyId, host, boardUrl: 'https://' + host + '/' };
  }
  return null;
}

const RESOLVERS = [workday, greenhouse, lever, ashby, personio, workable, recruitee, smartrecruiters, eightfold, taleo, successfactors];

// Returns the first match, or null. Order matters: workday is checked first because
// its host is unmistakable and its site segment is the one that must be read
// exactly; the rest are disjoint by hostname.
function fromUrl(u) {
  const s = String(u || '').trim();
  if (!/^https?:\/\//i.test(s)) return null;
  for (const fn of RESOLVERS) {
    let hit = null;
    try { hit = fn(s); } catch (_) { hit = null; }
    if (hit) return hit;
  }
  return null;
}

// A stable dedupe key. type:token is enough because a tenant/site pair is unique
// per vendor, and it is what the registry already uses -- so a board discovered
// twice, or discovered by both Common Crawl and a careers page, collapses instead of
// becoming two sources polling the same board.
function keyFor(hit) {
  if (!hit) return '';
  if (hit.type === 'workday') return 'workday:' + hit.tenant + '/' + hit.site;
  if (hit.type === 'taleo') return 'taleo:' + (hit.site ? hit.tenant + '/' + hit.site : hit.host);
  return hit.type + ':' + String(hit.token).toLowerCase();
}

module.exports = { fromUrl, keyFor, RESOLVERS, greenhouse, workday, lever, ashby, personio, workable, recruitee, smartrecruiters, eightfold, taleo, successfactors };