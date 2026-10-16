// Diagnostic: what careers platform do the unprobed Tunisian employers actually
// use? Reuses the prober's own domain + path list, but greps the fetched HTML for
// a BROAD set of ATS hostnames, including the ones probe-registry.js does not know
// about yet (SuccessFactors, Taleo, Onlyfy, Breezy, Teamtailor, Jobaffiliate...).
const fs = require('fs');
const path = require('path');
const a = require('./adapters.js');

const REG = path.join(__dirname, 'registry');
const ATS_HINTS = [
  ['greenhouse', /greenhouse\.io/i], ['lever', /lever\.co/i], ['ashby', /ashbyhq\.com/i],
  ['personio', /personio\.(de|com)/i], ['workable', /workable\.com/i], ['recruitee', /recruitee\.com/i],
  ['smartrecruiters', /smartrecruiters\.com/i], ['eightfold', /eightfold\.ai/i],
  ['workday', /myworkdayjobs\.com/i], ['successfactors', /successfactors\.(eu|net|com)/i],
  ['taleo', /taleo\.(net|com)/i], ['onlyfy', /onlyfy\.(com|io)/i], ['lateral', /lateral\.(io|com)/i],
  ['breesy', /breyuh\.net/i], ['teamtailor', /teamtailor\.com/i], ['jobvite', /jobvite\.com/i],
  ['jobaffiliate', /jobaffiliate\.com/i], ['jobtarget', /jobtarget\.com/i], ['icims', /icims\.com/i],
  ['pinpo', /pinpo\.fr/i], ['jobteaser', /jobteaser\.com/i], ['welcometothejungle', /welcometothejungle\.com/i],
  ['smartrecruiters-alt', /jobs\.smartrecruiters\./i], ['cornerstone', /cornerstoneondemand\.com/i],
  ['bamboohr', /bamboohr\.com/i], ['workable-alt', /jobs\.workable\.com/i],
];

const PATHS = ['/tn/careers', '/fr-tn/carrieres', '/careers', '/carrieres', '/jobs', '/emploi', '/offres-d-emploi', '/nous-joindre'];

(async () => {
  const cands = JSON.parse(fs.readFileSync(path.join(REG, 'candidates-tn-deep.json'), 'utf8'));
  const want = process.argv.slice(2);
  const list = want.length
    ? cands.filter((c) => want.some((w) => String(c.company).toLowerCase().includes(w.toLowerCase())))
    : cands;
  for (const c of list) {
    if (!c.domain) { console.log(`${c.company}\t(no domain)`); continue; }
    let found = null;
    for (const p of PATHS) {
      const url = `https://${c.domain}${p}`;
      try {
        const r = await a.condFetch(url);
        const body = String((r && r.text) || '');
        const hit = ATS_HINTS.find(([, rx]) => rx.test(body));
        if (hit) { found = `${hit[0]} (via ${p})`; break; }
        if (!found && body.length > 500) found = `no ATS marker (via ${p}, ${body.length}b)`;
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 40);
        if (!found) found = `err ${msg}`;
      }
    }
    console.log(`${c.company}\t${c.domain}\t${found || 'nothing'}`);
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });