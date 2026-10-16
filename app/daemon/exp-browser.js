const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIR = __dirname;
const SESSION = path.join(DIR, 'experteer.session.json');

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function loadSessionCookies() {
  try {
    const j = JSON.parse(fs.readFileSync(SESSION, 'utf8'));
    if (j.valid !== true) return [];
    return (j.cookies || []).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: typeof c.expires === 'number' && c.expires > 0 ? c.expires : -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: c.sameSite === 'Lax' || c.sameSite === 'Strict' || c.sameSite === 'None' ? c.sameSite : 'Lax',
    }));
  } catch (_) { return []; }
}

function isWall(text) {
  return /vérification de votre navigateur|checking your browser|recaptcha/i.test(text);
}

async function openBrowser(cookies) {
  const browser = await chromium.launch({ channel: process.env.EXP_CHANNEL || 'msedge', headless: process.env.EXP_HEADLESS !== '0' });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    locale: 'fr-FR',
    extraHTTPHeaders: { 'Accept-Language': 'fr,en;q=0.8' },
    viewport: { width: 1440, height: 900 },
  });
  if (cookies.length) await ctx.addCookies(cookies).catch(() => {});
  return { browser, ctx };
}

function parseCardsHtml(bodyHtml) {
  const items = [];
  const re = /class="job-list-item-title"\s*>[\s\S]*?<a[^>]*href="([^"]*\/career\/view-jobs\/[^"]*)"[^>]*title="([^"]*)"[^>]*>/g;
  const idRe = /data-list-item-id="(\d+)"/g;
  let m;
  while ((m = idRe.exec(bodyHtml)) !== null) items.push({ id: m[1] });
  let n = 0;
  while ((m = re.exec(bodyHtml)) !== null && n < items.length) {
    items[n].link = m[1];
    items[n].title = m[2];
    n++;
  }
  return items.filter((it) => it.link && it.title && it.title.trim().length >= 3 && /\d{6,}/.test(it.id));
}

async function crawlListings(urls, opts = {}) {
  const scrolls = opts.scrolls !== undefined ? opts.scrolls : 10;
  const waitMs = opts.waitMs !== undefined ? opts.waitMs : 9000;
  const scrollWait = opts.scrollWait !== undefined ? opts.scrollWait : 1600;
  const cookies = loadSessionCookies();
  const browser = await openBrowser(cookies);
  const results = [];
  try {
    for (const url of urls) {
      const rec = { url, blocked: false, error: '', offers: [] };
      try {
        const page = await browser.ctx.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(waitMs);
        const t0 = await page.evaluate(() => document.title).catch(() => '');
        const b0 = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
        if (isWall(t0) || isWall(b0)) {
          rec.blocked = true;
          try { await page.close(); } catch (_) {}
          results.push(rec);
          continue;
        }
        for (let i = 0; i < scrolls; i++) {
          await page.evaluate(() => window.scrollBy(0, 1600)).catch(() => {});
          await page.waitForTimeout(scrollWait);
        }
        const cards = await page.evaluate(() => {
          const pick = (el, sel) => { const e = el.querySelector(sel); return e ? (e.innerText || '').trim() : ''; };
          return [...document.querySelectorAll('.js-job-serp-item')].map((el) => {
            const a = el.querySelector('a[href*="/career/view-jobs/"]');
            return {
              id: el.getAttribute('data-list-item-id') || '',
              title: (a ? (a.getAttribute('title') || a.innerText) : '') || '',
              link: a ? a.getAttribute('href') : '',
              company: pick(el, '.job-list-item-company'),
              salary: pick(el, '.salary'),
              published: pick(el, '.published-days-ago'),
            };
          });
        }).catch(() => []);
        const seen = new Set();
        for (const c of cards) {
          if (!c.id || !/\d{6,}/.test(c.id) || !c.link || c.link.indexOf('/career/view-jobs/') === -1) continue;
          if (!c.title || c.title.length < 3) continue;
          if (/^[a-zàâäéèêëîïôöùûüç -]+ \((fr|france)\)$/i.test(c.title)) continue;
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          rec.offers.push({ id: c.id, title: clean(c.title), link: clean(c.link), company: clean(c.company).replace(/^(Chasseur de têtes|Entreprise|Portail d'emploi)\s*:\s*/i, ''), salary: clean(c.salary), published: clean(c.published) });
        }
        try { await page.close(); } catch (_) {}
      } catch (e) {
        rec.error = String((e && e.message) || e).split('\n')[0].slice(0, 160);
      }
      results.push(rec);
    }
  } finally {
    try { await browser.browser.close(); } catch (_) {}
  }
  return results;
}

module.exports = { crawlListings, loadSessionCookies, parseCardsHtml };