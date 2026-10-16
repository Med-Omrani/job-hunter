'use strict';
// FCM push sender (HTTP v1 via firebase-admin).
// Key: creds/fcm-service-account.json (gitignored, never logged, never committed).
// Targets: device tokens in the devices table (registered by the phone app).
//
// Every knob is env-driven (see .env.example) so the annoyances that were
// reported on 2026-09-28 can be tuned without touching this file:
//   PUSH_DEDUP_MIN   minutes an identical title+body stays suppressed (15)
//   PUSH_QUIET_START / PUSH_QUIET_END   local quiet window 23:00-07:00
//   PUSH_DIGEST_MIN  minutes between offer digests (30)
//   PUSH_CHAT_MODE   off | action_only | all   (off)
//
// PUSH_CHAT_MODE is the only knob about WHAT gets pushed at all: with `off`
// (the default since 2026-09-30) nothing from the chat/agent ever notifies --
// the user asked to be pinged for new offers only. Everything else (offer
// digest, task_done, apply_blocked/questions/preview/failed) is untouched and
// still pushes. Set action_only to bring back the agent's questions.
//
// State (dedup keys, queued pushes, already-announced offers) lives in
// .push-state.json, NOT in memory: a daemon restart used to reopen the dedup
// window and re-deliver every suppressed push.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { getMessaging } = require('firebase-admin/messaging');
const api = require('./api_client.js');

const DIR = __dirname;
const EVENTS = path.join(DIR, 'events-push.log');
const KEY = path.join(DIR, 'creds', 'fcm-service-account.json');
const STATE = path.join(DIR, '.push-state.json');

const MIN = 60 * 1000;
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
// Unknown/typo'd values must not silently re-enable chat noise, so anything
// outside the enum falls back to the strict `off` default.
const CHAT_MODES = ['off', 'action_only', 'all'];
const CFG = {
  dedupMin: num(process.env.PUSH_DEDUP_MIN, 15),
  quietStart: num(process.env.PUSH_QUIET_START, 23),
  quietEnd: num(process.env.PUSH_QUIET_END, 7),
  digestMin: num(process.env.PUSH_DIGEST_MIN, 30),
  chatMode: CHAT_MODES.includes(String(process.env.PUSH_CHAT_MODE || '').trim())
    ? String(process.env.PUSH_CHAT_MODE).trim()
    : 'off',
  maxOfferIds: 500,
};

// Tags that are allowed to break through quiet hours: the agent is blocked
// waiting on Mohamed, so silence would leave a task hanging.
const URGENT_TAGS = new Set([
  'apply_blocked', 'apply_questions', 'apply_preview', 'apply_failed',
  'agent_action', 'action_required',
]);

function log(ev) {
  const line = JSON.stringify({ ts: new Date().toISOString(), proc: 'push', ...ev });
  try { fs.appendFileSync(EVENTS, line + '\n'); } catch (_) {}
}

let state = null;
function loadState() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch (_) {
    state = { sent: {}, queue: [], offerIds: [] };
  }
  state.sent = state.sent || {};
  state.queue = Array.isArray(state.queue) ? state.queue : [];
  state.offerIds = Array.isArray(state.offerIds) ? state.offerIds : [];
  return state;
}
function saveState() {
  const st = loadState();
  // Drop dedup keys past the widest window we care about so the file cannot grow
  // without bound. Anything still queued must be preserved.
  const horizon = Date.now() - Math.max(CFG.dedupMin, CFG.digestMin + 10) * MIN;
  for (const k of Object.keys(st.sent)) {
    if (Number(st.sent[k]) < horizon) delete st.sent[k];
  }
  try { fs.writeFileSync(STATE, JSON.stringify(st)); } catch (_) {}
}

let app = null;
function init() {
  if (app) return app;
  if (!fs.existsSync(KEY)) throw new Error('no_key');
  const cred = admin.credential ? admin.credential.cert(KEY) : admin.cert(KEY);
  try { app = admin.initializeApp({ credential: cred }); }
  catch (e) {
    if (/already exists/i.test(String((e && e.message) || e))) app = admin.getApp();
    else throw e;
  }
  return app;
}

// Local-hour check, handling a window that wraps past midnight (23 -> 7).
function inQuietHours(at) {
  const h = at.getHours();
  return CFG.quietStart <= CFG.quietEnd
    ? (h >= CFG.quietStart && h < CFG.quietEnd)
    : (h >= CFG.quietStart || h < CFG.quietEnd);
}

function fingerprint(tag, title, body, offerId) {
  // offerId is part of the fingerprint on purpose: a digest that names a
  // different offer must not be suppressed as a duplicate of the previous one.
  return crypto.createHash('sha1').update([tag, title, body, String(offerId ?? '')].join('\n')).digest('hex');
}

