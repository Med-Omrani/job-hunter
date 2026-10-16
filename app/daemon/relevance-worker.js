'use strict';
// Relevance worker: the second opinion on offers the keyword engine rejected.
//
// LIFECYCLE
//   fleet  --(stores match=false, band='pending')-->  offers
//   worker --claims--> classifies in batches via Groq --> POSTs one verdict each
//   api    --promotes (match=true, band='promoted') or marks rejected
//
// SAFETY PROPERTIES, in order of importance
// 1. Nothing here can hide an offer that keywords already matched. This worker
//    only ever touches rows carrying band='pending', i.e. offers that were on
//    their way to being discarded forever. The worst failure mode is a missed
//    promotion, never a lost good lead.
// 2. A provider outage must not turn into a data-destroying loop. A failed batch
//    leaves its rows pending and increments bandTries; after MAX_TRIES they are
//    left alone rather than retried forever.
// 3. Every decision is logged with model, reason and score so a wrong verdict
//    can be traced back to the exact prompt that produced it.
//
// It runs as a supervised agent (see agents.json) and also supports --once for
// manual runs and dry runs.

const fs = require('fs');
const path = require('path');
const api = require('./api_client.js');
const { classifyBatch } = require('./relevance.js');
const { classifyLocal, ENGINE_ID: LOCAL_ENGINE } = require('./fallback-classifier.js');
const { tierZero } = require('./offer-gate.js');
const { hasKey, config } = require('./llm-client.js');

const DIR = __dirname;
const EVENTS = path.join(DIR, 'events-relevance.log');

function log(ev) {
  const line = JSON.stringify({ ts: new Date().toISOString(), proc: 'relevance', ...ev });
  try { fs.appendFileSync(EVENTS, line + '\n'); } catch (_) {}
  if (process.env.VERBOSE) console.log(line);
}

const BATCH_SIZE = Math.max(1, Number(process.env.RELEVANCE_BATCH || 10));
const MAX_TRIES = Math.max(1, Number(process.env.RELEVANCE_MAX_TRIES || 3));
const BATCH_PAUSE_MS = Math.max(0, Number(process.env.RELEVANCE_BATCH_PAUSE_MS || 1500));

// With the tier-0 gate on, a claim is not just model work: it is free work.
// The gate measures ~52% coverage, so a claim of BATCH_SIZE hands the model only
// about half the rows and leaves the other half decided at zero cost. Claiming a
// larger slice raises how much the free tier can clear per pass, which is what
// turns "the band stalled" into steady drainage. The model-side cost is still
// bounded by the token budget below, which decides how many rows actually reach
// a provider per pass regardless of claim size.
const GATE_CLAIM_MULT = Math.max(1, Number(process.env.RELEVANCE_GATE_CLAIM_MULT || 6));

// Hard wall-clock cap on one pass. Without it, a large claim against a provider
// that is down would loop over every chunk, sleeping between each, and hold the
// claim lease open far longer than the lease itself -- which starves the rows of
// their own lease and looks like a hang rather than backpressure.
//
// It is DERIVED FROM THE LEASE rather than configured independently, because the
// two must not drift: a pass that outlives its lease finishes writing verdicts
// for rows another worker is already free to claim, so those verdicts race and
// are lost. 60% of the lease leaves room for the in-flight write plus the sleep
// before the next pass.
//
// Identity for the claim lease, module-scoped so runPass() can use it. It
// includes the pid: a restarted worker must not inherit -- and immediately lose
// -- rows the previous process still holds.
const CLAIM_OWNER = 'rel-worker-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
const CLAIM_LEASE_SEC = Math.max(120, Math.ceil((Number(process.env.RELEVANCE_INTERVAL_MS || 300000) / 1000) * 2));
const PASS_BUDGET_MS = Math.max(
  60000,
  Number(process.env.RELEVANCE_PASS_BUDGET_MS || Math.floor(CLAIM_LEASE_SEC * 1000 * 0.6))
);
const PASS_DEADLINE = () => Date.now() + PASS_BUDGET_MS;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// One pass: claim a slice, classify it, apply verdicts, prune expired.
// Returns a summary so both the loop and --once report the same numbers.
// One classify call, normalised so the caller can treat every chunk the same.
async function classifyChunk(chunk, opts) {
  try {
    const r = await classifyBatch(chunk, opts);
    if (r.ok) return { ok: true, results: r.results, model: r.model, usage: r.usage, ms: r.ms };
    return { ok: false, error: r.error, status: r.status || 0, detail: r.detail || null };
  } catch (e) {
    // Truncate generously: the TPD text that distinguishes a dead-for-the-day quota
  // from a momentary throttle sits past 160 chars, so a short cut here erases it.
  return { ok: false, error: String((e && e.message) || e).slice(0, 600), status: (e && e.status) || 0 };
  }
}

