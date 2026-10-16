#!/usr/bin/env node
'use strict';
// Unit tests for probe-core's pure logic. No network, no crawling.
//
// These are the cases that actually broke in the field, each of which cost a
// wrong registry entry or a lost employer:
//   1. verification gated on SLUG_PROBES instead of the adapter map -> every
//      fingerprint-only board (Workday above all) was discarded as empty
//   2. accenture.com served /de-de/careers -> the locale trap
//   3. loose token matching -> "oneclick-ui" and prose filed as boards
//   4. Workday tenant scored against the company name -> Airbus (tenant "ag") lost
//   5. vendor default containers -> Assystem credited with SmartRecruiters' shell

const assert = require('assert');
const c = require('./probe-core.js');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// ---------------------------------------------------------------- 1. adapters
t('CRAWL covers every ATS_URL_RX type (the SLUG_PROBES bug)', () => {
  for (const spec of c.ATS_URL_RX) {
    assert.ok(typeof c.CRAWL[spec.type] === 'function', spec.type + ' has no adapter');
  }
});
t('CRAWL covers every type findAtsIn can emit', () => {
  // taleo/successfactors are deliberately absent: their adapters are T1.2 work.
  // If findAtsIn grows an emitter before that lands, this test is the thing that
  // says so -- an emitter with no adapter produces a board that verifies as
  // 'no-adapter' and is silently dropped.
  const emitted = new Set(c.ATS_URL_RX.map((s) => s.type).concat(['workday']));
  for (const ty of emitted) assert.ok(typeof c.CRAWL[ty] === 'function', ty + ' has no adapter');
  for (const ty of ['smartrecruiters', 'eightfold', 'capgemini']) {
    assert.ok(typeof c.CRAWL[ty] === 'function', ty + ' has no adapter');
  }
});
t('taleo/successfactors are still unimplemented (T1.2 backlog, asserted on purpose)', () => {
  assert.ok(!c.CRAWL.taleo && !c.CRAWL.successfactors, 'T1.2 landed: update this test and INTERVAL');
});
t('every ATS_URL_RX has a host anchor (no bare-hostname regexes)', () => {
  for (const spec of c.ATS_URL_RX) assert.ok(spec.host instanceof RegExp, spec.type + ' has no host guard');
});

// ------------------------------------------------------------------ 2. locale
t('localeVariants strips a locale prefix', () => {
  const v = c.localeVariants('/de-de/careers');
  assert.ok(v.includes('/careers'), 'did not strip /de-de: ' + JSON.stringify(v));
});
t('localeVariants keeps the bare path first and re-adds locales', () => {
  const v = c.localeVariants('/fr-fr/careers', 'fr-fr');
  assert.ok(v.includes('/careers') && v.includes('/fr-fr/careers'));
  assert.ok(v.includes('/en/careers'), 'missing re-added locale: ' + JSON.stringify(v));
});
t('localeVariants leaves a locale-less path alone', () => {
  assert.deepStrictEqual(c.localeVariants('/careers'), ['/careers']);
});

// -------------------------------------------------------------- 3. baseDomain
t('baseDomain collapses subdomains', () => {
  assert.strictEqual(c.baseDomain('job-boards.greenhouse.io'), 'greenhouse.io');
  assert.strictEqual(c.baseDomain('www.accenture.com'), 'accenture.com');
});
t('baseDomain keeps a two-part public suffix', () => {
  assert.strictEqual(c.baseDomain('jobs.example.co.uk'), 'example.co.uk');
});
t('sameSite is true across subdomains, false across companies', () => {
  assert.ok(c.sameSite('www.accenture.com', 'accenture.com'));
  assert.ok(!c.sameSite('accenture.com', 'anduril.com'));
});

// ------------------------------------------------------- 4. careers extraction
t('hostOfCareer prefixes the company domain, not the TLD (the careers.com bug)', () => {
  // Regression: the old version dropped the FIRST label, so a bare domain became
  // careers.com / jobs.com / recruit.com -- three unrelated job boards, probed
  // with every candidate's entire request budget.
  const v = c.hostOfCareer('sagemcom.com');
  assert.ok(v.includes('careers.sagemcom.com'), JSON.stringify(v));
  for (const bogus of ['careers.com', 'jobs.com', 'recruit.com', 'career.com']) {
    assert.ok(!v.includes(bogus), 'still generating ' + bogus);
  }
});
t('hostOfCareer strips www and a locale', () => {
  assert.deepStrictEqual(c.hostOfCareer('www.sagemcom.com'), c.hostOfCareer('sagemcom.com'));
  assert.ok(c.hostOfCareer('fr.careers.acme.com').includes('jobs.acme.com'));
});
t('hostOfCareer never stutters a prefix', () => {
  for (const h of c.hostOfCareer('careers.acme.com')) {
    assert.ok(!/careers\.careers\./.test(h), h);
    assert.ok(!/\.careers\.careers\./.test(h), h);
  }
});
t('hostOfCareer handles a URL and junk', () => {
  assert.ok(c.hostOfCareer('https://acme.com/careers').includes('jobs.acme.com'));
  assert.deepStrictEqual(c.hostOfCareer('localhost'), []);
  assert.deepStrictEqual(c.hostOfCareer(''), []);
});