async function sendOne({ title, body, tag, offerId }) {
  init();
  const devices = await api.listDevices();
  const tokens = [...new Set(devices.map((d) => d.token).filter(Boolean))];
  if (!tokens.length) return { ok: false, error: 'no_devices' };
  // offerId is what lets the phone open the tapped offer instead of just the
  // offers tab. FCM data values must be strings, and a null/undefined value
  // would be serialised as the string "null" and break deep-linking, so it is
  // only added when there is a real id.
  const data = { tag, title, body, at: String(Date.now()) };
  const oid = String(offerId ?? '').trim();
  if (oid) data.offerId = oid;
  const res = await getMessaging().sendEachForMulticast({
    tokens,
    // Data-only on purpose: the phone app builds its own local notification in
    // FirebaseMessaging.onMessage (main.dart). Shipping a `notification` block as
    // well used to double every push when the app was in the foreground -- the
    // tray showed the system copy and then the app's own. Title/body therefore
    // travel inside `data` so a foregrounded app still has something to show.
    data,
    // collapseKey lives on AndroidConfig, NOT at the top level of Message.
    // A top-level collapseKey is not a valid Message field: FCM rejects the
    // whole payload with invalid-argument, which (before the prune fix) was
    // enough to unsubscribe the device and kill all notifications.
    android: { collapseKey: tag, priority: 'high' },
  });
  let pruned = 0;
  const codes = [];
  for (let i = 0; i < res.responses.length; i++) {
    const r = res.responses[i];
    const code = String((r.error && r.error.code) || '');
    if (!r.success) codes.push(code || 'unknown');
    // Only a token-scoped error justifies unsubscribing the device. The old
    // regex also matched `invalid-argument`, which FCM raises for a bad *payload*
    // -- that silently killed the token while the phone was perfectly healthy
    // and took all notifications down with it.
    if (!r.success && /(registration-token-not-registered|not-registered|unregistered)/i.test(code)
        && !/invalid-argument|invalid-payload|internal/i.test(code)) {
      const dev = devices.find((d) => d.token === tokens[i]);
      if (dev) { try { await api.deleteDevice(dev.id); pruned++; } catch (_) {} }
    }
  }
  log({ type: 'push_sent', tag, sent: res.successCount, failed: res.failureCount, pruned, codes: codes.slice(0, 3) });
  return { ok: true, sent: res.successCount, failed: res.failureCount, pruned };
}

// Drain anything parked during quiet hours. Called on every notify() and on the
// offer-digest tick, so a push queued at 23:30 lands shortly after 07:00.
function flushQueue() {
  const st = loadState();
  if (!st.queue.length || inQuietHours(new Date())) return 0;
  const pending = st.queue.splice(0, st.queue.length);
  saveState();
  for (const p of pending) {
    // Must match the fingerprint computed when the item was queued, otherwise a
    // push already delivered some other way looks "unsent" and is sent twice.
    const fp = fingerprint(p.tag, p.title, p.body, p.offerId);
    // Skip anything that landed by other means while it was parked.
    if (loadState().sent[fp]) continue;
    sendOne(p).catch((e) => log({ type: 'push_error', tag: p.tag, error: String((e && e.message) || e).slice(0, 120) }));
  }
  log({ type: 'push_flush', n: pending.length });
  return pending.length;
}

async function notify({ title, body, tag, force, offerId } = {}) {
  const t = String(tag || 'info').slice(0, 32);
  const ti = String(title || 'JobCenter').slice(0, 60);
  const bd = String(body || '').slice(0, 180);
  // Ids are opaque hashes/refs; keep them bounded so a malformed value cannot
  // bloat the payload, and drop anything that is not plainly a string.
  const oid = String(offerId ?? '').trim().slice(0, 128);
  try {
    flushQueue();
  } catch (_) {}
  const st = loadState();
  const fp = fingerprint(t, ti, bd, oid);
  const last = Number(st.sent[fp] || 0);
  if (!force && last && Date.now() - last < CFG.dedupMin * MIN) {
    log({ type: 'push_suppressed', tag: t, reason: 'dedup', ageMin: Math.round((Date.now() - last) / MIN) });
    return { ok: false, suppressed: true, reason: 'dedup' };
  }
  if (!force && !URGENT_TAGS.has(t) && inQuietHours(new Date())) {
    st.queue.push({ title: ti, body: bd, tag: t, offerId: oid || undefined, queuedAt: Date.now() });
    saveState();
    log({ type: 'push_queued', tag: t, depth: st.queue.length });
    return { ok: false, queued: true, reason: 'quiet_hours' };
  }
  try {
    const r = await sendOne({ title: ti, body: bd, tag: t, offerId: oid });
    if (r.ok) { st.sent[fp] = Date.now(); saveState(); }
    return r;
  } catch (e) {
    log({ type: 'push_error', tag: t, error: String((e && e.message) || e).slice(0, 120) });
    return { ok: false, error: String((e && e.message) || e).slice(0, 140) };
  }
}

// --- offer digest bookkeeping -------------------------------------------
// Shared with chat-bot.pushDigest: an offer is announced once, keyed by id, so
// ranking changes or a busy fleet cannot make the same job re-notify.
function alreadyAnnounced(ids) {
  const set = new Set(loadState().offerIds);
  return (ids || []).filter((id) => set.has(String(id)));
}
// Ids that have never been announced. Single Set build, so callers can pass the
// whole offer list without re-reading state per offer.
function filterUnannounced(ids) {
  const set = new Set(loadState().offerIds);
  return (ids || []).filter((id) => id && !set.has(String(id)));
}
function markAnnounced(ids) {
  const st = loadState();
  const merged = [...st.offerIds, ...(ids || []).map(String)];
  const uniq = [...new Set(merged)];
  st.offerIds = uniq.slice(-CFG.maxOfferIds);
  saveState();
  return st.offerIds.length;
}
function lastDigestAt() { return Number(loadState().lastDigestAt || 0); }
function setDigestAt(ms) { loadState().lastDigestAt = ms; saveState(); }

module.exports = {
  notify,
  flushQueue,
  alreadyAnnounced,
  filterUnannounced,
  markAnnounced,
  lastDigestAt,
  setDigestAt,
  config: CFG,
  inQuietHours,
};
