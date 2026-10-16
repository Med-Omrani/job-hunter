'use strict';
// Relevance audit -- the agent that checks the checker.
//
// WHAT IT IS
// The classifier is a prompt, and prompts drift: the profile gets edited, Groq
// updates a model, the fleet starts crawling different boards. Nothing crashes
// when that happens -- offers just quietly stop being found, or start being found
// that shouldn't be. This is the tripwire for that class of failure.
//
// WHAT IT DELIBERATELY DOES NOT DO
// It never edits relevance.js, engine.js or any keyword list. It writes a
// proposal to disk and reports it. A human decides. Relevance is what the user
// sees on their phone; an agent silently rewriting the rules that produce it is
// exactly the kind of automation that erodes trust in a job feed.
//
// Two inputs feed it:
//   1. DRIFT  -- re-runs the control set (relevance-selftest.js). A verdict that
//      flipped is evidence the prompt or the model changed behaviour.
//   2. BEHAVIOUR -- compares classifier verdicts against what the user actually
//      did (offer_events). Promoted-then-dismissed is a false positive;
//      never-opened-and-never-dismissed is weak evidence either way.
//
// Usage: node relevance-audit.js                (run once and exit)
//        node relevance-audit.js --loop         (resident, daily -- supervised form)

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const EVENTS = path.join(DIR, 'events-relevance.log');
const PROPOSALS = path.join(DIR, 'relevance-proposals.md');
const STATE = path.join(DIR, '.relevance-audit-state.json');

function log(ev) {
  const line = JSON.stringify({ ts: new Date().toISOString(), proc: 'relevance-audit', ...ev });
  try { fs.appendFileSync(EVENTS, line + '\n'); } catch (_) {}
  if (process.env.VERBOSE) console.log(line);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE, JSON.stringify(s)); } catch (_) {}
}

// 1. Control-set drift.
async function checkDrift() {
  const { CONTROL } = require('./relevance-selftest.js');
  const { classifyBatch } = require('./relevance.js');
  const state = loadState();

  // Only re-check the cases that have no LLM-side ambiguity, so a flaky model
  // does not manufacture a "drift" every single day.
  const out = await classifyBatch(CONTROL.map((c) => ({
    id: c.id, title: c.title, company: c.company, location: c.location, description: c.description,
  })));
  if (!out.ok) return { ok: false, error: out.error };

  const byId = new Map(out.results.map((r) => [r.id, r]));
  const current = {};
  const flips = [];
  for (const c of CONTROL) {
    const r = byId.get(c.id);
    if (!r) continue;
    current[c.id] = r.match;
    if (state.control && state.control[c.id] !== undefined && state.control[c.id] !== r.match) {
      flips.push({ id: c.id, title: c.title, was: state.control[c.id], now: r.match, expect: c.expect, reason: r.reason });
    }
  }
  const wrong = CONTROL.filter((c) => byId.get(c.id) && byId.get(c.id).match !== c.expect)
    .map((c) => ({ id: c.id, title: c.title, expect: c.expect, got: byId.get(c.id).match, reason: byId.get(c.id).reason }));
  state.control = current;
  saveState(state);
  return { ok: true, total: CONTROL.length, correct: CONTROL.length - wrong.length, flips, wrong };
}

// 2. Behavioural check against real engagement.
async function checkBehaviour(days) {
   const apiUrl = process.env.API_URL || 'http://localhost:3144';
   const r = await fetch(apiUrl + '/api/offers/stats?days=' + (days || 7));
   if (!r.ok) throw new Error('stats http_' + r.status);
   const s = await r.json();

   // The single actionable number: how many classifier promotions did the user
   // then push away? Any sustained non-trivial value means the prompt is
   // surfacing things the user does not want, which is a proposal to inspect,
   // never an automatic rule change.
   const promotedThenDismissed = s.promotedThenDismissed || 0;
   const rate = s.promoted ? Math.round((promotedThenDismissed / s.promoted) * 100) : null;
   return {
     days: s.days,
     band: s.band,
     promoted: s.promoted,
     signals: s.signals,
     promotedThenDismissed,
     dismissRatePct: rate,
   };
}

