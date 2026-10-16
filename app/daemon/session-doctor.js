'use strict';
// session-doctor.js — reports, per board, whether we already hold a usable
// login session. Some ATS refuse guests (experteer, eightfold, some Workday
// tenants) and need ONE human login into a persistent profile; after that the
// daemon reuses the cookies silently. This script tells you exactly which
// boards still need that, instead of discovering it as failed applications.
//
// It only inspects local state and (optionally) opens each board's login page
// for you to log into — it never submits anything.
//
// Usage:
//   node session-doctor.js            report only (no browser, instant)
//   node session-doctor.js --login    open each board needing a login, one at a time
//   node session-doctor.js --login workday    only that board
const fs = require('fs');
const path = require('path');
const api = require('./api_client.js');
const driver = require('./apply-driver.js');

const args = process.argv.slice(2);
const doLogin = args.includes('--login');
const only = (() => { const i = args.indexOf('--login'); if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1]; const j = args.indexOf('--board'); return j >= 0 ? args[j + 1] : null; })();

const DIR = __dirname;
const CHROME_KEYS = ['Local State', 'Default\\Cookies', 'Default\\Network\\Cookies', 'Default\\Preferences'];

// Boards that cannot be filled as a guest. Each needs a one-time human login
// into its persistent profile directory (<board>-profile).
const NEEDS_LOGIN = new Set(['experteer', 'eightfold']);

// Boards that are happy as a guest but benefit from a stored session.
const GUEST_OK = new Set(['linkedin', 'jobijoba', 'tunisian', 'wttj', 'jobteaser', 'sagemcom', 'himalayas', 'remote', 'remotive', 'remoteok', 'workday', 'smartrecruiters', 'capgemini']);

// Cookie names that actually indicate an authenticated session on the ATS
// families we target. LinkedIn is special-cased: ONLY `li_at` is proof of a
// login. The profiles are full of analytics cookies (_gcl_au, _uetsid, AMCV,
// bcookie, bscookie, lidc…) that look like a session but grant nothing, which
// made this script report "OK (session)" for a profile that was logged out.
const AUTH_COOKIE_RX = /^(li_at|jsessionid|jsession|phpsessid|sessionid|session|csrftoken|remember_token|remember_me|wtid|capgemini_[a-z]+|bearer|access_token|id_token|refresh_token|auth|token|logged_in|is_authenticated|ss[a-z]*)$/i;
const REQUIRED_COOKIE = { linkedin: 'li_at' };
// LinkedIn's session lives in linkedin.session.json (injected by linkedin-bot),
// not only in the profile directory.
const SESSION_FILES = {
  tunisian: 'jobijoba.session.json',
  linkedin: 'linkedin.session.json',
};

// Mirrors apply-driver.js launchCtx().sessionFiles: these boards get their
// login from an INJECTED cookie file, so an empty profile directory is normal
// and must not be reported as "no session".
function injectedSession(board) {
  const f = SESSION_FILES[board];
  if (!f) return null;
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) return { file: f, cookies: 0, ok: false, missing: true };
  try {
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    // linkedin.session.json is {valid, cookies}; other session files are bare
    // {cookies} arrays (Playwright storageState).
    const c = Array.isArray(s) ? s : (Array.isArray(s.cookies) ? s.cookies : []);
    const now = Date.now();
    const live = c.filter((k) => !k.expires || (k.expires > 1000 ? k.expires * 1000 : new Date(k.expires).getTime()) > now);
    const need = REQUIRED_COOKIE[board];
    const hasNeed = need ? live.some((k) => k.name === need) : true;
    return {
      file: f, cookies: live.length, ok: live.length > 0 && hasNeed,
      auth: live.filter((k) => AUTH_COOKIE_RX.test(k.name)).map((k) => k.name),
      missingNeed: need && !hasNeed ? need : '',
    };
  } catch (e) { return { file: f, cookies: 0, ok: false, err: String(e.message).slice(0, 80) }; }
}

