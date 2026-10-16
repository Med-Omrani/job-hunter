'use strict';
// Semantic relevance classifier for the ambiguous band.
//
// WHAT THIS IS FOR
// The keyword engine (engine.js) drops ~70% of scraped postings because they do
// not literally contain a cluster keyword. Measured on the live fleet: 3,875
// unmatched per sweep against 1,684 matched. A slice of those are real misses --
// "Superviseur de Production", "Technicien Maintenance (H/F)" and "Technicien
// qualite UAP" at Valeo were all rejected despite being genuine, local,
// relevant roles. This module is the second opinion for exactly that slice.
//
// IT IS NOT A REPLACEMENT FOR engine.js
// The keyword engine stays the first pass. It is free, instant and already
// tuned; the LLM only ever runs on offers keywords could not judge, which keeps
// cost proportional to the ambiguous band instead of the whole corpus.
//
// DELIBERATE NON-GOALS
// - No embeddings. pgvector is not installed and none of the configured Groq
//   models offer an embedding endpoint, so "semantic" here means prompting a
//   reasoning model, not a vector index.
// - No auto-tuning. Nothing here rewrites engine.js or its blocklist. The audit
//   agent proposes changes to a human; see relevance-audit.js.

const { json } = require('./llm-client.js');

// The profile is the whole basis of every verdict, so it is written once, kept
// short, and stated as facts rather than as a persona. It is derived from the
// real CV -- nothing here may claim a skill the CV does not evidence
// (RULES.md: never invent skills or projects).
const PROFILE = `CANDIDATE
Name: Mohamed Omrani.
Role target: EMBEDDED SYSTEMS, AUTOMATION AND INDUSTRIAL ENGINEERING, and also
  full-stack SOFTWARE ENGINEERING.
This is an engineering profile with TWO co-equal tracks -- do not treat one as
a consolation prize for failing the other:
  TRACK A - embedded / automation / industrial (primary, and the track most
  numerous in Tunisia and France):
  - Embedded: C/C++ on MCUs (STM32), firmware, bootloaders, RTOS, FPGA/DSP,
    CAN bus, robotics, mecatronics, system design.
  - Automation / industrial control: PLC, HMI, SCADA (Codesys, TIA Portal,
    WinCC), industrial supervision, control systems, instrumentation,
    hydraulics and pneumatics, industrial maintenance.
  - Electrical / electronics: power distribution, HV/MV, power electronics,
    converters, inverters, variable-speed drives, electrical panels.
  - Industrial networks: Modbus, OPC UA, MQTT, TCP/IP, Profinet/Modbus TCP.
  TRACK B - software (equally valid professional experience, not a fallback):
  - Backend: Python (FastAPI/Django), Java (Spring Boot), Node/JS/TS, REST APIs,
    SQL (PostgreSQL/MySQL), MongoDB.
  - Frontend / mobile: Angular, React, Flutter, Android.
  - Platform: Docker, Kubernetes, CI/CD, AWS, Linux, Git, Agile.
  - Quality: QA/automation testing, Selenium, cybersecurity/SOC analysis.
  A strong backend, full-stack, mobile or DevOps role is a RELEVANT offer for
  this candidate. Do not reject one for "having no industrial focus" -- that
  is the single most common wrong answer on this profile.
IMPORTANT -- the candidate is also recruitable at TECHNICIAN and SUPERVISOR
level. Production and industrial posts are IN SCOPE, not a downgrade:
  - "Technicien maintenance", "Technicien qualite", "technicien assemblage",
    "technicien methodes", "technicien BE", "responsable maintenance",
    "superviseur de production", "chef d'equipe", "regleur", "methodiste",
    "automaticien", "technicien automatisme" -- all RELEVANT when the setting
    is industrial (factory, workshop, production line, site industriel).
  Do NOT reject a role merely because it says "technicien", "supervisor",
  "production", "quality", "maintenance" or "assemblage" instead of
  "engineer". Judge the DOMAIN and the SETTING, not the seniority word.
  A "Technicien Maintenance" on an industrial line is a closer fit to this
  candidate than a "Software Engineer" at a generic tech company.
Location: Tunisia. Open to Tunisia and France (remote/relocation), and to
  worldwide roles that are explicitly remote.
Languages: Arabic, French, English.
Seniority: junior to mid (roughly 0-6 years). Legitimate to reject roles
  that demand 8+ years or a team-of-managers track record as a poor fit.
Hard constraints -- an offer is NOT relevant if it is:
  - a sales, marketing, finance, accounting, HR, legal, nursing/medical,
    teaching/faculty, retail, hospitality, driving or logistics role;
  - an internship, apprenticeship, or student placement;
  - a university faculty/tenure-track post (adjunct lecturer, assistant
    professor, research assistant) -- these are academic jobs, not engineering;
  - a research-only or purely academic position;
  - a role in a domain the candidate does not have (civil/structural
    engineering, clinical research, SAP, Oracle DBA, nursing, law);
  - a role whose stated experience requirement is senior/lead/principal/head of
    department when the offer is otherwise engineering.`;

