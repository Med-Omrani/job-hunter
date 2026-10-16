// Builds the Tunisian employer dossier: docs/tn-companies.md + docs/tn-companies.csv
// and the candidate list the prober consumes.
//
// Every employer in the output is ATTESTED, not recalled. Names come from three
// places only:
//   1. offers in our own database whose country resolved to 'Tunisie', resolved
//      from the posting's own text (see countryOf in adapters.js);
//   2. offers published on the fleet's Tunisia-only boards (keejob, tunisiejob,
//      tanitjobs), which is a Tunisian presence by construction;
//   3. registry/candidates-tn.json, the hand-curated list, which carries domains.
// Nothing is typed in from memory: a plausible-sounding company that does not
// exist is worse than a missing row, because the CV generator would address it.
//
// All pattern matching runs on the accent-stripped form (see fold()), so every
// regex below is pure ASCII. An earlier revision carried accented character
// classes like /r[ée]/ directly, and a single lossy re-encode turned them into
// /r[<mojibake>e]/ -- which fails to match anything and silently disables the
// filter. ASCII patterns plus fold() cannot rot that way.
//
// Run:  node report-tn.js             -> report + registry/candidates-tn-deep.json
//       node report-tn.js --no-write  -> summary only

const fs = require('fs');
const path = require('path');

const API = process.env.API_URL || 'http://localhost:3144/api';
const ROOT = path.join(__dirname, '..', '..');
const DOCS = path.join(ROOT, 'docs');
const REG = path.join(__dirname, 'registry');

const SECTORS = ['embarque', 'automatisme', 'electro', 'web', 'mobile', 'reseau', 'services', 'industrie'];

// Employer names that are not employers. A Tunisian posting board carries a long
// tail of these, and a handful of them outrank every real company by volume:
// "Entreprise" alone accounted for 52 postings, ahead of Sagemcom's 23.
const JUNK = new RegExp('^(' + [
  'entreprises?', 'anonym[e]?', 'confidentiel', 'non\\s*precise', 'non\\s*r[ée]connu',
  'candidat', 'postulant', 'societe', 'sarl', 'sa', 'spa', 'sas', 'groupe', 'group',
  'holding', 'cabinet', 'startup', 'start-up',
  'test\\s*co', 'testco', 'test\\s*company', 'example', 'demo', 'sample', 'foo\\s*bar', 'asdf', 'aaa', 'xxx',
].join('|') + ')$', 'i');
// Anything that is markup, a URL, an email, or implausibly long. The keejob
// scraper occasionally puts a whole <img> logo tag in the company field, which
// outranked every real employer by posting volume before this filter existed.
const JUNK_SUB = /<[a-z/][\s\S]*>|https?:|@|\.com$|\bdot\b|tick8ing|linkedin|facebook|w3\.org/i;
const MAX_NAME = 80;

// Legal-form and geographic noise, stripped before matching so that
// "POULINA GROUP HOLDING" and "Poulina" resolve to the same employer.
const NOISE = /\b(sa|sarl|sau|spa|sas|sls|scs|societe|groupe|group|holding|holdings|tunisie|tunisia|tunis|tunisien|tunisienne|international|intl|global|nord|sud|est|ouest|national|private|offshore|consulting)\b/g;