// Tier-0 deterministic gate, and the only place in this worker that writes a
// verdict without a model.
//
// WHY IT RUNS FIRST, ON EVERY PASS
// Groq's free tier stopped the band dead: the whole 11k backlog was sitting
// waiting on a quota that was routinely exhausted, so the pipeline's real
// bottleneck was not model quality, it was the number of offers that needed a
// model at all. Measured against the 1,087 offers the LLM had already decided,
// the gate (location + seniority + family veto) is 563/563 correct with zero
// promotions deleted -- 100% precision over 51.8% of previously-decided rows.
// Those rows therefore never enter the token budget, never consume bandTries,
// and keep draining the queue even with no provider key configured.
//
// ONE-SIDED BY CONSTRUCTION
// tierZero() cannot promote. A rule-based promotion stamped as authoritative is
// the failure this pipeline spent a session eliminating, and the promote rule
// measured 17.6% precision. A row the gate is unsure about is passed to the
// model, untouched.
const GATE_ENGINE = 'gate-v1';

function gateEnabled() {
  // RELEVANCE_LOCAL_FALLBACK is kept as a legacy alias so an existing deployment
  // that disabled the old fallback keeps the old behaviour.
  const v = process.env.RELEVANCE_TIER0_GATE;
  if (v !== undefined && v !== '') return v !== '0';
  const legacy = process.env.RELEVANCE_LOCAL_FALLBACK;
  return !(legacy === '0');
}

// Applies the gate to `rows` and writes a verdict for every rejection.
// Returns the rows the model still needs to see.
async function applyTierZeroGate(rows) {
  const out = { enabled: gateEnabled(), offered: rows.length, rejected: 0, passed: [], errors: [], byRule: {} };
  if (!out.enabled) {
    out.passed = rows.slice();
    log({ type: 'tier0_disabled', count: rows.length });
    return out;
  }
  for (const o of rows) {
    let v;
    try {
      v = tierZero({ title: o.title, description: o.description, location: o.location, country: o.country });
    } catch (e) {
      out.errors.push('gate_failed:' + o.id);
      // Never let a rule failure become a deletion. Pass it to the model.
      out.passed.push(o);
      continue;
    }
    if (v.verdict !== 'reject') { out.passed.push(o); continue; }
    for (const r of v.rules) out.byRule[r] = (out.byRule[r] || 0) + 1;
    try {
      await api.bandVerdict({
        id: o.id, match: false, score: 0,
        reason: GATE_ENGINE + '[' + v.rules.join('+') + ']: ' + v.reason,
        model: GATE_ENGINE,
      });
      out.rejected++;
      log({ type: 'gate_rejected', id: o.id, rules: v.rules, title: String(o.title || '').slice(0, 90), reason: v.reason });
    } catch (e) {
      out.errors.push('verdict_failed:' + o.id);
      out.passed.push(o);
    }
  }
  log({
    type: 'tier0_gate', engine: GATE_ENGINE, offered: out.offered, rejected: out.rejected,
    passedToModel: out.passed.length, byRule: out.byRule, errors: out.errors.length,
    note: 'deterministic rejects written before any model call; promotions impossible',
  });
  return out;
}

