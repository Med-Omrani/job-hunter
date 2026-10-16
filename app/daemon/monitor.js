const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const api = require('./api_client.js');

const DIR = __dirname;
const REGISTRY = JSON.parse(fs.readFileSync(path.join(DIR, 'agents.json'), 'utf8'));

function log(ev) {
  const line = JSON.stringify({ ts: new Date().toISOString(), proc: 'monitor', ...ev });
  try { fs.appendFileSync(path.join(DIR, 'events-monitor.log'), line + '\n'); } catch (_) {}
  if (process.env.VERBOSE) console.log(line);
}

const pidFile = (id) => path.join(DIR, id + '.pid');
const alivePids = new Set();

function readPid(id) {
  try { const n = Number(String(fs.readFileSync(pidFile(id), 'utf8')).trim()); return Number.isInteger(n) && n > 0 ? n : 0; } catch (_) { return 0; }
}
function isAlive(pid) {
  if (!pid) return false;
  try {
    const r = require('child_process').execSync('tasklist /FI "PID eq ' + pid + '" /FO CSV /NH', { encoding: 'utf8', shell: 'cmd.exe' });
    return r.includes('node.exe');
  } catch (_) { return false; }
}
// Terminate a retired agent and clear its pid file, so an agent marked
// enabled:false cannot be resurrected by a stale pid file that still points at a
// live process.
function killStale(id) {
  const pid = readPid(id);
  if (!isAlive(pid)) {
    try { fs.unlinkSync(pidFile(id)); } catch (_) {}
    alivePids.delete(pid);
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
    log({ type: 'agent_retired', id, pid });
  } catch (e) {
    log({ type: 'agent_retire_failed', id, pid, error: String((e && e.message) || e).slice(0, 80) });
  }
  try { fs.unlinkSync(pidFile(id)); } catch (_) {}
  alivePids.delete(pid);
}
function spawnAgent(id, spec) {
  const out = fs.openSync(path.join(DIR, id + '.out.log'), 'a');
  const err = fs.openSync(path.join(DIR, id + '.err.log'), 'a');
  // spec.env lets an agent carry its own settings (the fleet needs concurrency
  // and politeness knobs) without the caller exporting them into monitor's own
  // environment, which is shared by every agent.
  const child = spawn(process.execPath, [spec.file, ...(spec.args || [])], { cwd: DIR, detached: true, stdio: ['ignore', out, err], env: { ...process.env, ...(spec.env || {}), SOURCE_ID: id, WATCHDOG: '1' } });
  child.unref();
  fs.writeFileSync(pidFile(id), String(child.pid));
  alivePids.add(child.pid);
  log({ type: 'agent_spawned', id, pid: child.pid });
}
function checkAgent(id, spec) {
  const pid = readPid(id);
  if (!isAlive(pid)) {
    const wasHere = pid > 0 ? ' (pid ' + pid + ' died)' : '';
    log({ type: 'agent_down', id, pid, reason: wasHere || 'not running' });
    spawnAgent(id, spec);
    countDown[id] = 0;
  }
}

const countDown = {};
const STALE_SOURCE_ALERTS = {};
async function checkSources() {
  let sources = null;
  try {
    sources = await api.listSources();
  } catch (e) {
    log({ type: 'sources_check_error', error: String((e && e.message) || e) });
    return;
  }
  const now = Date.now();
  for (const d of sources) {
    if (!d.enabled) continue;
    const last = d.lastCrawlAtMs || 0;
    const intv = d.intervalMs || 3600000;
    if (now - last > intv * 3) {
      countDown[d.id] = (countDown[d.id] || 0) + 1;
      if (countDown[d.id] === 1 || countDown[d.id] % 6 === 0) {
        log({ type: 'source_stale', id: d.id, mins: Math.round((now - last) / 60000) });
        STALE_SOURCE_ALERTS[d.id] = now;
      }
    } else if (countDown[d.id] > 0) {
      countDown[d.id] = 0;
      log({ type: 'source_recovered', id: d.id });
    }
  }
}

let run = true;
process.on('SIGTERM', () => { run = false; process.exit(0); });
process.on('SIGINT', () => { run = false; process.exit(0); });

(async () => {
  log({ type: 'monitor_start' });
  // Docker mode — no failover/reconcile needed (single Postgres)
  try { await api.listSources(); log({ type: 'api_ok' }); } catch (e) { log({ type: 'api_wait', error: String(e.message || e).slice(0,80) }); }
  // initial spawn, staggered to avoid a stampede of simultaneous crawl bursts
  const ids = Object.keys(REGISTRY);
  for (const id of ids) {
    if (id === 'watchdog') continue;
    const spec = REGISTRY[id];
    // enabled:false retires an agent without deleting its entry, so switching
    // back is a one-character edit. The per-source hunter agents are retired
    // this way: hunter-fleet.js now crawls every source in a single process, and
    // keeping 18 hunters alongside it would double-crawl every board and cost
    // ~1.4 GB of RSS for no extra coverage.
    if (spec.enabled === false) { killStale(id); continue; }
    const pid = readPid(id);
    if (!isAlive(pid)) { spawnAgent(id, spec); log({ type: 'agent_initial', id }); }
    await new Promise((r) => setTimeout(r, 1500));
  }
  /*
   * Agent processes are started detached so the watchdog can restart them;
   * agents self-stagger via their own per-source interval scheduling.
   */
  setInterval(() => {
    for (const [id, spec] of Object.entries(REGISTRY)) {
      if (id === 'watchdog') continue;
      if (spec.enabled === false) { killStale(id); continue; }
      try { checkAgent(id, spec); } catch (e) { log({ type: 'check_error', id, error: String((e && e.message) || e) }); }
    }
  }, 30000);
  setInterval(checkSources, 60000);
  log({ type: 'monitor_ready' });
})().catch((e) => { console.error('MONITOR FATAL', e); log({ type: 'monitor_fatal', error: String((e && e.message) || e) }); process.exit(1); });