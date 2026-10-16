'use strict';
// Locked applicant answers for auto-apply — user-approved, mandatory-only.
// Sensitive items (gender, disability, veteran, ethnicity, work auth) are NEVER
// invented: the solver only uses values present here, otherwise it pauses and asks.
// Optional form fields are always skipped (mandatoryOnly).
// This file is gitignored (creds/) and read-only for workers except saveAnswer(),
// which records explicit user replies given in chat.
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const FILE = path.join(DIR, 'creds', 'apply-answers.json');

let cache = null;
function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (_) { cache = {}; }
  return cache;
}

// Only returns what the user actually approved in creds/apply-answers.json.
// A MISSING sensitive value stays undefined on purpose: the driver then turns
// the field into an `unanswered` question instead of guessing. The previous
// `|| 'male'` / `=== undefined ? false` / `|| 'Tunisian'` fallbacks silently
// answered sensitive questions with invented values.
function getAnswers() {
  const a = load();
  const str = (v) => { const s = String(v == null ? '' : v).trim(); return s || undefined; };
  return {
    gender: str(a.gender),
    disability: typeof a.disability === 'boolean' ? a.disability : undefined,
    veteran: typeof a.veteran === 'boolean' ? a.veteran : undefined,
    nationality: str(a.nationality),
    workAuth: (a.workAuth && typeof a.workAuth === 'object') ? a.workAuth : {},
    ethnicity: str(a.ethnicity),
    mandatoryOnly: a.mandatoryOnly !== false,
    ssoEmail: str(a.ssoEmail),
    learned: (a.learned && typeof a.learned === 'object') ? a.learned : {},
  };
}

// Record an explicit user answer from chat. Key is a normalized question id
// (e.g. 'race', 'veteran_status', 'sponsorship_us'), value is the chosen option.
// Only called from the save_answer agent tool — never guessed by code.
function saveAnswer(key, value) {
  const k = String(key || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 64);
  const v = String(value || '').trim().slice(0, 200);
  if (!k || !v) return { ok: false, error: 'key and value required' };
  const a = load();
  a.learned = (a.learned && typeof a.learned === 'object') ? a.learned : {};
  a.learned[k] = v;
  cache = a;
  try {
    fs.mkdirSync(path.join(DIR, 'creds'), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(a, null, 2));
  } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 120) }; }
  return { ok: true, key: k };
}

// Work authorization for a job country. Looks up, in order: an explicit user
// override (learned), the approved per-country map, then the approved default.
// Returns undefined when nothing is approved -> caller asks instead of guessing.
function workAuthFor(country) {
  const a = getAnswers();
  const c = String(country || '').trim();
  const lk = a.learned['workauth_' + c.toLowerCase()];
  if (lk) return String(lk);
  const map = a.workAuth || {};
  if (c && map[c]) return String(map[c]);
  if (!c) {
    // No country known: only a Tunisia job may be auto-answered as authorized.
    return map.Tunisia === 'authorized' ? 'authorized' : undefined;
  }
  return map.default ? String(map.default) : undefined;
}

module.exports = { getAnswers, saveAnswer, workAuthFor };