// Legacy path: the pre-gate behaviour, where the rule only ran once the provider
// had already failed. Retained so that RELEVANCE_TIER0_GATE=0 reproduces the
// old timing exactly rather than silently changing when verdicts are written.
async function applyLocalFallback(rows) {
  const out = { applied: 0, rejected: 0, unsure: 0, promoted: 0, errors: [] };
  if (process.env.RELEVANCE_LOCAL_FALLBACK === '0') {
    log({ type: 'local_fallback_disabled', count: rows.length });
    return out;
  }
  for (const o of rows) {
    let v;
    try {
      v = classifyLocal({ title: o.title, description: o.description });
    } catch (e) {
      out.errors.push('classify_failed:' + o.id);
      continue;
    }
    if (v.verdict === 'unsure') { out.unsure++; continue; }
    if (v.verdict === 'promote') { out.promoted++; continue; } // unreachable by default
    try {
      await api.bandVerdict({
        id: o.id, match: false, score: 0,
        reason: LOCAL_ENGINE + ': ' + v.reasons.join('; '),
        model: LOCAL_ENGINE,
      });
      out.applied++;
      out.rejected++;
    } catch (e) {
      out.errors.push('verdict_failed:' + o.id);
    }
  }
  log({
    type: 'local_fallback', engine: LOCAL_ENGINE, offered: rows.length,
    rejected: out.rejected, unsure: out.unsure, promotionsWithheld: out.promoted,
    errors: out.errors.length,
    note: 'provider unavailable; one-sided local reject applied, promotions withheld',
  });
  return out;
}