// Ordered so the model resolves conflicts the same way every run.
const SYSTEM = `You screen job postings for ONE specific candidate. You are precise and literal: a posting is relevant only if the candidate could genuinely be hired for it.

${PROFILE}

RULES
1. Judge the actual role and its setting, not the company and not the
   prestige of the job title. A world-famous employer posting a cashier role is
   NOT relevant. Conversely, a "technicien" role on a real production line CAN
   be an excellent fit.
2. The title decides first. Use the description only to resolve what the title
   leaves ambiguous, or to notice a domain the title omits.
3. Industrial technician, quality, maintenance and production-supervisor roles
   are IN SCOPE. Do not reject them for not containing the word "engineer".
4. A posting in English or French is equally in scope; the language is irrelevant.
4. Titles naming a technology the candidate does not have (e.g. "SAP
   consultant", "Oracle DBA", "Civil Structural Engineer", "Clinical Research
   Associate") are NOT relevant, even if the company is excellent. Note this is
   about DOMAIN: "civil/structural", "clinical", "nursing", "law" and "SAP" are
   out, while "maintenance", "quality", "production", "automation", "backend",
   "fullstack", "mobile" and "devops" are all in.
5. Do not reward seniority the candidate cannot be hired at, and do not penalise
   a role for being junior or technician-level.
6. Remote roles are in scope regardless of the employer's country. On-site roles
   are in scope for Tunisia and France, and out of scope otherwise.
7. When torn, prefer a low-but-true verdict over a false: an industrial role in
   Tunisia that merely MIGHT suit this candidate is worth surfacing, because the
   user can dismiss it in one tap. False positives are cheap to undo; a missed
   Tunisian engineering job is not recoverable.

OUTPUT
Reply with one JSON object and nothing else:
{"verdicts":[{"id":"<the id you were given>","match":true|false,"score":0-6,"reason":"<max 15 words"}]}
Include EXACTLY one verdict per input id, in the same order, even for ids you
are unsure about. Never invent an id. score is 0-6: 5-6 exceptional fit, 4 solid,
3 plausible, 2 weak, 0-1 no fit.`;

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '\u2026' : t;
}

// One user message holding the whole batch. Offers are identified by index+id so
// a model that drops or duplicates an entry is detectable (see validate).
function buildBatchPrompt(offers) {
  const lines = offers.map((o, i) => {
    const head = `[${i}] id=${o.id}\ntitle: ${clip(o.title, 200)}\ncompany: ${clip(o.company, 100)}`
      + `\nlocation: ${clip(o.location || o.country || '', 100)}`;
    const body = clip(o.description || '', 1200);
    return head + (body ? `\ndescription: ${body}` : '\ndescription: (none provided)');
  });
  return `Screen these ${offers.length} postings against the candidate profile. `
    + `Reply with ${offers.length} verdicts.\n\n${lines.join('\n\n')}`;
}

// Structural check on the model's reply. A reasoning model will occasionally
// skip an entry, invent one, or answer a bare array -- each of those would
// silently misalign verdicts with offers, so they are caught here rather than
// becoming wrong scores on real postings.
function validate(data, offers) {
  const raw = Array.isArray(data) ? data : (data && Array.isArray(data.verdicts) ? data.verdicts : null);
  if (!raw) return { ok: false, error: 'no_verdicts_array' };
  const byId = new Map();
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const id = String(v.id == null ? '' : v.id).trim();
    if (!id) continue;
    if (byId.has(id)) return { ok: false, error: 'duplicate_id', id };
    byId.set(id, v);
  }
  const missing = offers.filter((o) => !byId.has(String(o.id))).map((o) => String(o.id));
  if (missing.length) return { ok: false, error: 'missing_ids', missing };
  const extra = [...byId.keys()].filter((id) => !offers.some((o) => String(o.id) === id));
  if (extra.length) return { ok: false, error: 'unknown_ids', extra };
  return { ok: true, byId };
}

function normalize(v) {
  const score = Math.max(0, Math.min(6, Math.round(Number(v.score))));
  return {
    match: v.match === true || v.match === 'true',
    score: Number.isFinite(score) ? score : 0,
    reason: clip(v.reason || '', 120),
  };
}

// Classify a batch. Resolves {ok, results, ms, model} or {ok:false, error}.
// A failed batch is reported, never retried internally: the caller decides, and
// an internal retry loop on a 2,000-offer queue is how you turn a provider
// blip into a bill.
async function classifyBatch(offers, opts = {}) {
  if (!offers || !offers.length) return { ok: true, results: [], ms: 0 };
  const t0 = Date.now();
  let out;
  try {
    // Token budget, measured not guessed: gpt-oss-120b is a reasoning model, so
    // it spends part of max_tokens thinking before it emits anything. At
    // 90 tokens/offer a 10-offer batch ran out mid-generation and Groq rejected
    // the truncated output with 400 "Failed to generate JSON" -- which looks
    // like a bad prompt but is really a starved budget. 260/offer plus a floor
    // of 2048 leaves room for the reasoning trace and the verdicts themselves.
    out = await json(
      [{ role: 'system', content: SYSTEM }, { role: 'user', content: buildBatchPrompt(offers) }],
      { temperature: 0, maxTokens: Math.max(2048, offers.length * 260), timeoutMs: Number(opts.timeoutMs || 90000) },
    );
  } catch (e) {
    // Keep rate-limit detail intact. Groq's per-day (TPD) message puts the decisive
  // text ("Limit 200000, Used 199974 ... tokens per day") past 160 chars, so a
  // blunt truncation here made a dead-for-the-day quota indistinguishable from a
  // momentary per-minute throttle -- and the two need opposite handling.
  return {
    ok: false,
    error: String((e && e.message) || e).slice(0, 600),
    status: e && e.status,
    ms: Date.now() - t0,
  };
  }
  const v = validate(out.data, offers);
  if (!v.ok) return { ok: false, error: v.error, detail: v, ms: Date.now() - t0, model: out.model };
  const results = offers.map((o) => {
    const n = normalize(v.byId.get(String(o.id)));
    return { id: o.id, ...n };
  });
  return { ok: true, results, ms: Date.now() - t0, model: out.model, attempts: out.attempts, usage: out.usage, rl: out.rl || {} };
}

module.exports = { classifyBatch, buildBatchPrompt, validate, normalize, SYSTEM, PROFILE, clip };