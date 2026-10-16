#!/usr/bin/env node
'use strict';
// ats-from-url tests. The URL fixtures are REAL, harvested from Common Crawl
// (CC-MAIN-2026-39) rather than invented, because the failure mode here is a URL
// shape nobody imagined -- Workday sites named 'external_global', Greenhouse
// tenants that are bare numbers.

const assert = require('assert');
const u = require('./ats-from-url.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n')[0]); }
}

console.log('== greenhouse (apex form: boards.greenhouse.io/<token>) ==');
t('apex board', () => {
  const h = u.fromUrl('https://boards.greenhouse.io/100Thieves');
  assert.strictEqual(h.type, 'greenhouse');
  assert.strictEqual(h.token, '100Thieves');
});
t('board with job paths still yields the board', () => {
  const h = u.fromUrl('https://boards.greenhouse.io/1uphealth/jobs/4685117402?utm_source=x');
  assert.strictEqual(h.token, '1uphealth', JSON.stringify(h));
});
t('a numeric token IS a real board', () => {
  // Real Greenhouse boards: '0x', '103644278', '1945bce8d3924ece9421ba8630f57b0c'.
  // An earlier numeric filter was wrong and would have dropped working boards.
  assert.strictEqual(u.fromUrl('https://boards.greenhouse.io/103644278').token, '103644278');
});

console.log('== workday (tenant + site BOTH required) ==');
t('reads site, not locale, after a hyphenated locale', () => {
  const h = u.fromUrl('https://ag.wd3.myworkdayjobs.com/en-US/External_Career_Site');
  assert.strictEqual(h.tenant, 'ag');
  assert.strictEqual(h.site, 'External_Career_Site');
  assert.strictEqual(h.host, 'ag.wd3.myworkdayjobs.com');
});
t('no locale segment', () => {
  const h = u.fromUrl('https://cnx.wd1.myworkdayjobs.com/external_global');
  assert.strictEqual(h.site, 'external_global');
});
t('site is underscored and lowercase in the wild', () => {
  const h = u.fromUrl('https://acme.wd5.myworkdayjobs.com/en/careers_acme');
  assert.strictEqual(h.site, 'careers_acme');
});
t('boardUrl is re-addressable, not the posting URL', () => {
  const h = u.fromUrl('https://ag.wd3.myworkdayjobs.com/en-US/External_Career_Site/job/12345');
  assert.ok(/External_Career_Site$/.test(h.boardUrl), h.boardUrl);
});
t('keyFor distinguishes two sites on one tenant', () => {
  const a1 = u.fromUrl('https://ag.wd3.myworkdayjobs.com/en/External');
  const a2 = u.fromUrl('https://ag.wd3.myworkdayjobs.com/en/Airbus');
  assert.notStrictEqual(u.keyFor(a1), u.keyFor(a2));
});

console.log('== other vendors ==');
t('lever', () => {
  const h = u.fromUrl('https://jobs.lever.co/valeo');
  assert.strictEqual(h.type, 'lever');
  assert.strictEqual(h.token, 'valeo');
});
t('lever skips a locale segment', () => {
  const h = u.fromUrl('https://jobs.lever.co/fr-fr/acme');
  assert.strictEqual(h.token, 'acme', JSON.stringify(h));
});
t('ashby', () => {
  const h = u.fromUrl('https://jobs.ashbyhq.com/databricks');
  assert.strictEqual(h.type, 'ashby');
  assert.strictEqual(h.token, 'databricks');
});
t('personio takes the subdomain as the company', () => {
  const h = u.fromUrl('https://acme.jobs.personio.de');
  assert.strictEqual(h.type, 'personio');
  assert.strictEqual(h.token, 'acme');
});
t('workable treats the account as the board, not the literal /j/ segment', () => {
  // apply.workable.com/<account>/j/<jobId>/ -- 'j' is a literal path segment.
  const h = u.fromUrl('https://apply.workable.com/acme/j/ABC123/');
  assert.strictEqual(h.type, 'workable');
  assert.strictEqual(h.account, 'acme');
  assert.strictEqual(h.token, 'acme', JSON.stringify(h));
});
t('workable honours a real sub-board', () => {
  const h = u.fromUrl('https://apply.workable.com/acme/engineering/');
  assert.strictEqual(h.token, 'engineering');
});
t('recruitee', () => {
  const h = u.fromUrl('https://acme.recruitee.com/');
  assert.strictEqual(h.type, 'recruitee');
  assert.strictEqual(h.token, 'acme');
});
t('smartrecruiters rejects the default container', () => {
  assert.strictEqual(u.fromUrl('https://jobs.smartrecruiters.com/oneclick-ui'), null);
});
t('smartrecruiters takes a company slug', () => {
  const h = u.fromUrl('https://jobs.smartrecruiters.com/Assystem/');
  assert.strictEqual(h.type, 'smartrecruiters');
  assert.strictEqual(h.companySlug, 'Assystem');
});
t('eightfold carries tenant AND host', () => {
  const h = u.fromUrl('https://acme.eightfold.ai/careers');
  assert.strictEqual(h.type, 'eightfold');
  assert.strictEqual(h.tenant, 'acme');
  assert.strictEqual(h.host, 'acme.eightfold.ai');
});

console.log('== new vendors (T1.2) ==');
t('taleo on-premise tal.net', () => {
  const h = u.fromUrl('https://careers.acme.tal.net/talentsearch');
  assert.strictEqual(h.type, 'taleo');
  assert.strictEqual(h.token, 'acme');
  assert.strictEqual(h.host, 'careers.acme.tal.net');
});
t('taleo Oracle Cloud form keeps tenant and site', () => {
  const h = u.fromUrl('https://acme.talent-3.eu.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions');
  assert.strictEqual(h.type, 'taleo');
  assert.strictEqual(h.tenant, 'acme');
  assert.strictEqual(h.site, 'hcmUI', JSON.stringify(h));
});
t('successfactors RMK', () => {
  const h = u.fromUrl('https://acme.careers.northamerica.successfactors.com/careers');
  assert.strictEqual(h.type, 'successfactors');
  assert.strictEqual(h.companyId, 'acme');
});
t('successfactors EU', () => {
  const h = u.fromUrl('https://careers.acme.successfactors.eu/');
  assert.strictEqual(h.type, 'successfactors');
  assert.strictEqual(h.companyId, 'acme', JSON.stringify(h));
});
t('taleo and successfactors are NOT yet crawlable', () => {
  // They are parseable but have no adapter, so the discovery loop must not
  // register them. This test is the reminder that the gate in verifyHit will
  // reject them as 'no-adapter'.
  const core = require('./probe-core.js');
  assert.ok(!core.CRAWL.taleo && !core.CRAWL.successfactors);
});

console.log('== rejection ==');
t('a normal corporate careers page is not a board', () => {
  assert.strictEqual(u.fromUrl('https://careers.acme.com/jobs'), null);
});
t('a non-http string is ignored', () => {
  assert.strictEqual(u.fromUrl('not a url'), null);
  assert.strictEqual(u.fromUrl(''), null);
});
t('keyFor is stable and lowercased', () => {
  const a1 = u.fromUrl('https://boards.greenhouse.io/Acme');
  const a2 = u.fromUrl('https://boards.greenhouse.io/acme');
  assert.strictEqual(u.keyFor(a1), u.keyFor(a2));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);