async function runPass(opts = {}) {
  const summary = { claimed: 0, judged: 0, promoted: 0, rejected: 0, failed: 0, throttled: false, dailyExhausted: false, errors: [] };

  let pending;
  // The claim is sized by whether the gate will run, because that decides how
  // much of the slice is real work versus free work.
  const claimSize = gateEnabled() ? BATCH_SIZE * GATE_CLAIM_MULT : BATCH_SIZE;
  const passDeadline = PASS_DEADLINE();
  try {
    // Identify this worker in the claim so the API can lease the rows to it.
    pending = await api.listBandPending(claimSize, CLAIM_OWNER, CLAIM_LEASE_SEC);
  } catch (e) {
    summary.errors.push('claim_failed:' + String((e && e.message) || e).slice(0, 120));
    log({ type: 'claim_error', error: String((e && e.message) || e).slice(0, 300) });
    return summary;
  }
  if (!pending.length) { log({ type: 'idle' }); return summary; }

  // Give up on rows the model keeps failing to judge, rather than paying for
  // them on every pass forever.
  const workable = pending.filter((o) => Number(o.bandTries || 0) < MAX_TRIES);
  const exhausted = pending.filter((o) => Number(o.bandTries || 0) >= MAX_TRIES);
  for (const o of exhausted) {
    log({ type: 'band_exhausted', id: o.id, tries: o.bandTries, title: String(o.title).slice(0, 90) });
  }
  if (!workable.length) { log({ type: 'idle_all_exhausted', count: exhausted.length }); return summary; }

  summary.claimed = workable.length;

  // Tier-0 gate, BEFORE the provider is even consulted.
  //
  // This is ordered ahead of hasKey() on purpose. Half the ambiguous band is
  // decidable by rule with measured 100% precision, and those decisions cost no
  // quota, need no API key, and cannot be blocked by an outage. Checking for a
  // key first would have skipped all of that work on exactly the days the
  // provider is broken.
  const gate = await applyTierZeroGate(workable);
  summary.local = gate;
  summary.rejected += gate.rejected;
  const modelable = gate.passed;
  if (!modelable.length) {
    log({ type: 'tier0_drained_pass', claimed: workable.length, rejected: gate.rejected, note: 'no rows left for the model' });
    return summary;
  }

  if (!hasKey()) {
    summary.errors.push('no_llm_key');
    log({ type: 'skipped', reason: 'no_llm_key', gateRejected: gate.rejected, remainingForModel: modelable.length });
    return summary;
  }

  // Bound the request by TOKENS, not by offer count.
  //
  // Measured against Groq's free tier: 8000 tokens/min, and a rolling window
  // that refills in ~600ms. Offers average ~3KB of description, so 25 of them is
  // ~19k prompt tokens -- 2.4x the entire per-minute allowance in one request.
  // That single call can never succeed regardless of backoff, which is exactly
  // the stall that was observed (repeated 429s at batch 25).
  //
  // So each chunk is sized to fit the allowance, and consecutive chunks wait out
  // the window.
  //
  // charsPerToken is MEASURED, not guessed: real calls in this pipeline report
  // 7423 prompt tokens for an 18720-char payload, i.e. ~2.52 chars/token. An
  // earlier 3.6 estimate under-counted tokens by 1.43x, which made every chunk
  // look affordable and produced an unbroken run of 429s. Descriptions are HTML
  // scraped from Workday/Greenhouse, which is denser than prose.
  let tokenBudget = Math.max(1000, Number(process.env.RELEVANCE_TOKEN_BUDGET || 6500));
  let tokenBudgetLive = tokenBudget;
  const charsPerToken = Number(process.env.RELEVANCE_CHARS_PER_TOKEN || 2.5);
  const payload = (arr) => arr.reduce((n, o) => n + String(o.description || '').length + String(o.title || '').length, 0);
  const estimateTokens = (arr) => Math.ceil(payload(arr) / charsPerToken) + 400; // + completion
  // Sized so that the NEXT chunk plus the one just sent still fit inside the
  // per-minute window, i.e. ~half the budget rather than all of it.
  const budgetChars = Math.max(3000, Number(
    process.env.RELEVANCE_BATCH_CHARS || Math.floor((tokenBudget / 2) * charsPerToken)
  ));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let rlResetMs = 0;
  let tokensSpentThisMinute = 0;
  let quotaModel = '';
  // The window refills in well under a second on this tier, so a fixed short
  // pause is enough; the header value is used when the provider supplies one.
  const minResetMs = 1500;
  const chunks = [];
  for (const o of modelable) {
    // Append to the CURRENT last chunk. Indexing chunks[chunks.length] here
    // would create a fresh chunk per offer and turn one batched call into N
    // single-offer calls -- the opposite of what the budget is for.
    const last = chunks[chunks.length - 1];
    if (last && payload(last) + payload([o]) > budgetChars) chunks.push([o]);
    else if (last) last.push(o);
    else chunks.push([o]);
  }
  if (chunks.length > 1) {
    log({ type: 'batch_split', parts: chunks.length, chars: payload(modelable), budgetChars });
  }

  const verdicts = [];
  const models = new Set();
  let lastErr = null;
  let lastStatus = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];

    // Wall-clock guard. A pass that has run its course ends here rather than
    // grinding through the remaining chunks against a provider that is down.
    if (Date.now() > passDeadline) {
      const deferredChunks = chunks.length - ci;
      const deferredRows = chunks.slice(ci).reduce((n, c) => n + c.length, 0);
      log({
        type: 'pass_budget_exhausted', budgetMs: PASS_BUDGET_MS, doneChunks: ci,
        totalChunks: chunks.length, deferredChunks, deferredRows,
        note: 'rows deferred with lease untouched; next pass reclaims them',
      });
      summary.budgetExhausted = true;
      summary.deferredRows = (summary.deferredRows || 0) + deferredRows;
      break;
    }

    // Pace against the provider's own quota, measured rather than guessed.
    //
    // Groq free tier (verified via response headers): 8000 tokens/min, rolling
    // window that refills in well under a second. A batch of 25 Workday offers
    // is ~19k prompt tokens -- over budget on its own, so no amount of waiting
    // makes that single request succeed. Hence: keep each chunk under
    // tokenBudget, and wait out the window between chunks so the sum stays
    // inside the per-minute allowance.
    const waitMs = tokensSpentThisMinute + estimateTokens(chunk) > tokenBudgetLive
      ? Math.max(minResetMs, rlResetMs) : 0;
    if (waitMs > 0) {
      log({ type: 'quota_wait', waitMs, spent: tokensSpentThisMinute, estNext: estimateTokens(chunk), budget: tokenBudgetLive });
      await sleep(waitMs);
      tokensSpentThisMinute = 0;
      rlResetMs = 0;
    }

    const r = await classifyChunk(chunk, opts);
    if (r.ok) {
      verdicts.push(...r.results);
      if (r.model) models.add(r.model);
      summary.promptT = (summary.promptT || 0) + ((r.usage && r.usage.prompt_tokens) || 0);
      summary.completionT = (summary.completionT || 0) + ((r.usage && r.usage.completion_tokens) || 0);
      summary.ms = (summary.ms || 0) + (r.ms || 0);

      // Track spend against the shared org window, using the provider's own
      // numbers rather than the estimate. Headers report the window for the
      // model that just answered; the primary and the fallback draw on the
      // same 8000/min org allowance (verified by probing each directly), so
      // remaining-tokens from either is the honest measure of what is left. A
      // 429 from one model while the other still shows budget means the window
      // is spent -- not that the model itself is broken.
      if (r.rl && r.rl['limit-tokens']) {
        tokenBudgetLive = r.rl['limit-tokens'];
        if (typeof r.rl['reset-tokens'] === 'number') rlResetMs = r.rl['reset-tokens'];
        if (typeof r.rl['remaining-tokens'] === 'number') {
          tokensSpentThisMinute = Math.max(0, tokenBudgetLive - r.rl['remaining-tokens']);
          quotaModel = r.model || quotaModel;
          if (tokensSpentThisMinute >= tokenBudgetLive * 0.8) {
            log({
              type: 'quota_low', remaining: r.rl['remaining-tokens'], limit: tokenBudgetLive,
              model: quotaModel, spent: tokensSpentThisMinute,
            });
          }
        }
      } else {
        tokensSpentThisMinute += (r.usage && (r.usage.prompt_tokens + r.usage.completion_tokens)) || estimateTokens(chunk);
      }
      lastStatus = 0;
      continue;
    }
    lastErr = r.error; lastStatus = r.status || lastStatus;
    // Size errors are recoverable by splitting; anything else is not.
    if (r.status === 413 && chunk.length > 1) {
      const mid = Math.ceil(chunk.length / 2);
      for (const half of [chunk.slice(0, mid), chunk.slice(mid)]) {
        const h = await classifyChunk(half, opts);
        if (h.ok) {
          verdicts.push(...h.results);
          if (h.model) models.add(h.model);
          summary.promptT = (summary.promptT || 0) + ((h.usage && h.usage.prompt_tokens) || 0);
          summary.completionT = (summary.completionT || 0) + ((h.usage && h.usage.completion_tokens) || 0);
          summary.ms = (summary.ms || 0) + (h.ms || 0);
          lastStatus = 0;
        }
        else { lastErr = h.error; lastStatus = h.status || lastStatus; log({ type: 'half_failed', size: half.length, error: h.error, status: h.status || 0 }); }
      }
    } else {
      log({ type: 'chunk_failed', size: chunk.length, error: r.error, status: r.status || 0 });
    }
  }

  // Partial success is normal under throttling: the rows that failed stay
  // pending and are retried next pass. Say so explicitly, because a silent
  // partial pass is indistinguishable from a healthy one in the counters.
  if (verdicts.length && verdicts.length < modelable.length) {
    log({ type: 'pass_partial', judged: verdicts.length, of: modelable.length, status: lastStatus });
  }

  if (!verdicts.length) {
    summary.failed = modelable.length;
    const batch = { ok: false, error: lastErr || 'no_verdicts', status: lastStatus };
    log({ type: 'batch_failed', error: batch.error, count: modelable.length, status: batch.status || 0, detail: batch.detail || null });

    // A 429 whose body blames tokens-per-day is a quota wall, not throttling.
    // Groq reports this distinctly ("Limit 200000, Used 199974 ... try again in
    // 22.464s"), and the minute-scale retry ladder cannot help: the window is
    // hours long. Flagged so the supervisor can pause instead of spinning.
    if (batch.status === 429 && /tokens per day|\bTPD\b/i.test(String(batch.error || ''))) {
      summary.dailyExhausted = true;
      summary.throttled = true;
      const used = (String(batch.error).match(/Used (\d+)/) || [])[1];
      const lim = (String(batch.error).match(/Limit (\d+)/) || [])[1];
      log({ type: 'quota_tpd', used, limit: lim, note: 'daily token quota exhausted; rows untouched' });
    }

    // A provider failure is NOT a judgement failure. Recording a verdict here
    // would increment bandTries, and after MAX_TRIES the row would be abandoned
    // as "unjudgeable" -- meaning a Groq rate limit would silently destroy
    // candidates that were never actually assessed. Observed live: both the
    // primary and the fallback model returned 429 and the rows were being
    // marked exhausted for a reason that had nothing to do with the offers.
    //
    // So: leave the rows completely untouched and report the throttle. Only a
    // structurally invalid reply (bad/missing/duplicate ids) counts as a failed
    // attempt, because that is the model genuinely failing to do the job.
    const st = batch.status || 0;
    const throttle = st === 429 || st === 504 || st === 0 || st >= 500;
    const malformed = batch.error === 'no_verdicts_array'
      || batch.error === 'missing_ids' || batch.error === 'unknown_ids'
      || batch.error === 'duplicate_id';
    if (malformed) {
      for (const o of modelable) {
        try {
          await api.bandVerdict({ id: o.id, match: false, score: 0, reason: 'unparseable:' + batch.error, model: '' });
        } catch (_) {}
      }
      log({ type: 'batch_malformed_counted', error: batch.error, count: modelable.length });
    } else {
      summary.throttled = true;
      summary.errors.push(batch.error);
      log({ type: 'batch_throttled', status: st, error: batch.error, count: modelable.length, note: 'rows untouched, will retry' });
      // The rows still stay untouched -- a throttle is not a judgement.
      //
      // The outage fallback is only needed when the tier-0 gate is OFF. With the
      // gate on, these rows already passed it, and the legacy rule is a strict
      // subset of the gate's family rule, so re-running it here can only reject
      // things the gate just declined to reject. Running it anyway would be
      // double work that produces no new decisions.
      if (!gate.enabled) {
        summary.localFallback = await applyLocalFallback(modelable);
      } else {
        log({ type: 'throttle_gate_already_applied', rows: modelable.length, note: 'tier-0 ran before the model; nothing new left to rule on' });
      }
    }
    return summary;
  }

  const batch = { ok: true, results: verdicts, model: [...models].join('+') || 'unknown' };

  for (const v of batch.results) {
    try {
      await api.bandVerdict({ id: v.id, match: v.match, score: v.score, reason: v.reason, model: batch.model || '' });
      summary.judged++;
      if (v.match) summary.promoted++; else summary.rejected++;
      log({
        type: v.match ? 'band_promoted' : 'band_rejected',
        id: v.id, score: v.score, reason: v.reason, model: batch.model,
        tries: Number((modelable.find((o) => o.id === v.id) || {}).bandTries || 0) + 1,
      });
    } catch (e) {
      summary.errors.push('verdict_failed:' + v.id);
      log({ type: 'verdict_error', id: v.id, error: String((e && e.message) || e).slice(0, 120) });
    }
  }

  // Half-failed pass: some chunks got through and some were throttled, so the
  // rows the throttled chunks were carrying got no verdict at all. Observed live
  // on Groq's daily quota, where the window reopened just enough for 1 of 13
  // chunks -- 1 row judged, 24 left holding their claim until the lease expired.
  //
  // With the gate on there is nothing to do here: these rows already went through
  // tier-0 and were passed to the model, so re-running a rule over them would
  // second-guess a decision the gate deliberately declined to make. They simply
  // wait for the next pass with their tries and lease untouched.
  const answered = new Set(batch.results.map((v) => v.id));
  const unanswered = modelable.filter((o) => !answered.has(o.id));
  const throttledNow = lastStatus === 429 || lastStatus === 504 || lastStatus === 0 || lastStatus >= 500;
  if (unanswered.length && throttledNow) {
    log({ type: 'pass_half_throttled', unanswered: unanswered.length, judged: batch.results.length, status: lastStatus });
    if (!gate.enabled) {
      // Legacy behaviour preserved for deployments that turned the gate off.
      summary.localFallback = await applyLocalFallback(unanswered);
    } else {
      log({ type: 'unanswered_wait_for_next_pass', count: unanswered.length });
    }
  }

  log({
    type: 'pass_done', ...summary, model: batch.model, ms: null,
    promptT: summary.promptT || 0, completionT: summary.completionT || 0, chunks: chunks.length,
  });
  return summary;
}

