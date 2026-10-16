#!/usr/bin/env node
'use strict';
// Per-step trace for one candidate. Explains WHERE a probe stopped, which the
// batch runner cannot: "no-ats-found" for 58 of 61 candidates is useless on its own.
//
// Usage: node probe-trace.js <id> <company> <domain> [country]

const core = require('./probe-core.js');

const [id, company, domain, country] = process.argv.slice(2);
const c = { id, company, domain, country: country || 'TN', sector: '' };
const o = core.options({ noGuess: true, browser: false, hostGapMs: 800 });

(async () => {
  console.log('== robots ==');
  for (const p of ['/', '/careers', '/fr-fr/careers', '/en/careers']) {
    const u = 'https://' + domain + p;
    const ok = await core.robotsAllows(u, o);
    console.log('  ' + (ok ? 'allow' : 'BLOCK') + '  ' + u);
  }

  console.log('\n== root ==');
  const root = await core.fetchDoc('https://' + domain + '/', o);
  console.log('  status=' + root.status + ' via=' + root.via + ' bytes=' + root.body.length);

  console.log('\n== guess ==');
  for (const h of ['', ...core.hostOfCareer(domain)].filter(Boolean)) {
    const doc = await core.fetchDoc('https://' + h + '/', o);
    console.log('  ' + (doc.ok ? 'ok  ' : 'FAIL') + ' https://' + h + '/  status=' + doc.status + ' via=' + doc.via + ' bytes=' + doc.body.length);
    if (doc.ok && doc.body.length > 200) {
      const links = core.extractCareerLinks(doc.body, 'https://' + h + '/');
      console.log('       career links: ' + (links.length ? links.join('\n                     ') : '(none)'));
      const direct = core.findAtsIn(doc.body, company, { trusted: true });
      console.log('       direct ATS: ' + (direct.length ? JSON.stringify(direct.map((x) => x.type + ':' + x.token)) : '(none)'));
      if (direct.length) {
        const r = await core.verifyHits(direct, c, o, h, 'trace');
        console.log('       verify: ' + (r.board ? 'OK ' + r.board.items + ' jobs' : 'FAIL ' + r.failed.join(';')));
        if (r.board) { console.log('\nBOARD ' + JSON.stringify(r.board, null, 1)); return; }
      }
      for (const link of links.slice(0, 4)) {
        for (const pp of core.localeVariants(core.safePathPublic ? core.safePathPublic(link) : require('url').parse(link).pathname)) {
          const u2 = require('url').parse(link);
          u2.pathname = pp; u2.search = null;
          const doc2 = await core.fetchDoc(require('url').format(u2), o);
          console.log('       ' + (doc2.ok ? 'ok  ' : 'FAIL') + ' ' + require('url').format(u2) + '  status=' + doc2.status + ' bytes=' + doc2.body.length);
          if (doc2.ok) {
            const hits = core.findAtsIn(doc2.body, company, { trusted: true });
            if (hits.length) {
              console.log('            ATS: ' + JSON.stringify(hits.map((x) => x.type + ':' + x.token)));
              const r = await core.verifyHits(hits, c, o, 'trace', 'trace');
              console.log('            verify: ' + (r.board ? 'OK ' + r.board.items + ' jobs' : 'FAIL ' + r.failed.join(';')));
              if (r.board) { console.log('\nBOARD ' + JSON.stringify(r.board, null, 1)); return; }
            }
          }
        }
      }
    }
  }
  console.log('\nslugProbe:');
  const sh = await core.slugProbe(c, o);
  console.log('  ' + (sh.length ? JSON.stringify(sh.map((x) => x.type + ':' + x.token)) : '(none)'));
})().catch((e) => { console.error('FATAL', e); process.exit(1); });