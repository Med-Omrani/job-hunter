'use strict';
// batch-apply.js — OFFER POLLER / TASK PRODUCER. Never submits.
//
// History: this file used to call driver.preview() + driver.submit() directly,
// in parallel with apply-worker.docker.js. That created a SECOND, ungated
// submit lane with three real bugs (master CV attached as the cover letter,
// a TDZ ReferenceError on `board` swallowed by a bare catch, and a dead
// docs-missing branch because path.join() never returns '').
//
// Now the ONLY submitter is apply-worker.docker.js, which enforces the
// pre-authorized gate (action=auto_apply + no unanswered fields + no form
// errors + CV attached + no captcha/auth wall + host jail + daily cap).
// This file's whole job: pick eligible offers and queue a task per offer with
// a DETERMINISTIC id, so re-polling collides on the tasks upsert instead of
// creating duplicate applications.
const fs = require('fs');
const path = require('path');
const api = require('./api_client.js');
const driver = require('./apply-driver.js');
const autoFlow = require('./auto-apply-flow.js');
const linkedinBot = require('./linkedin-bot.js');
const stealth = require('./stealth.js');

const DIR = __dirname;
const CONF = path.join(DIR, 'auto-postule.config.json');

let running = false;
let stopped = false;
let batchLog = [];

// Offers currently in flight: ref -> taskId. Prevents the 30s poll from
// re-queuing an offer whose task is still queued/in_progress.
const inFlight = new Map();

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONF, 'utf8')); }
  // Fail CLOSED: an unreadable/corrupt config must never re-enable
  // auto-postulation. The default used to be enabled:true, which meant a
  // malformed file silently armed real submissions.
  catch (_) { return { enabled: false, dailyCap: 20, batch: {}, linkedin: {} }; }
}

function logEntry(entry) {
  batchLog.push({ ts: new Date().toISOString(), ...entry });
  if (batchLog.length > 500) batchLog = batchLog.slice(-500);
  try { fs.writeFileSync(path.join(DIR, 'batch-apply.log'), JSON.stringify(batchLog, null, 2)); } catch (_) {}
}

// Deterministic task id: POST /api/tasks upserts on id (api/server.js), so the
// same offer always maps to the same task row — idempotent by construction.
function applyTaskId(offerRef) { return 'auto-' + offerRef; }

function isAutoAction(action) {
  const a = String(action || '').toLowerCase();
  return a === 'auto_apply' || a === 'autopostule' || a === 'auto-postule';
}

// Only 'new' offers: never re-apply to an already-applied/archived one.
async function getEligibleOffers() {
  if (!autoFlow.isAutoApplyEnabled()) return [];
  try {
    const all = await api.listOffers({ limit: 500 });
    return all.filter((o) => isAutoAction(o.action) && o.status === 'new' && !inFlight.has(String(o.ref || o.id || '')));
  } catch (e) {
    logEntry({ type: 'eligible_fetch_error', error: String((e && e.message) || e).slice(0, 140) });
    return [];
  }
}

// Fetch the TAILORED cv-<ref> / lettre-<ref> from the API. Returns real paths
// or empty strings. Never falls back to the master CV: a master CV submitted as
// a tailored application is worse than no application.
async function fetchDocs(offerRef, offerId) {
  const out = { cv: '', lettre: '', missing: [] };
  if (!offerRef) { out.missing.push('offer ref absent'); return out; }
  const runD = path.join(DIR, '.apply-runs', 'batch-' + offerRef);
  try { fs.mkdirSync(runD, { recursive: true }); } catch (_) {}
  for (const [kind, docId, name] of [['cv', 'cv-' + offerRef, 'cv.pdf'], ['lettre', 'lettre-' + offerRef, 'lettre.pdf']]) {
    try {
      const buf = await api.docPdf(docId);
      if (!buf || !buf.length) { out.missing.push(kind + ' vide'); continue; }
      const p = path.join(runD, name);
      fs.writeFileSync(p, buf);
      out[kind] = p;
    } catch (e) {
      out.missing.push(kind + ' absent');
    }
  }
  void offerId;
  return out;
}

async function hasPendingTask(match) {
  try {
    const tasks = await api.listTasks({ limit: 100 });
    return tasks.some((t) => match(t) && ['queued', 'in_progress', 'confirmed', 'awaiting_confirm', 'needs_info'].includes(t.status));
  } catch (_) { return false; }
}

