'use strict';
const fs = require('fs');
const path = require('path');
const api = require('./api_client.js');
const driver = require('./apply-driver.js');

const DIR = __dirname;
const CONF = path.join(DIR, 'auto-postule.config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONF, 'utf8')); }
  catch (_) { return { enabled: false, dailyCap: 20, platforms: [] }; }
}

// AUTO-APPLY IS FROZEN (2026-09-25). 668 apply events produced 1 real
// submission; the pipeline is disabled until it is rebuilt. Every entry point
// must consult this: it is the only gate that cannot be bypassed by launching
// a script by hand.
function isAutoApplyEnabled() {
  if (process.env.AUTO_APPLY === '1') return true;
  return loadConfig().enabled === true;
}

function isAutoApplyAction(request) {
  const t = String(request || '').toLowerCase().trim();
  return t.startsWith('auto_apply') || t.startsWith('autopostule') || t.startsWith('auto-postule');
}

function isAutoApplyOffer(offer) {
  if (!offer) return false;
  const action = String(offer.action || '').toLowerCase();
  return action === 'auto_apply' || action === 'autopostule' || action === 'auto-postule';
}

async function getAutoApplyOffers() {
  const config = loadConfig();
  if (!isAutoApplyEnabled()) return [];
  try {
    const all = await api.listOffers({ limit: 1000 });
    // status 'new' ONLY. The previous filter also accepted status 'applied',
    // which re-queued already-submitted offers (duplicate applications).
    return all.filter((o) => isAutoApplyOffer(o) && o.status === 'new');
  } catch (_) { return []; }
}

async function countTodayApplied() {
  const config = loadConfig();
  const cap = config.dailyCap || 20;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const all = await api.listOffers({ limit: 1000, all: 1 });
    const today = all.filter((o) => {
      if (o.status !== 'applied') return false;
      if (!isAutoApplyOffer(o) && o.appliedBoard !== 'linkedin') return false;
      const t = o.appliedAt || o.updatedAt || '';
      return String(t).slice(0, 10) === day;
    });
    return { applied: today.length, cap, remaining: Math.max(0, cap - today.length) };
  } catch (_) { return { applied: 0, cap, remaining: cap }; }
}

// Deterministic id: POST /api/tasks upserts on id (api/server.js), so a retry
// collides with the existing task instead of creating a second application.
function applyTaskId(offerId) { return 'auto-' + offerId; }

async function triggerAutoApply(offerId) {
  try {
    if (!isAutoApplyEnabled()) return { queued: false, reason: 'auto_apply_frozen' };
    if (!offerId) throw new Error('offer id required');
    const taskId = applyTaskId(offerId);
    const task = await api.createTask({
      id: taskId,
      request: 'auto_apply ' + offerId,
      key: 'auto-postule',
      from: 'auto-apply-flow',
      status: 'queued',
      kind: 'apply',
      action: 'auto_apply',
      createdAt: new Date().toISOString(),
      offerRef: offerId,
    });
    return task.id || taskId;
  } catch (e) {
    throw new Error('auto-apply trigger failed: ' + String(e.message || e).slice(0, 200));
  }
}

async function autoApplyAll() {
  const config = loadConfig();
  if (!config.enabled) return { skipped: true, reason: 'disabled in config' };
  const budget = await countTodayApplied();
  if (budget.remaining <= 0) return { skipped: true, reason: 'daily cap reached', applied: budget.applied, cap: budget.cap };
  const offers = await getAutoApplyOffers();
  const eligible = offers.slice(0, budget.remaining);
  const results = [];
  for (const offer of eligible) {
    try {
      const taskId = await triggerAutoApply(offer.id || offer.ref);
      results.push({ offerId: offer.id || offer.ref, title: offer.title, taskId, status: 'queued' });
    } catch (e) {
      results.push({ offerId: offer.id || offer.ref, title: offer.title, status: 'failed', error: String(e.message || e).slice(0, 100) });
    }
  }
  return { triggered: results.length, total: eligible.length, results };
}

async function setAutoApply(offerId, auto) {
  try {
    const action = auto ? 'auto_apply' : '';
    await api.updateOffer(offerId, { action });
    return { ok: true, action };
  } catch (e) {
    throw new Error('setAutoApply failed: ' + String(e.message || e).slice(0, 200));
  }
}

module.exports = {
  loadConfig,
  isAutoApplyEnabled,
  isAutoApplyAction,
  isAutoApplyOffer,
  getAutoApplyOffers,
  countTodayApplied,
  triggerAutoApply,
  applyTaskId,
  autoApplyAll,
  setAutoApply,
};