async function main() {
  const once = process.argv.includes('--once');
  const dry = process.argv.includes('--dry-run');
  const limit = Number((process.argv.find((a) => a.startsWith('--passes=')) || '').split('=')[1] || 1);

  if (dry) {
    const pending = await api.listBandPending(BATCH_SIZE);
    console.log(JSON.stringify({
      dryRun: true, pending: pending.length, model: config().model, hasKey: hasKey(),
      wouldJudge: pending.filter((o) => Number(o.bandTries || 0) < MAX_TRIES).map((o) => ({
        id: o.id, title: String(o.title).slice(0, 80), company: o.company, descLen: String(o.description || '').length,
      })),
    }, null, 2));
    return;
  }

  if (once) {
    for (let i = 0; i < Math.max(1, limit); i++) {
      const s = await runPass();
      console.log(JSON.stringify(s));
      if (!s.claimed) break;
      if (i + 1 < limit) await sleep(BATCH_PAUSE_MS);
    }
    try { const p = await api.pruneBand(); log({ type: 'pruned', ...p }); } catch (_) {}
    return;
  }

  // Supervised mode: a slow drip. The band grows by thousands per sweep, so
  // draining it in a tight loop would spend the whole Groq quota in minutes and
  // rate-limit. This keeps cost proportional to value.
  const intervalMs = Math.max(60000, Number(process.env.RELEVANCE_INTERVAL_MS || 300000));
  log({ type: 'relevance_worker_start', model: config().model, intervalMs, batch: BATCH_SIZE });
  // Provider backoff. Groq rate-limits per model, and both the primary and the
  // fallback can return 429 at once. Without this the worker keeps hammering a
  // throttled endpoint every interval and every call fails, which is how a rate
  // limit turns into a backlog that never drains.
  let backoffUntil = 0;
  let backoffMs = 0;
  const tick = async () => {
    if (Date.now() < backoffUntil) { log({ type: 'backoff_wait', remainingMs: backoffUntil - Date.now() }); return; }
    try {
      const s = await runPass();
      // Daily quota exhaustion is a different animal from per-minute throttling:
      // it resets in hours, not seconds, so the minute-scale ladder below would
      // just keep hammering a wall and burning the backlog's patience. Pause for
      // an hour and say why.
      if (s.dailyExhausted) {
        backoffUntil = Date.now() + 60 * 60 * 1000;
        log({ type: 'quota_daily_exhausted', resumeInMs: 3600000, note: 'provider TPD limit reached; paused 1h' });
        return;
      }
      if (s.throttled) {
        backoffMs = backoffMs ? Math.min(backoffMs * 2, 30 * 60000) : 60000;
        backoffUntil = Date.now() + backoffMs;
        log({ type: 'backoff_engaged', backoffMs });
      } else if (backoffMs) {
        log({ type: 'backoff_cleared', wasMs: backoffMs });
        backoffMs = 0; backoffUntil = 0;
      }
    } catch (e) {
      log({ type: 'pass_error', error: String((e && e.message) || e).slice(0, 160) });
    }
  };
  await tick();
  setInterval(tick, intervalMs);
}

if (require.main === module) {
  main().catch((e) => { log({ type: 'fatal', error: String((e && e.message) || e).slice(0, 200) }); process.exit(1); });
}

module.exports = { runPass };