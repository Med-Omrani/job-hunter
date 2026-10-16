'use strict';

function dePlural(t) {
  return String(t).split(' ').map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ');
}

function foldText(s) {
  return dePlural(String(s || '')
    .toLowerCase()
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ').trim());
}

function rxFor(word) {
  const core = word.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return new RegExp('(^|[^a-z0-9])' + core + '([^a-z0-9]|$)', 'i');
}

const CLUSTERS = [
  {
    name: 'embarque',
    strong: [
      'embarque', 'embedded', 'firmware', 'microcontroleur', 'microcontroller', 'stm32',
      'iot', 'internet of things', 'robotique', 'robot', 'mecatronique', 'domotique',
    ],
    weak: [
      'fpga', 'rtos', 'temps reel', 'bootloader', 'dsp', 'can bus', 'linux embarque', 'drone',
      'ingenieur', 'technicien', 'carte', 'controle commande', 'systeme embarque',
    ],
  },
  {
    name: 'automatisme',
    strong: [
      'automatisme', 'automaticien', 'automaticienne', 'automation', 'automatisation', 'plc',
      'automate', 'hmi', 'scada', 'codesys', 'tia portal', 'wincc', 'supervision',
      'automate programmable',
    ],
    weak: [
      'regulation', 'instrumentation', 'capteur', 'actionneur', 'pneumatique', 'hydraulique',
      'machines speciales', 'grafcet', 'process industrie', 'ligne de production', 'usine',
      'site industriel', 'maintenance industrielle', 'conduite de ligne', 'conducteur de ligne',
      'robot industriel',
    ],
  },
  {
    name: 'electro',
    strong: [
      'electrotechnique', 'electronique', 'electronicien', 'electronicienne', 'systeme electrique',
      'distribution electrique', 'haute tension', 'moyenne tension', 'convertisseur',
      'onduleur', 'motorisation', 'variateur',
    ],
    weak: [
      'electrique', 'electricite', 'courant fort', 'courant faible', 'cable', 'tableau electrique',
      'armoire electrique', 'installation electrique',       'electronique de puissance', 'cem', 'harmonique',
      'ingenieur', 'technicien', 'genie electrique', 'automatisation',
    ],
  },
  {
    name: 'logiciel',
    strong: [
      'flutter', 'android', 'mobile', 'angular', 'asp net', 'python', 'backend', 'frontend',
      'fullstack', 'api', 'rest', 'cloud', 'sql', 'react', 'django', 'fastapi', 'devops',
      'cybersecurite', 'securite applicative', 'securite', 'qa', 'assurance qualite', 'software',
      'analyste soc', 'soc', 'pentest',
      // francais: sans ces mots, les offres FR/TN "ingenieur logiciel" ou
      // "genie informatique" ne matchaient aucun cluster.
      'logiciel', 'informatique', 'genie informatique', 'genie logiciel',
    ],
    weak: [
      'developpeur', 'developpeuse', 'programmeur', 'developpement', 'intelligence artificielle',
      'machine learning', 'deep learning', 'algorithme', 'algorithmique', 'java', 'javascript',
      'typescript', 'cpp', 'langage c', 'spring', 'spring boot', 'kubernetes', 'docker', 'git',
      'agile', 'scrum', 'microservice', 'base de donnees', 'big data', 'data analyst',
      'data engineer', 'web', 'test logiciel', 'testeur', 'selenium',
      'ingenieur', 'engineer', 'donnees', 'numerique', 'systeme', 'webapp',
    ],
  },
  {
    name: 'reseau',
    strong: [
      'reseau', 'reseau informatique', 'reseau industriel', 'infrastructure', 'opc ua',
      'modbus', 'ethernet', 'mqtt', 'tcp ip', 'voip', 'fibre optique', 'wifi', 'telephonie',
    ],
    weak: [
      'telecom', 'administration reseau', 'serveur', 'vmware', 'hyperv', 'active directory',
      'windows server', 'linux', 'firewall', 'helpdesk', 'support informatique', '5g', 'telephonie ip',
      'ingenieur', 'technicien', 'teleservice',
    ],
  },
];

const STRONG_ALL = CLUSTERS.flatMap((c) => c.strong);
const WEAK_ALL = CLUSTERS.flatMap((c) => c.weak);

const BLOCKLIST = [
  'vente', 'ventes', 'commercial', 'commerciale', 'commerciaux', 'sales', 'selling',
  'marketing', 'finance', 'financial', 'comptable', 'comptabilite',
  // 2026-10-07: "all business and marketing offers" — bare 'business' so titles
  // like "Business Analyst" / "Business Systems Engineer" stop re-entering the
  // feed (the phrases below only caught their sales-family variants).
  'business',
  'ressources humaines', 'rh', 'nursing', 'infirmier', 'medecin', 'medecine', 'dentiste',
  'pharmacien', 'pharmacie', 'avocat', 'juriste', 'juridique', 'recruteur', 'recruitment',
  'teleconseiller', 'hotesse', 'steward', 'cuisinier', 'caissier', 'chauffeur',
  'livreur', 'manutentionnaire', 'magasinier', 'vendeur', 'vestiaire',
  'account manager', 'business developer', 'charge de clientele', 'attaché commercial',
  'agent immobilier', 'conseiller clientele', 'team leader commercial',
  // Sales-family leaks that were reaching the feed with match=true: 1,353
  // "Account Executive" + ~316 "business development"/b2b offers measured in DB.
  'account executive', 'business development', 'b2b', 'key account',
  'growth manager', 'sales director', 'head of sales',
  // Marketing-family titles purged 2026-10-07 with the business/sales rows
  // (538 soft deletes). Phrase-level only: bare 'sem' would kill SEM
  // (scanning-electron) engineering titles and bare 'crm' kills CRM developers.
  'seo', 'community manager', 'social media', 'influencer', 'influenceur',
  'traffic manager', 'media buyer', 'brand manager', 'brand designer',
  'crm manager', 'content manager', 'growth hacking',
  'branding', 'customer growth', 'growth specialist',
  // internships are never jobs we want (matched by whole word via rxFor)
  'stage', 'stagiaire', 'internship', 'intern',
  'alternance', 'alternant', 'apprentissage', 'apprenti',
];

const BLOCKLIST_RE = BLOCKLIST.map((w) => rxFor(foldText(w))).filter(Boolean);

// Title-level blocklist test shared by ingest and the digest push: a blocked
// sales title must never reach the feed or the phone, whatever the LLM band
// previously stamped on the row.
function blockedTitle(title) {
  const t = foldText(title);
  if (!t) return false;
  return BLOCKLIST_RE.some((re) => re.test(t));
}

// WHY SENIORITY
// The engine had no notion of seniority, so a French/TN feed that skews senior
// fed back ~32% senior-gated offers and only ~1.5% entry-level ones (measured on
// 200 recent offers). We boost the levels a non-senior candidate can actually be
// hired for and damp the ones gated on years of experience. This only shifts the
// score of an already-matched offer: it never blocks or unmatches one, so a
// strong senior role stays visible if nothing better exists that day.
const ENTRY_RE = [
  rxFor('junior'), rxFor('jnr'), rxFor('graduate'), rxFor('new grad'), rxFor('entry level'),
  rxFor('entry level'), rxFor('trainee'), rxFor('apprentice'), rxFor('graduate engineer'),
  rxFor('engineer i'), rxFor('i level'), rxFor('campus'), rxFor('recent graduate'),
  rxFor('without experience'), rxFor('no experience'), rxFor('debutant'), rxFor('debutante'),
  rxFor('alternant'), rxFor('apprenti'),
].filter(Boolean);

const SENIOR_RE = [
  rxFor('senior'), rxFor('snr'), rxFor('lead'), rxFor('staff'), rxFor('principal'),
  rxFor('head of'), rxFor('director'), rxFor('expert'), rxFor('architect'),
  rxFor('engineer ii'), rxFor('engineer iii'), rxFor('engineer iv'),
  rxFor('iii'), rxFor('manager'), rxFor('responsable'), rxFor('directeur'),
  rxFor('chef de projet'), rxFor('consultant senior'), rxFor('distinguished'),
].filter(Boolean);

function detectSeniority(folded) {
  if (!folded) return null;
  const entry = ENTRY_RE.some((re) => re.test(folded));
  const senior = SENIOR_RE.some((re) => re.test(folded));
  if (entry && !senior) return 'entry';
  if (senior && !entry) return 'senior';
  if (entry && senior) return 'mixed';
  return null;
}

// WHY CONTEXT_GUARD
// 'mobile', 'api', 'robot' and 'cloud' are strong keywords but also ordinary
// English nouns, so they alone matched "Mobile Phlebotomist", "API Product
// Manager" and "Robotaxi Fleet Coordinator". A guarded keyword now only counts
// as a strong hit when the title carries an engineering token; otherwise it
// degrades to a weak hit and scores 1 instead of 2.
const CONTEXT_GUARD = {
  mobile: ['engineer', 'developer', 'dev', 'software', 'app', 'application', 'android', 'ios',
    'flutter', 'react', 'native', 'fullstack', 'backend', 'frontend', 'web', 'programmer'],
  api: ['engineer', 'developer', 'dev', 'software', 'backend', 'integration', 'platform',
    'architect', 'web', 'service', 'microservice', 'programmer'],
  robot: ['engineer', 'developer', 'software', 'automation', 'control', 'vision', 'programmer',
    'technician', 'technicien', 'engineer'],
  cloud: ['engineer', 'developer', 'dev', 'software', 'architect', 'devops', 'security',
    'platform', 'infrastructure', 'programmer'],
};

function guardAllows(term, foldedTitle) {
  const need = CONTEXT_GUARD[term];
  if (!need) return true;
  return need.some((w) => rxFor(w).test(foldedTitle));
}

function splitStrongByContext(hits, foldedTitle) {
  const solid = [];
  const guarded = [];
  for (const h of hits) (guardAllows(h, foldedTitle) ? solid : guarded).push(h);
  return { solid, guarded };
}

function foldHits(text, words) {
  const t = foldText(text);
  const out = [];
  for (const w of words) {
    if (t && rxFor(foldText(w)).test(t)) out.push(w);
  }
  return [...new Set(out)];
}

function scoreOffer(title, desc, profileKw) {
  const titleF = foldText(title);
  const allF = foldText((title || '') + ' ' + (desc || ''));

  for (const re of BLOCKLIST_RE) {
    if (titleF && re.test(titleF)) {
      return { score: 0, match: false, matches: [], blocked: true };
    }
  }

  const titles = new Set();
  const descs = new Set();
  const strongHits = new Set();
  let clusterScore = 0;
  const perCluster = {};

  for (const c of CLUSTERS) {
    const thAll = foldHits(title, c.strong);
    const { solid, guarded } = splitStrongByContext(thAll, titleF);
    const dh = foldHits(desc, c.weak.concat(c.strong));
    let pts = 0;
    // A solid title keyword is worth the full 2; a guarded one (mobile/api/robot
    // without an engineering token in the title) is worth 1, so "Mobile
    // Phlebotomist" cannot reach the same tier as "Mobile App Engineer".
    if (solid.length) pts += 2;
    if (guarded.length) pts += 1;
    if (dh.length) pts += 1;
    if (pts > 0) {
      perCluster[c.name] = {
        title: thAll,
        desc: dh.filter((w) => !thAll.includes(w)),
        pts,
      };
      clusterScore += pts;
    }
    for (const k of solid) { titles.add(k); strongHits.add(k); }
    // A guarded keyword still counts for match=1, it just cannot carry the tier.
    for (const k of guarded) { titles.add(k); strongHits.add(k); }
    for (const k of dh) { descs.add(k); if (c.strong.includes(k)) strongHits.add(k); }
  }

  let profileHits = [];
  if (Array.isArray(profileKw) && profileKw.length) {
    profileHits = foldHits(allF, profileKw);
    for (const k of profileHits) { strongHits.add(k); clusterScore += 1; }
  }

  const match = strongHits.size > 0;
  let score = match ? Math.min(6, clusterScore) : 0;

  const seniority = detectSeniority(titleF);
  if (seniority === 'entry' && score > 0) score = Math.min(6, score + 1);
  else if (seniority === 'senior' && score > 0) score = Math.max(1, score - 1);

  const matches = [...new Set([...strongHits, ...titles, ...descs, ...profileHits])].slice(0, 10);
  return { score, match, matches, cluster: perCluster, profileHits, seniority };
}

module.exports = {
  scoreOffer, foldText, CLUSTERS, BLOCKLIST, STRONG_ALL, WEAK_ALL, blockedTitle,
  detectSeniority, CONTEXT_GUARD,
};