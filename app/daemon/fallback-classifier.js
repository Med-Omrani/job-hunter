'use strict';
// ---- local fallback classifier --------------------------------------------
// Purpose: when Groq is unreachable or out of quota, the band must not become a
// black hole. Today an LLM outage leaves every pending offer invisible forever --
// 3,911 of them at the time of writing. This module decides what can be decided
// WITHOUT an LLM and refuses to decide the rest.
//
// HONEST SCOPE
// This is not a semantic classifier and does not pretend to be one. It adds two
// signals that the flat keyword engine structurally cannot express, and nothing
// else. Anything it is not confident about returns 'unsure', which leaves the
// offer in the band for a real model to judge later. It would be much worse to
// invent verdicts here: this whole session was spent eliminating exactly that
// failure mode, and a rule-based guess stamped as authoritative would bring it
// straight back.
//
// SIGNAL 1 - occupational family veto (reject)
//   The engine's blocklist is a fixed vocabulary. It has no notion that
//   "Steuerberater" or "Senior Campaign Analyst" are accounting and marketing
//   jobs, so those titles reach the band and cost real quota. This rule asks a
//   structural question instead: is the head noun of the title a job family we
//   do not do, with no engineering token anywhere in it? That holds regardless of
//   vocabulary drift, which is what makes it worth having.
//
// SIGNAL 2 - cross-cluster corroboration (promote)  --  MEASURED, THEN DISABLED
//   scoreOffer() requires at least one STRONG keyword hit, so a posting whose body
//   names many concrete techniques but whose title is bland scores 0 and lands in
//   the band: 'conception de cartes electroniques, regulation, capteurs, linux
//   embarque' has fpga + regulation + capteur + linux embarque, four distinct
//   weak tokens across two clusters, and still scores zero because none of them
//   is strong. Counting distinct hard tokens across clusters is a combination the
//   flat sum cannot represent.
//
//   This signal looked plausible. It is not usable. Measured with
//   scripts/measure-fallback.js against the 1,087 offers the LLM had already
//   decided (12 promoted, 1,052 rejected -- the real base rate is 1.1%):
//
//     local promote precision, no gate ............... 17.6%  (12/68)
//     ... with location+seniority+sales+eng gate .... 33.3%  (1/3)
//     local reject precision ......................... 100.0% (284/284)
//
//   Promoting at 17.6% would push five wrong offers into the feed for every one
//   real offer. The gate that improves it to 33% costs 11 of the 12 true
//   positives, because most genuine matches carry an EMPTY location field and
//   the gate filters on missing data rather than on real ineligibility.
//
//   Why it fails, from the false promotes:
//     - location is the single biggest LLM reject driver (125 rows pure
//       location, 49 more location+seniority) and this module has no location
//       signal at all: Brazil, India, Canada, Australia, Korea all promote;
//     - seniority is next (177 rows): senior / lead / director / expert;
//     - generic tokens match company boilerplate and URLs, not the job:
//       'dart', 'automate', 'web', 'node', 'linux', 'git' are not evidence;
//     - "Commercial Sales Engineer" passes the engineering-token check because
//       it contains "engineer", while being a sales job.
//
// So PROMOTE is implemented, measurable and retained behind `allowPromote`,
// but OFF by default. The default path is reject-only: the one rule that is
// provably safe. Everything else stays pending for a real model. On the corpus
// that still clears ~26% of decided rows with zero quota and zero wrong
// promotions, which is the actual goal -- the point is to stop the band being a
// black hole, not to simulate a reader.
//
// Every verdict carries `engine: 'local-v1'`, so its precision stays a measured
// number and can be re-checked whenever the corpus grows.

const ENGINE_ID = 'local-v1';