// Authoritative probe: opening the persistent context and asking Playwright for
// its cookies reads the real store. Do NOT infer this from the file size —
// Chromium preallocates the SQLite cookie DB (32 KB even with zero cookies),
// which reported a false HAS_SESSION on empty profiles.
async function probeCookies(board) {
  const inj = injectedSession(board);
  if (inj && inj.ok) return { ok: true, reason: 'INJECTED_SESSION', cookies: inj.cookies, auth: inj.auth || [], note: inj.file };
  const dir = path.join(DIR, board + '-profile');
  if (!fs.existsSync(dir)) return { ok: false, reason: inj ? (inj.missing ? 'SESSION_FILE_MISSING' : 'SESSION_FILE_EMPTY') : 'NO_PROFILE', cookies: 0, auth: [], need: REQUIRED_COOKIE[board] || '' };
  let ctx;
  try {
    const { chromium } = require('playwright');
    ctx = await chromium.launchPersistentContext(dir, {
      headless: true, viewport: { width: 1280, height: 800 },
      args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
      timeout: 25000,
    });
    const cookies = await ctx.cookies();
    const now = Date.now();
    const live = cookies.filter((c) => !c.expires || c.expires * 1000 > now);
    const need = REQUIRED_COOKIE[board];
    const needPresent = need ? live.some((c) => c.name === need) : false;
    let reason;
    if (need) {
      // Analytics cookies are not a login: demand the specific token.
      reason = needPresent ? 'HAS_SESSION' : (live.length ? 'NO_AUTH_COOKIE' : 'NO_COOKIES');
    } else {
      reason = live.length ? 'HAS_SESSION' : 'NO_COOKIES';
    }
    const auth = live.filter((c) => AUTH_COOKIE_RX.test(c.name)).map((c) => c.name);
    return { ok: reason === 'HAS_SESSION', reason, cookies: live.length, auth, need, needPresent, domains: [...new Set(live.map((c) => c.domain))].slice(0, 4) };
  } catch (e) {
    const msg = String((e && e.message) || e);
    // Chromium refuses to reuse a profile directory that is already locked by
    // another instance (e.g. the running daemon) — say so instead of guessing.
    return { ok: false, reason: /lock|SingletonLock|ProcessSingleton/i.test(msg) ? 'PROFILE_IN_USE' : 'PROBE_FAILED', cookies: 0, auth: [], err: msg.slice(0, 120) };
  } finally {
    try { if (ctx) await ctx.close(); } catch (_) {}
  }
}

function profileState(board) {
  const dir = path.join(DIR, board + '-profile');
  if (!fs.existsSync(dir)) return { board, dir, exists: false, state: 'NO_PROFILE' };
  let hasState = false;
  for (const k of CHROME_KEYS) { if (fs.existsSync(path.join(dir, k))) hasState = true; }
  return { board, dir, exists: true, state: hasState ? 'PROFILED' : 'EMPTY' };
}

async function boardsInUse() {
  const found = new Map();
  try {
    const offers = await api.listOffers({ limit: 1000 });
    for (const o of offers) {
      if (!o || !o.link) continue;
      const b = driver.detectBoard(o);
      if (b) found.set(b, (found.get(b) || 0) + 1);
    }
  } catch (e) { console.error('⚠️  API unreachable:', e.message, '— reporting on known boards only.'); }
  // Always cover the boards that need a login, even with no offers yet.
  for (const b of NEEDS_LOGIN) if (!found.has(b)) found.set(b, 0);
  return found;
}

