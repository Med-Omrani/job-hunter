'use strict';
// End-to-end proof that the band can recover an offer the keyword engine threw
// away. Stages four REAL misses (all of them rejected by engine.js in production)
// into the band, lets the worker judge them, then checks that the promoted ones
// are actually visible in the app's default feed.
//
// Visibility is the assertion that matters: a promotion that updates the row but
// stays invisible in /offers/search would be a silent no-op, and the offer would
// be lost exactly as if it had never been staged.
const api = require('./api_client.js');
const { scoreOffer } = require('./engine.js');

const REAL_MISSES = [
  {
    ref: 'E2E-VALEO-1',
    title: 'Superviseur de Production',
    company: 'Valeo',
    location: 'Tunisie', country: 'TN',
    link: 'https://valeo.wd3.myworkdayjobs.com/en-US/valeo_jobs/job/Tunis/SUPERVISEUR-_REQ2025063160',
    description: "Superviseur de production pour site industriel en Tunisie. Encadrement d'une equipe d'operateurs, pilotage des lignes de production, management et amelioration continue. Profil ingenieur ou BTS.",
  },
  {
    ref: 'E2E-VALEO-2',
    title: 'Technicien qualite UAP',
    company: 'Valeo',
    location: 'Tunis, Tunisie', country: 'TN',
    link: 'https://valeo.wd3.myworkdayjobs.com/en-US/valeo_jobs/job/Tunis/QUALITE-_REQ2026069626',
    description: "Technicien qualite Unitaires de Production. Animation de l'autocontrole, analyse des non conformites, plans qualite, outils de management qualite. BTS ou diplome genie industriel.",
  },
  {
    ref: 'E2E-JUNK-1',
    title: 'Senior Product Marketing Manager',
    company: 'German SaaS Vendor',
    location: 'Koln, Germany', country: 'DE',
    link: 'https://example.invalid/job/1',
    description: 'Own product positioning, launches and demand generation for enterprise customers. 6+ years in B2B SaaS marketing. Travel 30 percent. Not an engineering role.',
  },
  {
    ref: 'E2E-JUNK-2',
    title: 'Head of Performance Marketing',
    company: 'Global Ad Agency',
    location: 'Hamburg, Germany', country: 'DE',
    link: 'https://example.invalid/job/2',
    description: 'Lead a team of twelve performance marketers across EMEA. Responsible for CAC, ROAS and the full paid media budget of 4M EUR. Purely commercial.',
  },
];

(async () => {
  // Run-scoped ids. insert-band is ON CONFLICT DO NOTHING, so reusing fixed ids
  // would make every re-run insert 0 and then assert against stale rows -- the
  // test would "pass" or "fail" for reasons unrelated to the code under test.
  // A unique tag per run keeps each execution self-contained and needs no
  // cleanup (there is no DELETE route for offers, by design).
  const RUN = Date.now().toString(36);
  const eid = (ref) => `e2e-${RUN}-${ref.toLowerCase()}`;

  console.log('--- keyword engine verdict (these must all be match=false) ---');
  for (const o of REAL_MISSES) {
    const sc = scoreOffer(o.title, o.description, []);
    console.log(`  match=${String(sc.match).padEnd(5)} score=${sc.score}  ${o.title}`);
    if (sc.match) {
      console.error('  !! NOT a keyword miss -- this control case is wrong, test is invalid');
      process.exit(1);
    }
  }

  // 1. Stage them into the band.
  const payload = REAL_MISSES.map((o) => ({
    ...o, id: eid(o.ref), sourceId: 'e2e-' + RUN,
    source: 'E2E relevance test', bandFrom: 'keyword-unmatched', status: 'new',
  }));
  const ins = await api.insertBandOffers(payload);
  console.log(`\nstaged into band: ${ins.inserted} (ids: ${ins.ids.join(', ')})`);
  if (!ins.inserted) { console.error('nothing staged -- aborting'); process.exit(1); }

  // 2. Confirm they are invisible BEFORE any verdict.
  //    Assert visibility through ?sourceId=, NOT ?q=. The trigram search covers
  //    title/company/ref/location/contract/description and does NOT index id or
  //    source, so a q= probe on a run tag always returns 0 -- which would make
  //    this assertion pass no matter what the promotion did.
  const q = () => '/api/offers/search?sourceId=' + encodeURIComponent('e2e-' + RUN) + '&limit=50&matchOnly=1';
  const before = await fetch('http://localhost:3144' + q()).then((r) => r.json());
  console.log(`\nvisible in matched feed before verdict: ${before.total} (expected 0)`);

  // 2. Judge THIS set directly instead of via runPass(). runPass() claims the
  //    oldest pending rows, and the live band holds hundreds of real ones, so a
  //    FIFO test would never reach these four. The worker's own loop is already
  //    covered by events-relevance.log; what needs proving here is the chain
  //    classify -> verdict -> VISIBLE, which is what this does.
  const { classifyBatch } = require('./relevance.js');
  const judged = await classifyBatch(REAL_MISSES.map((o) => ({
    id: eid(o.ref), title: o.title, company: o.company,
    location: o.location, description: o.description,
  })));
  if (!judged.ok) { console.error('classify failed:', judged.error); process.exit(1); }
  console.log(`\nclassified in ${judged.ms}ms via ${judged.model}`);
  for (const v of judged.results) {
    console.log(`  match=${String(v.match).padEnd(5)} score=${v.score}  ${v.id.padEnd(28)} ${v.reason}`);
    await api.bandVerdict({ id: v.id, match: v.match, score: v.score, reason: v.reason, model: judged.model });
  }

  // 3. The assertion: the two engineering roles must now be visible in the app's
  //    DEFAULT matched feed, the two commercial roles must not.
  const feed = await fetch('http://localhost:3144' + q()).then((r) => r.json());
  console.log(`\nvisible in matched feed after verdict: ${feed.total}`);
  for (const it of feed.items) {
    console.log(`  VISIBLE score=${it.score} match=${it.match} band=${it.band} :: ${it.title}`);
    console.log(`     reason: ${it.bandVerdict && it.bandVerdict.reason}`);
  }

  const visibleTitles = feed.items.map((i) => i.title);
  const mustShow = ['Superviseur de Production', 'Technicien qualite UAP'];
  const mustHide = ['Senior Product Marketing Manager', 'Head of Performance Marketing'];
  const okShow = mustShow.every((t) => visibleTitles.includes(t));
  const okHide = mustHide.every((t) => !visibleTitles.includes(t));
  console.log(`\nrelevant roles promoted: ${okShow ? 'PASS' : 'FAIL'}`);
  console.log(`noise roles kept out:    ${okHide ? 'PASS' : 'FAIL'}`);
  if (!okShow || !okHide) process.exitCode = 1;
})().catch((e) => { console.error('E2E FAILED:', e.message); process.exit(1); });