t('extractCareerLinks follows careers links, stays on-site', () => {
  const html = '<a href="/fr-fr/careers">Carrières</a><a href="/en/careers">Careers</a>' +
    '<a href="https://evil.example/x">no</a><a href="/contact">Contact</a>';
  const links = c.extractCareerLinks(html, 'https://accenture.com/');
  assert.ok(links.some((l) => l.includes('/fr-fr/careers')));
  assert.ok(links.some((l) => l.includes('/en/careers')));
  assert.ok(!links.some((l) => l.includes('evil.example')), 'leaked off-site link');
  assert.ok(!links.some((l) => l.includes('/contact')), 'followed a non-careers link');
});
t('extractCareerLinks follows a careers.* subdomain host', () => {
  const links = c.extractCareerLinks('<a href="https://jobs.acme.com/open">Jobs</a>', 'https://acme.com/');
  assert.ok(links.length === 1, JSON.stringify(links));
});

// ------------------------------------------------------------- 5. bot wall
t('extractCareerLinks does not sweep assets and logins off a careers host', () => {
  // careers.com qualifies every link by hostname; without these guards the
  // prober fetched stylesheets and /login as if they were careers pages.
  const html = '<link href="/sites/default/css/app.css"><a href="/user/login">Login</a>' +
    '<a href="/logo.png"><a href="/jobs">Jobs</a><a href="/search">Search</a>';
  const links = c.extractCareerLinks(html, 'https://www.careers.com/');
  for (const l of links) {
    assert.ok(!/\.(css|png)(\?|$)/.test(l), 'followed asset ' + l);
    assert.ok(!/\/login/.test(l), 'followed login ' + l);
    assert.ok(!/\/search/.test(l), 'followed search ' + l);
  }
  assert.ok(links.some((l) => l.endsWith('/jobs')), 'dropped the real listing: ' + JSON.stringify(links));
});

t('looksLikeBotWall needs the Cloudflare header, not just a 403', () => {
  const cf = new Map([['server', 'cloudflare']]);
  const nginx = new Map([['server', 'nginx']]);
  assert.ok(c.looksLikeBotWall(403, cf));
  assert.ok(c.looksLikeBotWall(503, cf));
  assert.ok(c.looksLikeBotWall(429, cf));
  assert.ok(!c.looksLikeBotWall(403, nginx), 'a plain 403 must not launch a browser');
  assert.ok(!c.looksLikeBotWall(200, cf), 'a 200 is never a wall');
  assert.ok(!c.looksLikeBotWall(403, null), 'no headers -> no browser');
});

// ----------------------------------------------------------------- 6. robots
t('parseRobots reads the wildcard group', () => {
  const r = c.parseRobots('User-agent: *\nDisallow: /admin\nAllow: /admin/public\n');
  assert.deepStrictEqual([...r.disallow], ['/admin']);
  assert.deepStrictEqual([...r.allow], ['/admin/public']);
});
t('parseRobots ignores groups that are not ours', () => {
  const r = c.parseRobots('User-agent: EvilBot\nDisallow: /\n\nUser-agent: *\nDisallow: /x\n');
  assert.deepStrictEqual([...r.disallow], ['/x'], JSON.stringify([...r.disallow]));
});
t('parseRobots handles comments and blank lines', () => {
  const r = c.parseRobots('# hi\n\nUser-agent: *\nDisallow: /a # trailing\n');
  assert.deepStrictEqual([...r.disallow], ['/a']);
});

// ------------------------------------------------------------ 7. fingerprint
t('findAtsIn pulls a Workday board whose tenant is an arbitrary code', () => {
  // The page here is the employer's own careers page, hence trusted. The site name
  // 'External_Career_Site' contains no trace of "airbus" -- this is the case that
  // was previously rejected outright, which is how Airbus stayed invisible.
  const hits = c.findWorkdayIn(
    'see https://ag.wd3.myworkdayjobs.com/en-US/External_Career_Site Airbus jobs', 'Airbus', { trusted: true });
  assert.ok(hits.length, 'no workday hit');
  assert.strictEqual(hits[0].tenant, 'ag');
  assert.strictEqual(hits[0].site, 'External_Career_Site');
  assert.strictEqual(hits[0].host, 'ag.wd3.myworkdayjobs.com');
});
t('findAtsIn rejects the same board when the text is NOT the employer\'s page', () => {
  // Untrusted text (a directory listing, a search result) must still earn its score.
  const hits = c.findWorkdayIn('https://ag.wd3.myworkdayjobs.com/en/External_Career_Site', 'Airbus');
  assert.strictEqual(hits.length, 0, JSON.stringify(hits));
});
t('findAtsIn drops a Workday board that is not the company, even when trusted', () => {
  const hits = c.findWorkdayIn('https://zz.wd1.myworkdayjobs.com/en/SomeOtherCo', 'Airbus', { trusted: true });
  assert.strictEqual(hits.filter((h) => h.site === 'SomeOtherCo' && h.tenant === 'zz').length, 1,
    'a trusted page still links only boards it owns');
});
t('findAtsIn prefers the higher-scoring Workday site', () => {
  const html = 'https://ag.wd3.myworkdayjobs.com/en/Generic_Portal and https://ag.wd3.myworkdayjobs.com/en/airbus_jobs';
  const hits = c.findWorkdayIn(html, 'Airbus');
  assert.ok(hits[0].site.toLowerCase().indexOf('airbus') >= 0, 'ranked wrong: ' + hits[0].site);
});
t('findAtsIn reads a greenhouse board token', () => {
  const hits = c.findAtsIn('<a href="https://boards.greenhouse.io/acme">Apply</a>', 'Acme');
  assert.ok(hits.some((h) => h.type === 'greenhouse' && h.token === 'acme'), JSON.stringify(hits));
});
t('findAtsIn rejects a vendor default container (the Assystem bug)', () => {
  const hits = c.findAtsIn('https://jobs.smartrecruiters.com/oneclick-ui', 'Assystem');
  assert.strictEqual(hits.filter((h) => h.type === 'smartrecruiters').length, 0, JSON.stringify(hits));
});
t('findAtsIn rejects generic slugs', () => {
  const hits = c.findAtsIn('https://apply.workable.com/acme/default', 'Acme');
  assert.strictEqual(hits.filter((h) => h.token === 'default').length, 0);
});
t('findAtsIn ignores a board on a portfolio page (the a16z bug)', () => {
  // A16z's own board link, on a16z.com/careers, is Anduril's board.
  const html = '<a href="https://job-boards.greenhouse.io/anduril">Anduril</a>';
  const hits = c.findAtsIn(html, 'Andreessen Horowitz');
  assert.strictEqual(hits.filter((h) => h.token === 'anduril').length, 0, JSON.stringify(hits));
});
t('findAtsIn reads a career-portal URL found anywhere in the text', () => {
  const hits = c.findAtsIn('see https://jobs.lever.co/valeo for details', 'Valeo');
  assert.ok(hits.some((h) => h.type === 'lever' && h.token === 'valeo'), JSON.stringify(hits));
});

// ------------------------------------------------------------ 8. INTERVAL
t('INTERVAL gives every discovered type a cadence', () => {
  for (const ty of ['greenhouse', 'ashby', 'personio', 'lever', 'workday', 'taleo', 'successfactors']) {
    assert.ok(c.INTERVAL[ty] > 0, ty + ' has no interval');
  }
});
t('ETag-capable vendors poll faster than full-body vendors', () => {
  assert.ok(c.INTERVAL.greenhouse <= 180000);
  assert.ok(c.INTERVAL.lever >= 900000);
});

// -------------------------------------------------------- 9. source shaping
t('normalizeSrc carries every field a Workday board needs to be crawled', () => {
  const s = c.normalizeSrc(
    { company: 'Airbus', domain: 'airbus.com' },
    { type: 'workday', token: 'ag', tenant: 'ag', site: 'External', host: 'ag.wd3.myworkdayjobs.com' },
    'workday-ag');
  for (const k of ['tenant', 'site', 'host']) {
    assert.ok(s[k], 'normalizeSrc lost workday ' + k);
  }
  assert.ok(c.passthroughFields({ type: 'workday', token: 'ag', tenant: 'ag', site: 'E', host: 'h' }).site);
});
t('normalizeSrc sets companySlug for smartrecruiters', () => {
  const s = c.normalizeSrc({ company: 'Acme' }, { type: 'smartrecruiters', token: 'Acme' }, 'sr-acme');
  assert.strictEqual(s.companySlug, 'Acme');
  assert.strictEqual(s.token, 'Acme');
});
t('normalizeSrc caps an unknown type at a slow cadence', () => {
  const s = c.normalizeSrc({ company: 'Acme' }, { type: 'mysteryats', token: 'x' }, 'm-x');
  assert.strictEqual(s.intervalMs, 900000);
});
t('passthroughFields leaves a plain ATS empty', () => {
  assert.deepStrictEqual(c.passthroughFields({ type: 'lever', token: 'acme' }), {});
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);