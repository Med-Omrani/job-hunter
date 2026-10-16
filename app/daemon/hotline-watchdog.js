// Hotline watchdog: polls opencode's /global/health and, after 3 consecutive
// failures, kills the hotline-server tree so monitor.js respawns it.
// Recovery procedure mirrors AGENTS.md (never spawn a second `serve` on 4096).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const LOG = path.join(DIR, 'events-hotline-watch.log');
const PID_FILE = path.join(DIR, 'hotline.pid');
const PORT = Number(process.env.OPENCODE_HOTLINE_PORT || 4096);
const INTERVAL_MS = 60000;
const MAX_FAILS = 3;

let fails = 0;
let lastState = null;
let kills = 0;

function log(ev) {
  const line = JSON.stringify({ ts: new Date().toISOString(), proc: 'hotline-watchdog', ...ev });
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
  if (process.env.VERBOSE) console.log(line);
}

function health() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/global/health', timeout: 10000 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: body.slice(0, 200) }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, status: 0, body: String((e && e.message) || e) }));
  });
}

function killAgentTree() {
  let pid = 0;
  try { pid = Number(String(fs.readFileSync(PID_FILE, 'utf8')).trim()); } catch (_) { return { killed: false, reason: 'no_pid_file' }; }
  if (!pid || pid <= 0) return { killed: false, reason: 'bad_pid' };
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return { killed: true, pid };
  } catch (e) {
    return { killed: false, pid, reason: String((e && e.message) || e).slice(0, 120) };
  }
}

(async () => {
  log({ type: 'watch_start', port: PORT, intervalMs: INTERVAL_MS });
  for (;;) {
    const h = await health();
    if (h.ok) {
      if (lastState !== 'up') log({ type: 'hotline_up', status: h.status, body: h.body });
      fails = 0;
      lastState = 'up';
    } else {
      fails += 1;
      log({ type: 'hotline_down', status: h.status, body: h.body, fails, threshold: MAX_FAILS });
      lastState = 'down';
      if (fails >= MAX_FAILS) {
        const r = killAgentTree();
        kills += 1;
        log({ type: 'hotline_kill_attempt', ...r, kills });
        fails = 0;
        await new Promise((res) => setTimeout(res, 45000));
      }
    }
    await new Promise((res) => setTimeout(res, INTERVAL_MS));
  }
})().catch((e) => { log({ type: 'watch_fatal', error: String((e && e.message) || e) }); process.exit(1); });