async function main() {
  console.log('=== Session doctor ===\n');
  const inUse = await boardsInUse();
  const boards = [...inUse.keys()].filter((b) => !only || b === only);
  if (!boards.length) { console.log('No board to report on.'); return; }

  const rows = [];
  for (const board of boards) {
    const st = profileState(board);
    process.stdout.write(`  probing ${board} … `);
    const p = await probeCookies(board);
    rows.push({ ...st, probe: p });
    console.log(`${p.reason}${p.reason === 'PROFILE_IN_USE' ? ' (daemon is using it — restart the daemon or stop it to probe)' : ''}`);
  }

  console.log('\nboard           offers  state        cookies  verdict');
  const needLogin = [];
  for (const r of rows) {
    const has = r.probe.reason === 'HAS_SESSION' || r.probe.reason === 'INJECTED_SESSION';
    let verdict;
    if (r.probe.reason === 'PROFILE_IN_USE') verdict = 'IN_USE (stop daemon to verify)';
    else if (r.probe.reason === 'INJECTED_SESSION') verdict = 'OK (cookie file)';
    else if (r.probe.reason === 'NO_AUTH_COOKIE') verdict = `NEEDS_LOGIN (${r.probe.need} absent — analytics cookies only)`;
    else if (r.probe.reason === 'SESSION_FILE_EMPTY') verdict = 'NEEDS_LOGIN (cookie file empty)';
    else if (r.probe.reason === 'SESSION_FILE_MISSING') verdict = `NEEDS_LOGIN (no ${SESSION_FILES[r.board]})`;
    else if (NEEDS_LOGIN.has(r.board)) { verdict = has ? 'OK (check)' : 'NEEDS_LOGIN'; if (!has) needLogin.push(r.board); }
    else if (!r.exists) verdict = 'GUEST_OK (no session yet)';
    else if (has) verdict = 'OK (session)';
    else if (r.probe.reason === 'NO_COOKIES' && GUEST_OK.has(r.board)) verdict = 'GUEST_OK (empty profile)';
    else verdict = 'NEEDS_LOGIN';
    if (verdict.startsWith('NEEDS_LOGIN') && !needLogin.includes(r.board)) needLogin.push(r.board);
    console.log(
      r.board.padEnd(15) +
      String(inUse.get(r.board) || 0).padEnd(8) +
      r.state.padEnd(13) +
      String(r.probe.cookies).padEnd(9) +
      verdict + (r.probe.auth && r.probe.auth.length ? `  [${r.probe.auth.slice(0, 3).join(', ')}]` : ''),
    );
  }

  console.log('\nLegend: NEEDS_LOGIN = one human login required into <board>-profile (cookies are then reused).');
  console.log('        GUEST_OK    = the board accepts a guest; no login stored, that is fine.');

  if (!needLogin.length) {
    console.log('\n✅ No board requires a manual login. The sweep can run end-to-end.');
    return;
  }
  console.log(`\n⚠️  Manual login required for: ${needLogin.join(', ')}`);

  if (!doLogin) {
    console.log('\nHow to fix each:');
    for (const b of needLogin) {
      if (b === 'linkedin') console.log(`  linkedin   → node linkedin-login.js   (logs you in once, saves ${SESSION_FILES.linkedin} with li_at)`);
      else console.log(`  ${(b + ' ').padEnd(11)} → node session-doctor.js --login ${b}`);
    }
    return;
  }

  // Interactive: one board at a time so the user is never juggling windows.
  const { chromium } = require('playwright');
  for (const board of needLogin) {
    console.log(`\n=== ${board} : a browser window is opening.`);
    console.log('    Log in as yourself, stay on the site, then press ENTER here.');
    const dir = path.join(DIR, board + '-profile');
    fs.mkdirSync(dir, { recursive: true });
    let ctx;
    try {
      ctx = await chromium.launchPersistentContext(dir, {
        headless: false, viewport: { width: 1366, height: 900 }, locale: 'fr-FR',
        args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
      });
      await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
      const page = ctx.pages()[0] || await ctx.newPage();
      const link = (await (async () => {
        try {
          const offers = await api.listOffers({ limit: 1000 });
          const o = offers.find((x) => driver.detectBoard(x) === board && x.link);
          return o ? o.link : '';
        } catch (_) { return ''; }
      })());
      await page.goto(link || ('https://' + board + '.com'), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await waitEnter();
      const cookies = await ctx.cookies();
      const need = REQUIRED_COOKIE[board];
      const needPresent = need ? cookies.some((c) => c.name === need) : false;
      console.log(`    → ${cookies.length} cookie(s) in ${board}-profile.`);
      // Persist the session to the cookie file too: the profile directory can
      // be wiped or preallocated, whereas this file is the explicit, checked
      // source of truth (and the only thing the LinkedIn bot reads).
      if (cookies.length && (!need || needPresent)) {
        try {
          fs.writeFileSync(path.join(DIR, SESSION_FILES[board] || (board + '.session.json')), JSON.stringify({ valid: true, savedAt: new Date().toISOString(), cookies }, null, 2));
          console.log(`    Saved to ${SESSION_FILES[board] || (board + '.session.json')} — the daemon reuses it silently.`);
        } catch (e) { console.log('    ⚠️  Could not write the session file:', e.message); }
      } else if (need) {
        console.log(`    ⚠️  ${need} not captured — the login did not go through. Try again, or paste the cookie file into ${SESSION_FILES[board] || board + '.session.json'}.`);
      }
    } catch (e) {
      console.error('    ❌ ' + String((e && e.message) || e).slice(0, 160));
    } finally {
      try { if (ctx) await ctx.close(); } catch (_) {}
    }
  }
  console.log('\n=== Done. Re-run without --login to confirm. ===');
}

function waitEnter() {
  return new Promise((res) => {
    process.stdin.resume();
    process.stdin.once('data', () => { process.stdin.pause(); res(); });
  });
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
