'use strict';
// Probe-time browser fallback for bot-walled hosts.
//
// WHAT THIS IS
// Some career sites answer a plain HTTP request with a Cloudflare interstitial
// (HTTP 403, `server: cloudflare`) and serve the real page to a real browser. For
// those hosts -- and only those, gated on status AND the Cloudflare header in
// probe-core.looksLikeBotWall -- we open the page in the browser already installed
// on this machine and read the DOM after the challenge resolves.
//
// This is an ordinary page visit. It is NOT an attempt to break, defeat or
// circumvent a security control: it loads the page the way a person's browser
// would and reads what the site chose to render. Nothing here evades a CAPTCHA, and
// if a host still refuses after this we record `browser-blocked` and leave it alone.
// It is deliberately NOT wired into the fleet poll path -- a board that needs a
// browser must be reduced to a cheap API source, not crawled at 300s with a
// browser, which would cost ~25s of CPU and hundreds of MB per poll.
//
// Playwright is already a dependency (app/daemon/node_modules/playwright) and
// Chromium is already downloaded, so this adds no install.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

let pw = null;
let browserPromise = null;
let browserBroken = false;

function loadPlaywright() {
  if (pw !== null) return pw;
  try { pw = require('playwright'); } catch (_) { pw = false; }
  return pw;
}

// One shared browser for the whole process. Launching Edge costs ~1s, so a fresh
// browser per URL would dominate a discovery pass; the context is cheap and is
// created per page to keep cookies from leaking between hosts.
async function getBrowser(timeoutMs) {
  if (browserBroken) return null;
  if (browserPromise) return browserPromise;
  const lib = loadPlaywright();
  if (!lib) { browserBroken = true; return null; }
  browserPromise = lib.chromium.launch({
    channel: process.env.PROBE_BROWSER_CHANNEL || 'msedge',
    headless: process.env.PROBE_BROWSER_HEADLESS !== '0',
  }).catch((e) => {
    // A machine without Edge/Chrome installed, or a locked-down host, must not
    // take the whole discovery run down: fall back to plain HTTP everywhere.
    browserBroken = true;
    return null;
  });
  return browserPromise;
}

async function closeBrowser() {
  const b = await browserPromise;
  if (b) { try { await b.close(); } catch (_) {} }
  browserPromise = null;
}

function isWall(text) {
  return /vérification de votre navigateur|verification de votre navigateur|checking your browser|just a moment|attention required|enable javascript and cookies|captcha/i.test(String(text || ''));
}

// Returns { status, text, blocked, wall }. `text` is document.body.innerText, which
// is what findAtsIn needs: it reads links and ATS hostnames, both of which land in
// innerText once the DOM is rendered.
async function renderText(url, timeoutMs) {
  const browser = await getBrowser(timeoutMs);
  if (!browser) return { status: 0, text: '', blocked: true, wall: false, reason: 'no-browser' };
  const budget = Math.max(15000, Math.min(timeoutMs || 20000, 60000));
  let ctx = null;
  try {
    ctx = await browser.newContext({
      userAgent: UA,
      // A single BCP-47 tag. An Accept-Language string ('fr-FR,en;q=0.8') here
      // fails context creation outright with "Invalid locale name", which is how
      // the fallback silently returned blocked for every host until it was tested.
      locale: process.env.PROBE_BROWSER_LOCALE || 'fr-FR',
      extraHTTPHeaders: { 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.7' },
      viewport: { width: 1366, height: 900 },
    });
    const page = await ctx.newPage();
    let status = 0;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: budget });
      status = resp ? resp.status() : 0;
    } catch (_) { status = 0; }
    // The challenge needs a moment to run its JS. Short wait: if the host serves
    // the real page immediately this is just a pause, and if it does not, we bail
    // rather than pay for a scroll-fest.
    await page.waitForTimeout(3500);
    let text = '';
    try { text = await page.evaluate(() => (document.body ? document.body.innerText : '')); } catch (_) { text = ''; }
    let html = '';
    try { html = await page.content(); } catch (_) { html = ''; }
    if (isWall(text) || isWall(html.slice(0, 4000))) {
      // Second chance: Cloudflare's managed challenge usually auto-passes a real
      // browser within a few seconds. Wait once more, then give up on this host.
      await page.waitForTimeout(4000);
      try { text = await page.evaluate(() => (document.body ? document.body.innerText : '')); } catch (_) {}
      if (isWall(text)) return { status, text: '', blocked: true, wall: true };
    }
    return { status, text: (text || html || ''), blocked: false, wall: false };
  } catch (e) {
    return { status: 0, text: '', blocked: true, wall: false, reason: String((e && e.message) || e).slice(0, 120) };
  } finally {
    if (ctx) { try { await ctx.close(); } catch (_) {} }
  }
}

module.exports = { renderText, closeBrowser, isWall };