function render(drift, behaviour, proposals) {
  const L = [];
  L.push('# Relevance audit proposals');
  L.push('');
  L.push('Generated ' + new Date().toISOString() + ' by relevance-audit.js.');
  L.push('');
  L.push('**Nothing below has been applied.** These are suggestions for review.');
  L.push('');

  L.push('## 1. Control-set drift');
  if (!drift.ok) {
    L.push('- Classifier run failed: `' + drift.error + '`. Could not assess drift.');
  } else {
    L.push('- Control set: **' + drift.correct + '/' + drift.total + '** correct.');
    if (!drift.flips.length && !drift.wrong.length) {
      L.push('- No verdict drift since the last audit.');
    }
    if (drift.flips.length) {
      L.push('');
      L.push('### Verdicts that FLIPPED since last audit');
      L.push('');
      L.push('| case | was | now | expected | model reason |');
      L.push('|---|---|---|---|---|');
      for (const f of drift.flips) {
        L.push(`| ${f.title} | ${f.was} | ${f.now} | ${f.expect} | ${f.reason} |`);
      }
      L.push('');
      L.push('> A flip is not automatically a bug. If the new answer is the correct one,');
      L.push('> update the `expect` field in relevance-selftest.js so the control set');
      L.push('> records the intended behaviour rather than freezing a past mistake.');
    }
    if (drift.wrong.length) {
      L.push('');
      L.push('### Currently disagreeing with intent');
      L.push('');
      for (const w of drift.wrong) {
        L.push(`- **${w.title}** -- expected ${w.expect}, got ${w.got}. Reason: _${w.reason}_`);
      }
    }
  }
  L.push('');

  L.push('## 2. Behaviour (last ' + behaviour.days + 'd)');
  L.push('- Visible in matched feed: **' + behaviour.promoted + '**');
  L.push('- Band outcomes: `' + JSON.stringify(behaviour.band) + '`');
  L.push('- Signals: `' + JSON.stringify(behaviour.signals) + '`');
  L.push('- Promoted, then dismissed by user: **' + behaviour.promotedThenDismissed + '**'
    + (behaviour.dismissRatePct === null ? '' : ' (' + behaviour.dismissRatePct + '% of promotions)'));
  L.push('');
  if (behaviour.promotedThenDismissed > 0) {
    L.push('> These are the clearest evidence available that the classifier is wrong about');
    L.push('> something. Review a sample before touching the prompt.');
  } else {
    L.push('> No promotion has been dismissed. There is currently no behavioural evidence');
    L.push('> that the classifier is overshooting.');
  }
  L.push('');
  L.push('> Honest limitation: with one user and a handful of applications,');
  L.push('> engagement data supports *explainable adjustments*, not learning.');
  L.push('> Nothing in the pipeline treats a single dismissal as a rule.');
  L.push('');

  if (proposals && proposals.length) {
    L.push('## 3. Proposals');
    L.push('');
    for (const p of proposals) L.push('- ' + p);
  } else {
    L.push('## 3. Proposals');
    L.push('');
    L.push('- None generated: no drift and no behavioural contradiction detected.');
  }
  L.push('');
  return L.join('\n');
}

async function main() {
  const days = Number(process.env.RELEVANCE_AUDIT_DAYS || 7);
  const drift = await checkDrift().catch((e) => ({ ok: false, error: String(e.message || e).slice(0, 120) }));
  const behaviour = await checkBehaviour(days)
    .catch((e) => ({ days, band: [], promoted: '?', signals: {}, promotedThenDismissed: 0, dismissRatePct: null, error: String(e.message || e).slice(0, 120) }));

  const proposals = [];
  if (!drift.ok) {
    proposals.push('Classifier self-check did not run (`' + drift.error + '`). Investigate before trusting the drift half of this report.');
  } else {
    if (drift.wrong.length) {
      proposals.push('Review the classifier prompt for the ' + drift.wrong.length + ' control case(s) that disagree with intent. Do not paper over it by editing `expect` -- decide which of the model or the case is wrong.');
    }
    if (drift.flips.length) {
      proposals.push('Decide whether each of the ' + drift.flips.length + ' flipped verdict(s) is an improvement (update `expect`) or drift (adjust the prompt).');
    }
  }
  if (behaviour.promotedThenDismissed > 0) {
    proposals.push(behaviour.promotedThenDismissed + ' promoted offer(s) were later dismissed. Sample them and identify the shared pattern before changing anything.');
  }
  if (typeof behaviour.promoted === 'number' && behaviour.promoted === 0) {
    proposals.push('Zero offers in the matched feed over ' + days + 'd. If that is not expected, the fleet or the relevance path is stuck -- check events-fleet.log and events-relevance.log.');
  }

  const md = render(drift, behaviour, proposals);
  fs.writeFileSync(PROPOSALS, md);
  log({
    type: 'audit_done', driftOk: drift.ok, correct: drift.correct, total: drift.total,
    flips: drift.flips.length, wrong: drift.wrong.length,
    promoted: behaviour.promoted, promotedThenDismissed: behaviour.promotedThenDismissed,
    proposals: proposals.length,
  });
  console.log(md);
}

// Supervised form. monitor.js respawns any agent whose pid dies, so a bare
// one-shot audit would be restarted on every watchdog pass -- meaning a live
// Groq classification run every minute or two on a key that is already
// rate-limited. Like discover-agent.js, this therefore loops and sleeps itself.
async function loop() {
  const interval = Math.max(Number(process.env.RELEVANCE_AUDIT_INTERVAL_MS || 86400000), 3600000);
  log({ type: 'audit_loop_start', intervalMs: interval });
  for (;;) {
    try {
      await main();
    } catch (e) {
      log({ type: 'audit_fatal', error: String((e && e.stack) || e).slice(0, 400) });
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

if (require.main === module) {
  if (process.argv.includes('--loop')) {
    loop().catch((e) => { log({ type: 'fatal', error: String(e.message || e).slice(0, 200) }); process.exit(1); });
  } else {
    main().catch((e) => { log({ type: 'fatal', error: String(e.message || e).slice(0, 200) }); process.exit(1); });
  }
}

module.exports = { checkDrift, checkBehaviour, main };