// Strip accents, punctuation and casing. Used both for identity and for matching.
function fold(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
const clean = (s) => fold(s).replace(/[&/\\|+.]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// "Capgemini Capgemini Engineering" -> "capgemini engineering": boards repeat the
// employer name when it also appears in the posting title. Returns the key.
function keyOf(name) {
  const parts = clean(name).split(' ').filter(Boolean);
  const seen = new Set();
  const kept = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    kept.push(p);
  }
  return kept.join(' ').replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
}

// Same de-duplication on the raw string, preserving the source's own casing
// ("Sagemcom", "KROMBERG & SCHUBERT TUNISIE"), because the report shows this
// column and "Capgemini Capgemini Engineering" reads as a parsing bug.
function displayName(raw) {
  const words = String(raw).split(/\s+/);
  const seen = new Set();
  const kept = [];
  for (const w of words) {
    const f = clean(w);
    if (!f || seen.has(f)) continue;
    seen.add(f);
    kept.push(w);
  }
  return kept.join(' ');
}

// Sector rules, applied in order against the folded employer name and the folded
// titles of the postings attributed to it. Order matters: an electronics
// manufacturer also matches the web rule, and filing it under web is useless.
const RULES = [
  ['embarque', /\b(embarque|embarques|embedded|aeronautique|aerospace|avion|aircraft|spatial|satellite|radar|defense|missile|drone|automobile|vehicule|moteur|powertrain|cockpit|habillage|automotive|safran|zyxel|actia|elewia|airbus|thales|nxp|sagemcom|stmicro|semicond|microelectron)\w*/],
  ['automatisme', /\b(automatisme|automatise|automation|robot|robotique|robotics|controle[ -]?commande|plc|scada|ihm|regulation|instrumentation|siemens|schneider|omron|thermo[a-z]*|hmi|supervision|geometrie|graphisme|usinage|assemblage|montage)\w*/],
  ['electro', /\b(electro|electro[n]?|electronique|electrotechnique|power|solaire|solar|photovolt|olien|wind|batterie|battery|accumulator|bms|haute[ ]tension|basse[ ]tension|transformateur|onduleur|smig|legrand|cable|coaxial)\w*/],
  ['reseau', /\b(reseau|telecom|fibre|fiber|4g|5g|lte|datacom|network|networking|broadband|roaming|vpn|iptv|transmission|wifi|infinio|hexagon|cometel|icet|ooredoo)\w*/],
  ['mobile', /\b(mobile|android|ios|iphone|swift|kotlin|flutter|react[ ]native|hybride|apk)\w*/],
  ['web', /\b(web|php|wordpress|magento|prestashop|laravel|symfony|dotnet|net|asp|angular|react|vue|node|js|full[ ]?stack|backend|front[ -]?end|devops|hosting|cloud|datacenter|data[ ]center|digital|numerique|webagency|agence[ ]web|logiciel|software|editeur|saas|erp|crm|java|spring|python|javascript)\b/],
  ['industrie', /\b(industrie|industriel|industrial|usine|manufactur|production|transformation|mecanique|mecano|mecanic|siderurg|chimie|chemical|plastique|plastic|textile|agroalimentaire|food|papeterie|ciment|cement|carton|cuir|leather|bois|wood|confection|agro|minoterie|olivette|huilerie|brasserie|ceramique|fonderie|constellation)\w*/],
];

// Consultancy, audit, insurance and banking have no technical keyword, so
// without this they fall through to the title heuristic and get filed as `web`
// because one posting mentioned a web stack. Forvis Mazars (an audit firm) was
// landing in automatisme off the word "supervision".
const SERVICES_HINT = /\b(assurance|assurances|banque|banques|audit|auditeur|commissaire|comptable|comptabilite|fiscal|expert|expertise|conseil|consultant|consulting|avocat|juridique|immobilier|agence|recrutement|recruter|ressources\s+humaines|marketing|publicite|agence\s+de\s+voyage|hotellerie|hotelier|restaurant|clinique|sante|sanitaire|pharmacie|ecole|universite|formation|education|transport|logistique|tourisme|media|presse|edition|editeur)\b/;

// The NAME decides; the titles are consulted only when the name says nothing
// AND there is enough of them to be evidence. Classifying on titles first put
// Virtu (a trading firm) in automatisme because its postings mention
// "supervision", and Capgemini in embarque because one posting mentioned an
// aerospace client. A single posting is not enough to file a company by, so the
// title fallback needs at least TITLE_MIN_EVIDENCE of them.
const TITLE_MIN_EVIDENCE = 5;
function classify(foldedName, foldedTitles, offers) {
  for (const [sec, rx] of RULES) if (rx.test(foldedName)) return sec;
  if (SERVICES_HINT.test(foldedName)) return 'services';
  if ((offers || 0) >= TITLE_MIN_EVIDENCE) {
    const hay = foldedTitles.slice(0, 8).join(' ');
    for (const [sec, rx] of RULES) if (rx.test(hay)) return sec;
  }
  return 'services';
}

// candidates-tn.json predates this taxonomy and uses its own sector names. Its
// values are NOT translated: `it` was mapped to `web`, which filed Sagemcom --
// an electronics manufacturer -- under web. The old labels are too coarse to
// trust, so a curated sector is honoured only when it is already one of the
// eight; otherwise the employer's own name decides, as it does for everyone else.
const sectorOf = (s, foldedName, foldedTitles, offers) => {
  const k = String(s || '').toLowerCase();
  if (SECTORS.includes(k)) return k;
  return classify(foldedName, foldedTitles, offers);
};

async function getAll(query) {
  const out = [];
  for (let offset = 0; ; offset += 200) {
    const j = await (await fetch(API + '/offers/search?limit=200&offset=' + offset + (query || ''))).json();
    const items = j.items || j.offers || [];
    out.push(...items);
    if (items.length < 200 || out.length >= (j.total || 0)) break;
  }
  return out;
}

// "societe anonyme" / "entreprise anonyme" is the posting board's marker for a
// confidential employer, not a company. Matched anywhere, not just as the whole
// string, because boards also emit "Anonyme 1", "Entreprise Anonyme SARL".
const ANON = /anonyme|anonym/;
const isJunk = (raw) => !raw || raw.length < 2 || raw.length > MAX_NAME ||
  JUNK.test(clean(raw)) || JUNK_SUB.test(raw) || ANON.test(fold(raw));

(async () => {
  const sources = await (await fetch(API + '/sources')).json();
  const all = await getAll('');
  console.log('  offers: ' + all.length + ' across ' + sources.length + ' sources');

  // --- evidence: who is actually hiring in Tunisia -------------------------
  const emps = new Map();
  const note = (name, o) => {
    const raw = String(name || '').trim();
    if (isJunk(raw)) return;
    const k = keyOf(raw);
    if (!k) return;
    let e = emps.get(k);
    if (!e) { e = { key: k, name: displayName(raw), offers: 0, sources: new Set(), titles: [], locations: new Set(), links: [] }; emps.set(k, e); }
    e.offers++;
    e.sources.add(o.sourceId);
    if (e.titles.length < 8 && o.title) e.titles.push(fold(o.title));
    if (o.location && e.locations.size < 4) e.locations.add(String(o.location).split(';')[0].trim());
    if (o.link && e.links.length < 2) e.links.push(o.link);
  };
  let fromTnLocation = 0, fromTnBoard = 0;
  const tnBoards = new Set(sources.filter((s) => /^(tunisie|tn)$/i.test(String(s.country || '').trim())).map((s) => s.id));
  for (const o of all) {
    if (/^(tunisie|tn)$/i.test(String(o.country || '').trim())) { note(o.company, o); fromTnLocation++; }
    if (tnBoards.has(o.sourceId)) { note(o.company, o); fromTnBoard++; }
  }
  console.log('  evidence: ' + fromTnLocation + ' postings resolved to Tunisia, ' + fromTnBoard + ' on Tunisia-only boards');
  console.log('  distinct attested employers: ' + emps.size);

  // --- enrichment: registry boards + curated candidates ---------------------
  const reg = JSON.parse(fs.readFileSync(path.join(REG, 'companies.json'), 'utf8'));
  const regArr = Array.isArray(reg) ? reg : (reg.companies || reg.boards || []);
  const regByKey = new Map();
  for (const c of regArr) {
    for (const n of [c.company, c.name]) {
      const k = keyOf(n);
      if (k && !regByKey.has(k)) regByKey.set(k, c);
    }
  }
  const curated = JSON.parse(fs.readFileSync(path.join(REG, 'candidates-tn.json'), 'utf8'));
  const curArr = Array.isArray(curated) ? curated : (curated.companies || curated.candidates || []);
  const curByKey = new Map();
  for (const c of curArr) { const k = keyOf(c.company); if (k) curByKey.set(k, c); }

  for (const e of emps.values()) {
    const r = regByKey.get(e.key);
    const cu = curByKey.get(e.key);
    e.sector = sectorOf(cu && cu.sector, fold(e.name), e.titles, e.offers);
    e.domain = r && r.siteUrl ? String(r.siteUrl).replace(/^https?:\/\//, '').split('/')[0] : '';
    e.boardType = r ? r.type : '';
    e.boardUrl = r ? (r.boardUrl || '') : '';
    e.boardItems = r ? (r.items || 0) : 0;
    e.token = r ? r.token : '';
    e.verified = !!r;
    if (!e.domain && cu && cu.domain) { e.domain = cu.domain; e.curated = true; }
    e.status = e.verified ? 'board verified'
      : e.domain ? 'site known, board unverified'
      : 'name attested only';
  }

  // Curated companies with no posting in our corpus still belong in the dossier.
  for (const c of curArr) {
    const k = keyOf(c.company);
    if (!k || emps.has(k) || isJunk(c.company)) continue;
    // Resolve the board here too. A freshly seeded source has zero offers until
    // hunter-fleet crawls it, so Airbus and Thales landed in this bucket and were
    // reported "board unverified" while workday-ag and smartrecruiters-thales sat
    // verified in the registry. Whether a board exists is a property of the
    // registry, not of how many offers happen to have been collected yet.
    const r = regByKey.get(k);
    emps.set(k, {
      key: k, name: displayName(c.company), offers: 0, sources: new Set(), titles: [], locations: new Set(), links: [],
      sector: sectorOf(c.sector, fold(c.company), [], 0), domain: (r && r.siteUrl ? String(r.siteUrl).replace(/^https?:\/\//, '').split('/')[0] : '') || c.domain || '',
      boardType: r ? r.type : '', boardUrl: r ? (r.boardUrl || '') : '', boardItems: r ? (r.items || 0) : 0,
      token: r ? (r.token || '') : '', verified: !!r, curated: true,
      status: r ? 'board verified' : c.domain ? 'site known, board unverified' : 'name attested only',
    });
  }

  const list = [...emps.values()].sort((a, b) => b.offers - a.offers || a.name.localeCompare(b.name));
  const bySec = {};
  for (const s of SECTORS) bySec[s] = list.filter((e) => e.sector === s);
  const unknown = list.filter((e) => !SECTORS.includes(e.sector));
  console.log('  sectors: ' + SECTORS.map((s) => s + '=' + bySec[s].length).join(' '));
  if (unknown.length) console.log('  WARNING unclassified: ' + unknown.length + ' -> ' + unknown.slice(0, 8).map((e) => e.name).join(', '));
  console.log('  with a verified board: ' + list.filter((e) => e.verified).length +
    ', with a known website: ' + list.filter((e) => e.domain).length);

  if (process.argv.includes('--no-write')) return;

  // --- CSV -----------------------------------------------------------------
  const q = (v) => /[",;\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const cols = ['company', 'sector', 'offers', 'website', 'board_type', 'board_url', 'board_jobs', 'status', 'postings_via', 'locations'];
  const csv = [cols.join(',')].concat(list.map((e) => [
    q(e.name), e.sector, e.offers, e.domain ? 'https://' + e.domain : '', e.boardType, e.boardUrl,
    e.boardItems, e.status, q([...e.sources].join(' ')), q([...e.locations].join(' | ')),
  ].join(','))).join('\n');
  fs.writeFileSync(path.join(DOCS, 'tn-companies.csv'), '\uFEFF' + csv, 'utf8');

  // --- Markdown ------------------------------------------------------------
  const DASH = '\u2014';            // em dash
  const attested = list.filter((e) => e.offers > 0).length;
  const site = (e) => e.domain ? '[' + e.domain + '](https://' + e.domain + ')' : '_aucun site connu_';
  const board = (e) => e.verified
    ? '`' + e.boardType + '`' + (e.boardItems ? ' ' + DASH + ' ' + e.boardItems + ' offres' : '') + (e.boardUrl ? ' ([board](<' + e.boardUrl + '>))' : '')
    : (e.domain ? 'site connu, board non v\u00e9rifi\u00e9' : DASH);
  let md = '# Employeurs tunisiens ' + DASH + ' ' + list.length + ' soci\u00e9t\u00e9s\n\n';
  md += 'G\u00e9n\u00e9r\u00e9 par `app/daemon/report-tn.js`.\n\n';
  md += '**' + attested + ' soci\u00e9t\u00e9s sont attest\u00e9es** : leur nom provient d\'une offre\n';
  md += 'r\u00e9ellement collect\u00e9e, dont le pays a \u00e9t\u00e9 r\u00e9solu depuis le texte de l\'offre\n';
  md += '(`countryOf`, jamais depuis le pays de la source) ou bien d\'une offre parue sur un\n';
  md += 'board strictement tunisien. Les ' + (list.length - attested) + ' autres viennent de la liste\n';
  md += 'curated `registry/candidates-tn.json` et n\'ont encore aucune offre collect\u00e9e.\n';
  md += 'Aucune soci\u00e9t\u00e9 n\'est \u00e9crite de m\u00e9moire : une soci\u00e9t\u00e9 plausible mais inexistante\n';
  md += 'serait pire qu\'une ligne manquante, le g\u00e9n\u00e9rateur de CV lui enverrait une candidature.\n\n';
  md += '- ' + fromTnLocation + ' offres r\u00e9solues `country=Tunisie`\n';
  md += '- ' + fromTnBoard + ' offres sur ' + tnBoards.size + ' boards tunisiens\n';
  md += '- ' + list.filter((e) => e.verified).length + ' boards v\u00e9rifi\u00e9s (API qui r\u00e9pond avec des offres)\n';
  md += '- ' + list.filter((e) => e.domain).length + ' sites web connus\n\n';
  md += '| secteur | soci\u00e9t\u00e9s | dont board v\u00e9rifi\u00e9 |\n|---|---:|---:|\n';
  for (const s of SECTORS) md += '| ' + s + ' | ' + bySec[s].length + ' | ' + bySec[s].filter((e) => e.verified).length + ' |\n';
  md += '\n---\n\n';
  for (const s of SECTORS) {
    if (!bySec[s].length) continue;
    md += '## ' + s + ' (' + bySec[s].length + ')\n\n';
    md += '| soci\u00e9t\u00e9 | offres | site | board | statut |\n|---|---:|---|---|---|\n';
    for (const e of bySec[s]) {
      md += '| ' + e.name.replace(/\|/g, '\\|') + ' | ' + (e.offers || DASH) + ' | ' + site(e) + ' | ' + board(e) + ' | ' + e.status + ' |\n';
    }
    md += '\n';
  }
  fs.writeFileSync(path.join(DOCS, 'tn-companies.md'), md, 'utf8');

  // --- candidate list for the prober ---------------------------------------
  const cands = list.filter((e) => e.domain).map((e) => ({
    id: 'tn-' + e.key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40),
    company: e.name, domain: e.domain, country: 'TN', sector: e.sector,
  }));
  fs.writeFileSync(path.join(REG, 'candidates-tn-deep.json'), JSON.stringify(cands, null, 1), 'utf8');
  console.log('\n  wrote docs/tn-companies.md, docs/tn-companies.csv, registry/candidates-tn-deep.json');
  console.log('  probe candidates with a resolvable domain: ' + cands.length);
  console.log('  attested but domain-less (prober would have to guess a slug): ' + (list.length - cands.length));
})();