async function processOneOffer(offer) {
  const offerRef = String(offer.ref || offer.id || '');
  const board = driver.detectBoard(offer); // hoisted: no TDZ, used in every branch
  const base = { offerId: offer.id || offerRef, title: offer.title, board };

  // Manual/outbound boards are not our job to submit.
  if (board === 'manual' && !String(offer.applyUrl || '').trim()) {
    return { ...base, queued: false, reason: 'manual_board' };
  }

  const docs = await fetchDocs(offerRef, offer.id);
  if (!docs.cv) {
    // Documents are not ready: queue exactly ONE tailoring task and defer.
    // task-worker auto-chains an apply task once the CV+letter exist.
    if (!await hasPendingTask((t) => /adapt/i.test(String(t.request || '')) && String(t.request || '').includes(offerRef))) {
      try {
        await api.createTask({
          id: 'tailor-auto-' + offerRef,
          kind: 'adapter',
          request: 'adapter ' + offerRef,
          status: 'queued',
          offerRef,
          offerId: offer.id,
          createdAt: new Date().toISOString(),
          autoChained: true,
        });
        logEntry({ ...base, queued: false, reason: 'docs_missing_tailor_queued' });
        return { ...base, queued: false, reason: 'docs_missing_tailor_queued' };
      } catch (e) {
        const err = 'tailor_queue_failed: ' + String((e && e.message) || e).slice(0, 120);
        logEntry({ ...base, queued: false, reason: err });
        return { ...base, queued: false, reason: err };
      }
    }
    logEntry({ ...base, queued: false, reason: 'docs_missing_already_queued' });
    return { ...base, queued: false, reason: 'docs_missing_already_queued' };
  }

  const taskId = applyTaskId(offerRef);
  if (inFlight.has(offerRef)) return { ...base, queued: false, reason: 'already_in_flight' };
  inFlight.set(offerRef, taskId);
  try {
    const t = await api.createTask({
      id: taskId,
      kind: 'apply',
      request: 'auto_apply ' + offerRef,
      key: 'auto-postule',
      from: 'batch-apply',
      status: 'queued',
      action: 'auto_apply',
      offerRef,
      offerId: offer.id,
      board,
      cvPath: docs.cv,
      lettrePath: docs.lettre,
      createdAt: new Date().toISOString(),
    });
    logEntry({ ...base, queued: true, taskId: t.id || taskId });
    return { ...base, queued: true, taskId: t.id || taskId };
  } catch (e) {
    const err = 'apply_queue_failed: ' + String((e && e.message) || e).slice(0, 120);
    logEntry({ ...base, queued: false, reason: err });
    return { ...base, queued: false, reason: err };
  }
}

async function runBatch() {
  if (!autoFlow.isAutoApplyEnabled()) {
    return { status: 'auto_apply_frozen', processed: 0, queued: 0, skipped: 0, results: [] };
  }
  if (running) return { status: 'already_running' };
  running = true;
  stopped = false;
  const config = loadConfig();
  const result = { startedAt: new Date().toISOString(), processed: 0, queued: 0, skipped: 0, results: [] };
  let budget = { applied: 0, cap: config.dailyCap || 20, remaining: config.dailyCap || 20 };

  try {
    budget = await autoFlow.countTodayApplied();
    if (budget.remaining <= 0) {
      result.status = 'daily_cap_reached';
      result.applied = budget.applied;
      result.cap = budget.cap;
      return result;
    }
    const offers = await getEligibleOffers();
    const maxBatch = Math.min(offers.length, budget.remaining, config.batch?.maxBatch || 5);
    for (const offer of offers.slice(0, maxBatch)) {
      if (stopped) { result.status = 'stopped'; break; }
      try {
        const r = await processOneOffer(offer);
        result.results.push(r);
        result.processed++;
        if (r.queued) result.queued++;
        else result.skipped++;
        logEntry(r);
      } catch (e) {
        result.skipped++;
        logEntry({ offerId: offer.id || offer.ref, error: String((e && e.message) || e).slice(0, 200) });
      }
      // Yield between offers: one queueing pass is cheap, but never stampede.
      try { await stealth.humanDelay(8000, 20000); } catch (_) {}
    }
  } catch (e) {
    result.error = String((e && e.message) || e).slice(0, 200);
  }

  result.completedAt = new Date().toISOString();
  result.remaining = Math.max(0, budget.remaining - result.queued);
  running = false;
  return result;
}

// Release in-flight locks for tasks that finished, so the next poll can pick up
// offers that failed and were retried by apply-worker.
async function reapInFlight() {
  if (!inFlight.size) return;
  try {
    const tasks = await api.listTasks({ status: 'done', limit: 100 });
    const done = new Set(tasks.map((t) => String(t.id || '')));
    const failed = new Set();
    try {
      const ft = await api.listTasks({ status: 'failed', limit: 100 });
      for (const t of ft) failed.add(String(t.id || ''));
    } catch (_) {}
    for (const [ref, tid] of Array.from(inFlight.entries())) {
      if (done.has(tid) || failed.has(tid)) inFlight.delete(ref);
    }
  } catch (_) {}
}

function stopBatch() {
  stopped = true;
  return { ok: true };
}

function getBatchStatus() {
  return { running, stopped, inFlight: Array.from(inFlight.keys()), log: batchLog.slice(-50), config: loadConfig() };
}

async function startAutoApplyOnBoot() {
  const config = loadConfig();
  if (!config.enabled) return { ok: false, skipped: true, reason: 'auto-postule disabled' };
  return runBatch();
}

function startPeriodicPoll() {
  const config = loadConfig();
  const interval = (config.batch && config.batch.pollIntervalMs) || 30000;
  setInterval(() => {
    if (running) return;
    reapInFlight().catch(() => {});
    runBatch().catch((e) => logEntry({ error: String((e && e.message) || e).slice(0, 200) }));
  }, interval);
}

function start() {
  if (!autoFlow.isAutoApplyEnabled()) {
    logEntry({ status: 'auto_apply_frozen', note: 'poller not started (auto-postule.config.json enabled=false)' });
    return { ok: false, skipped: true, reason: 'auto_apply_frozen' };
  }
  startPeriodicPoll();
  runBatch().catch((e) => logEntry({ error: String((e && e.message) || e).slice(0, 200) }));
  console.log('autopostule poller running (queue-only; apply-worker performs submissions)');
  return { ok: true };
}

// Keep the process alive ONLY while the poller is actually armed. Previously
// this was at module scope, so merely requiring the file hung the process.
if (autoFlow.isAutoApplyEnabled()) setInterval(() => {}, 60000);

void linkedinBot; // LinkedIn submissions go through apply-worker -> linkedin-bot

module.exports = {
  loadConfig,
  getEligibleOffers,
  processOneOffer,
  runBatch,
  stopBatch,
  getBatchStatus,
  startAutoApplyOnBoot,
  startPeriodicPoll,
  reapInFlight,
  applyTaskId,
  start,
  batchLog,
};