// Job families we do not target, as head nouns. Deliberately coarse: each entry
// is a family with many members, because the point is coverage across vocabulary
// change, not precision on individual titles.
const OFF_TARGET_FAMILIES = [
  'comptable', 'accountant', 'accounting', 'steuerberater', 'tax advisor', 'tax consultant',
  'payroll', 'payroll specialist', 'lohnbuchhalter', 'bookkeeper', 'audit', 'auditor',
  'analyste', 'analyst', 'business analyst', 'data analyst', 'market analyst',
  'marketing', 'marketing manager', 'campaign', 'seo', 'sem', 'brand', 'brand manager',
  'commercial', 'sales', 'sales manager', 'business development', 'account executive',
  'customer success', 'customer support', 'accountant', 'recruiter', 'talent acquisition',
  'juriste', 'avocat', 'legal', 'paralegal', 'compliance officer',
  'rh', 'human resources', 'payroll specialist', 'office manager', 'secretary',
  'project manager', 'product manager', 'product owner', 'scrum master',
  'ux', 'ui designer', 'graphic designer', 'webdesigner', 'content writer',
  'traducteur', 'translator', 'interprete', 'community manager',
  'e-commerce', 'ecommerce', 'shopify', 'merchandising', 'acheteur', 'buyer',
  'teacher', 'professor', 'lecturer', 'formateur', 'trainer', 'tutor',
  'nurse', 'infirmier', 'medecin', 'pharmacien', 'dentiste',
  'cuisinier', 'chef cuisinier', 'caissier', 'chauffeur', 'livreur',
  'magasinier', 'vendeur', 'manutentionnaire', 'agent immobilier',
];

// Tokens proving the role is technical even when the family word is present.
// 'Senior Data Engineer' must not be vetoed as an 'analyst'-adjacent role.
const ENGINEERING_TOKENS = [
  'engineer', 'engineering', 'developer', 'devops', 'programmer', 'architect',
  'technician', 'technicien', 'technique', 'automaticien', 'automaticienne',
  'electronicien', 'electronicienne', 'ingenieur', 'ingenieure',
  'software', 'firmware', 'embedded', 'automatisme', 'automation', 'robot',
  'robotique', 'mecatronique', 'electrotechnique', 'electronique', 'electricien',
  'sysadmin', 'networking', 'reseau', 'data engineer',
];

// Hard domain evidence, grouped so corroboration can be required ACROSS clusters
// rather than piled up inside one.
const HARD_SIGNALS = {
  embarque: ['fpga', 'rtos', 'temps reel', 'bootloader', 'dsp', 'can bus', 'canopen',
    'linux embarque', 'bare metal', 'cortex', 'microcontroleur', 'stm32', 'embarque',
    'hal', 'kernel', 'driver', 'testbench', 'bench test', 'hil', 'schematic', 'pcb',
    'altium', 'kicad', 'eagle', 'layout pcb', 'route pcb', 'freescale', 'nxp'],
  automatisme: ['plc', 'automate', 'hmi', 'scada', 'codesys', 'tia portal', 'wincc',
    'grafcet', 'regulation', 'actionneur', 'capteur', 'pneumatique', 'hydraulique',
    'safety plc', 'atp', 'variateur', 'automate programmable', 'supervision',
    'ihm', 'synoptic'],
  electro: ['electrotechnique', 'electronique de puissance', 'courant fort', 'courant faible',
    'haute tension', 'moyenne tension', 'convertisseur', 'onduleur', 'motorisation',
    'harmonique', 'armoire electrique', 'tableau electrique', 'generateur', 'transformateur',
    'variateur de vitesse', 'electronique'],
  logiciel: ['developpeur', 'developpeuse', 'programmeur', 'langage c', 'c++', 'cpp',
    'java', 'python', 'javascript', 'typescript', 'dotnet', 'spring', 'node', 'angular',
    'flutter', 'dart', 'kotlin', 'swift', 'react', 'django', 'fastapi', 'api rest',
    'sql', 'postgresql', 'docker', 'kubernetes', 'linux', 'git', 'microservice',
    'base de donnees', 'web', 'frontend', 'backend', 'fullstack', 'devops', 'selenium'],
  reseau: ['tcp ip', 'ethernet', 'modbus', 'mqtt', 'opc ua', 'profibus', 'modbus tcp',
    'fibre optique', 'wifi', 'routage', 'switch', 'vlan', 'firewall', 'active directory',
    'windows server', 'linux serveur', 'snmp', 'network'],
};

