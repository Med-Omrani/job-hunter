'use strict';
// Shared OpenAI-compatible chat client.
//
// Extracted from chat-bot.docker.js's llmPost(), which could not be reused as-is:
// it hardcodes LLM_TOOLS, temperature 0.7 and max_tokens 1024 for a conversational
// agent. Relevance classification needs the opposite -- no tools, temperature 0,
// a strict JSON object back -- so the transport is shared and the knobs are
// parameters. Keeping ONE client means the Groq key, timeout handling and
// model-fallback logic live in a single place.
//
// Failure semantics are deliberate and documented per method, because the two
// callers need opposite behaviour: the chat must never silently answer with
// nothing, while a batch classifier must skip a bad batch and keep going.

const DEFAULT_TIMEOUT_MS = 45000;

function loadDotEnv() {
  // Best-effort: the daemons run under monitor.js which loads .env, but scripts
  // run by hand (tests, one-shots) need it too. Never overwrites a real env var.
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join(__dirname, '..', '..', '.env');
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      const k = i > 0 ? s.slice(0, i).trim() : '';
      if (k && !process.env[k]) process.env[k] = s.slice(i + 1).trim();
    }
  } catch (_) {}
}
loadDotEnv();

const CFG = {
  base: (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
  model: process.env.LLM_MODEL || 'openai/gpt-oss-120b',
  fallback: process.env.LLM_FALLBACK_MODEL || 'qwen/qwen3.8-27b',
  key: process.env.LLM_API_KEY || '',
};

function hasKey() { return !!CFG.key; }
function config() { return { base: CFG.base, model: CFG.model, fallback: CFG.fallback, hasKey: hasKey() }; }

// POST /chat/completions with an explicit abort. Returns {json, ms, model}.
// Throws an Error carrying .status so callers can tell "rate limited / upstream
// broken" (retryable, maybe on the fallback model) from "our request was bad"
// (not retryable -- a malformed prompt will fail identically on the fallback).
async function post(messages, opts = {}) {
  if (!CFG.key) throw new Error('llm_no_key');
  const timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  const body = {
    model: opts.model || CFG.model,
    messages,
    max_tokens: Number(opts.maxTokens || 1024),
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.7,
  };
  if (opts.tools) { body.tools = opts.tools; body.tool_choice = opts.tool_choice || 'auto'; }
  if (opts.json) body.response_format = { type: 'json_object' };

  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(CFG.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CFG.key },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      // Keep enough of the body to identify WHICH limit was hit. Groq returns two
    // very different 429s -- per-minute TPM and per-day TPD -- and they need
    // opposite handling (seconds vs hours). Truncating to 200 chars reliably cut
    // the "Limit 200000, Used 199974 ... tokens per day (TPD)" tail off, leaving
    // callers unable to tell a momentary throttle from a dead-for-the-day quota.
    const e = new Error('llm_http_' + res.status + ' ' + text.slice(0, 600));
    e.status = res.status;
    throw e;
    }
    // Surface the provider's own quota headers. Groq's free tier answers with
    // x-ratelimit-limit-tokens / -remaining-tokens / -reset-tokens, which is the
    // only reliable way to pace a batch loop: without them the caller can only
    // react to 429s after the fact.
    const rl = {};
    for (const h of ['x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens',
      'x-ratelimit-reset-tokens', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests']) {
      const v = res.headers && res.headers.get(h);
      if (v !== null && v !== undefined) rl[h.replace('x-ratelimit-', '')] = Number(v);
    }
    return { json: JSON.parse(text), ms: Date.now() - t0, model: body.model, rl };
  } catch (e) {
    // Normalise the two failure shapes callers care about.
    if (e.name === 'AbortError') {
      const err = new Error('llm_timeout_' + timeoutMs);
      err.status = 504;
      throw err;
    }
    if (!e.status) e.status = 0;   // network/DNS/parse: retryable
    throw e;
  } finally {
    clearTimeout(tm);
  }
}

// Single request with automatic fallback-model retry on a retryable failure
// (429 / 5xx / network). Returns {content, model, ms, attempts}.
//
// A 400 is treated as fatal on purpose: it means the request itself is bad, so
// burning the fallback model on it just doubles the cost of a certain failure.
async function complete(messages, opts = {}) {
  const models = [opts.model || CFG.model];
  if (!opts.noFallback && CFG.fallback) models.push(CFG.fallback);
  let lastErr;
  for (let i = 0; i < models.length; i++) {
    try {
      const out = await post(messages, { ...opts, model: models[i] });
      const choice = out.json.choices && out.json.choices[0];
      const content = String((choice && choice.message && choice.message.content) || '').trim();
      return { content, model: models[i], ms: out.ms, attempts: i + 1, usage: out.json.usage || {}, rl: out.rl || {} };
    } catch (e) {
      lastErr = e;
      const retryable = e.status === 429 || (e.status >= 500 && e.status < 600) || e.status === 0;
      if (!retryable || i === models.length - 1) throw e;
    }
  }
  throw lastErr;
}

// Ask for a JSON object and return the parsed value.
//
// `openai/gpt-oss-120b` and the qwen fallback both honour response_format
// json_object, but they still occasionally wrap the object in prose or a fenced
// block, so extraction is attempted in decreasing order of confidence rather than
// trusting the format flag. Throws llm_bad_json when nothing parses -- callers on a
// batch path are expected to drop that batch, not to retry it into a storm.
function parseJsonLoose(text) {
  const s = String(text || '').trim();
  if (!s) throw new Error('llm_bad_json_empty');
  const candidates = [];
  // 1. fenced block, any tag or none
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  // 2. the outermost {...} span, brace-matched so nested objects survive
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(s.slice(first, last + 1));
  // 3. the whole thing
  candidates.push(s);
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object') return v;
    } catch (_) {}
  }
  throw new Error('llm_bad_json');
}

async function json(messages, opts = {}) {
  const out = await complete(messages, { ...opts, json: true });
  return { ...out, data: parseJsonLoose(out.content) };
}

module.exports = { CFG, hasKey, config, post, complete, json, parseJsonLoose, loadDotEnv };