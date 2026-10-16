'use strict';
// Hotline server — supervises a headless `opencode serve` instance so the app chat
// can talk directly to the project's opencode assistant (AGENTS.md/RULES.md context).
// Runs from the repo root so the server loads the JobCenter project context.
// Supervised by monitor.js via agents.json (id "hotline") — node process, auto-restart.
//
// Note: `opencode serve` DAEMONIZES — the launched parent exits (code 1, "Unexpected
// error") and re-execs a detached core that keeps serving. So this wrapper is
// HEALTH-driven: it only (re)spawns when the health endpoint is actually down, and
// frees the port before spawning. It never respawns on process exit.
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const DIR = __dirname;
const ROOT = path.join(DIR, '..', '..');
const EVENTS = path.join(DIR, 'events-hotline-server.log');

function log(ev) {
  const line = JSON.stringify({ ts: new Date().toISOString(), proc: 'hotline-server', ...ev });
  try { fs.appendFileSync(EVENTS, line + '\n'); } catch (_) {}
  if (process.env.VERBOSE) console.log(line);
}

// Reuse the .env parser pattern (CRLF-safe)
function loadDotEnv() {
  try {
    const p = path.join(ROOT, '.env');
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

const PORT = Number(process.env.OPENCODE_HOTLINE_PORT || 4096);
const BIN = process.env.OPENCODE_BIN || path.join(process.env.APPDATA || DIR, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
const CIDR = '127.0.0.1';
const URL = `http://${CIDR}:${PORT}`;
const HEALTH_INTERVAL_MS = 5000;
const DOWN_LIMIT = 3;

let child = null;
let spawning = false;
let stopped = false;
let downTicks = 0;

function serveArgs() {
  const a = ['serve', '--port', String(PORT), '--hostname', CIDR];
  if (process.env.OPENCODE_SERVER_PASSWORD) a.push('--server-password', process.env.OPENCODE_SERVER_PASSWORD);
  return a;
}

async function serveUp() {
  try {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(URL + '/global/health', { signal: ctl.signal });
    clearTimeout(tm);
    return res.ok;
  } catch (_) { return false; }
}

// Kill whoever owns the port (only if it's an opencode process) — frees it for a fresh spawn.
function freePort() {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const re = new RegExp(`TCP\\s+${CIDR.replace(/\./g, '\\.')}:${PORT}\\s+.*LISTENING\\s+(\\d+)`);
    const m = out.match(re);
    if (!m) return 0;
    const pid = Number(m[1]);
    const info = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (!/opencode/i.test(info)) { log({ type: 'port_owner_not_opencode', pid }); return 0; }
    execSync(`taskkill /PID ${pid} /T /F`, { encoding: 'utf8', timeout: 8000, windowsHide: true });
    log({ type: 'port_freed', pid });
    return pid;
  } catch (e) {
    log({ type: 'free_port_error', error: String((e && e.message) || e).slice(0, 120) });
    return 0;
  }
}

function spawnServer() {
  if (stopped || spawning) return;
  spawning = true;
  const out = fs.openSync(path.join(DIR, 'hotline.out.log'), 'a');
  const err = fs.openSync(path.join(DIR, 'hotline.err.log'), 'a');
  child = spawn(BIN, serveArgs(), {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, err],
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD || '',
      NO_COLOR: '1',
    },
  });
  child.unref();
  log({ type: 'opencode_serve_start', pid: child.pid, port: PORT });
  const done = () => {
    // Parent may exit immediately after daemon handoff — never respawn here.
    log({ type: 'opencode_serve_exit_handled', code: null });
    child = null;
  };
  child.on('exit', (code, sig) => { log({ type: 'opencode_serve_exit', code, sig }); child = null; });
  child.on('error', (e) => { log({ type: 'opencode_serve_error', error: String((e && e.message) || e) }); child = null; });
  // release the spawn guard once the parent has had time to bind or hand off
  setTimeout(() => { spawning = false; }, 4000);
}

async function checkHealth() {
  if (stopped) return;
  const up = await serveUp();
  if (up) {
    if (downTicks > 0) downTicks = 0;
    return;
  }
  downTicks++;
  if (downTicks >= DOWN_LIMIT) {
    log({ type: 'hotline_restart', reason: 'health_down', downTicks });
    downTicks = 0;
    freePort();
    spawnServer();
  }
}

process.on('SIGTERM', () => { stopped = true; freePort(); setTimeout(() => process.exit(0), 300); });
process.on('SIGINT', () => { stopped = true; freePort(); setTimeout(() => process.exit(0), 300); });

(async () => {
  log({ type: 'hotline_server_start', bin: BIN, port: PORT, url: URL });
  if (await serveUp()) {
    log({ type: 'hotline_adopted_existing' });
  } else {
    spawnServer();
  }
  setInterval(checkHealth, HEALTH_INTERVAL_MS);
})();