// A posting needs this many distinct hard tokens, spanning this many clusters,
// before it is promoted on evidence alone. Two tokens in one cluster is a single
// technique mentioned twice; three clusters is a job that genuinely touches the
// stack.
const PROMOTE_MIN_TOKENS = 3;
const PROMOTE_MIN_CLUSTERS = 2;

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Whole-word containment, so 'c' or 'qa' cannot match inside an unrelated word.
function hasWord(text, phrase) {
  const t = ' ' + norm(text).replace(/[^a-z0-9+#]+/g, ' ').replace(/\s+/g, ' ') + ' ';
  const p = norm(phrase).replace(/[^a-z0-9+#]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!p) return false;
  return t.includes(' ' + p + ' ');
}

function countHard(text) {
  const found = new Set();
  const clusters = new Set();
  for (const [cluster, words] of Object.entries(HARD_SIGNALS)) {
    for (const w of words) {
      if (hasWord(text, w)) { found.add(w); clusters.add(cluster); }
    }
  }
  return { tokens: [...found], count: found.size, clusters: [...clusters] };
}

function hasEngineeringToken(text) {
  return ENGINEERING_TOKENS.find((t) => hasWord(text, t)) || null;
}

function offTargetFamily(title) {
  // Only the head of the title counts. 'Analyste Financier' is a veto; a body
  // sentence mentioning finance is not, which is why BLOCKLIST stays title-only.
  const head = norm(title).split(/[–—\-|,/(]/)[0];
  const wide = title + ' ' + head; // family words often trail a modifier
  return OFF_TARGET_FAMILIES.find((f) => hasWord(wide, f)) || null;
}

// The only decision this module is allowed to make on rejection grounds.
function familyVeto(offer) {
  const title = offer && offer.title;
  if (!title) return null;
  const eng = hasEngineeringToken(title);
  if (eng) return null; // never veto a title that names an engineering role
  const fam = offTargetFamily(title);
  if (!fam) return null;
  // A body dense with hard evidence outranks a bland head noun: the title may
  // simply be written badly. Demote to unsure rather than reject.
  const hard = countHard(offer.description || '');
  if (hard.count >= PROMOTE_MIN_TOKENS && hard.clusters.length >= PROMOTE_MIN_CLUSTERS) {
    return null;
  }
  return { family: fam, hardTokens: hard.count };
}

// Returns { verdict, confidence, reasons[], engine, tokens, clusters }.
// verdict is one of: 'promote' | 'reject' | 'unsure'.
//
// `opts.allowPromote` is OFF by default because the promote rule measured 17.6%
// precision against real LLM verdicts (see header). Leave it off in production.
function classifyLocal(offer, opts) {
  const o = offer || {};
  const allowPromote = !!(opts && opts.allowPromote);
  const title = o.title || '';
  const desc = o.description || '';
  const eng = hasEngineeringToken(title);
  const hard = countHard(title + ' ' + desc);

  // Corroborated hard evidence promotes, whether or not the title is generic.
  if (allowPromote && hard.count >= PROMOTE_MIN_TOKENS && hard.clusters.length >= PROMOTE_MIN_CLUSTERS) {
    return {
      verdict: 'promote',
      // Confidence rises with breadth, but caps below the LLM: this rule cannot
      // read "we are looking for a motivated self-starter".
      confidence: Math.min(0.75, 0.45 + 0.06 * hard.count + 0.08 * hard.clusters.length),
      reasons: [
        'hard domain evidence: ' + hard.tokens.slice(0, 6).join(', '),
        'spans ' + hard.clusters.length + ' clusters (' + hard.clusters.join(', ') + ')',
      ],
      engine: ENGINE_ID,
      tokens: hard.tokens,
      clusters: hard.clusters,
    };
  }

  // An engineering role plus any hard token is decent but thinner evidence.
  if (allowPromote && eng && hard.count >= 1) {
    return {
      verdict: 'promote',
      confidence: 0.5,
      reasons: ['engineering role in title (' + eng + ')', 'domain token: ' + hard.tokens[0]],
      engine: ENGINE_ID,
      tokens: hard.tokens,
      clusters: hard.clusters,
    };
  }

  const veto = familyVeto(o);
  if (veto) {
    return {
      verdict: 'reject',
      // A family veto with an engineering token absent is the one strong
      // negative signal available without semantics.
      confidence: 0.7,
      reasons: ['off-target job family: ' + veto.family, 'no engineering token in title'],
      engine: ENGINE_ID,
      tokens: hard.tokens,
      clusters: hard.clusters,
    };
  }

  return {
    verdict: 'unsure',
    confidence: 0,
    reasons: ['no corroborated evidence (' + hard.count + ' hard tokens, ' +
      hard.clusters.length + ' cluster' + (hard.clusters.length === 1 ? '' : 's') + ')'],
    engine: ENGINE_ID,
    tokens: hard.tokens,
    clusters: hard.clusters,
  };
}

module.exports = {
  ENGINE_ID,
  PROMOTE_MIN_TOKENS,
  PROMOTE_MIN_CLUSTERS,
  OFF_TARGET_FAMILIES,
  ENGINEERING_TOKENS,
  HARD_SIGNALS,
  classifyLocal,
  countHard,
  hasWord,
  hasEngineeringToken,
  offTargetFamily,
};
