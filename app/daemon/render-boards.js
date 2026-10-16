const path = require('path');
const { chromium } = require('playwright');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const JOBISH = /(job|offre|emploi|career|career\b|posting|opportunity|a-emploi|wttj|jobs?\b|\d{5,})/i;
// Serialized into page.evaluate as a source string (never as a live RegExp).
JOBISH.source = '(job|offre|emploi|career|posting|opportunity|a-emploi|wttj|jobs?\\b|\\d{5,})';

function isWall(t) {
  return /vérification de votre navigateur|checking your browser|recaptcha|unusual traffic/i.test(String(t || ''));
}

async function crawlRenderListings(urls, siteId) {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    locale: 'fr-FR',
    extraHTTPHeaders: { 'Accept-Language': 'fr,en;q=0.8' },
    viewport: { width: 1440, height: 900 },
  });
  const out = [];
  try {
    for (const url of urls) {
      const rec = { site: siteId, url, blocked: false, error: '', cards: 0, offers: [] };
      try {
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(6000);
        for (let i = 0; i < 5; i++) { await page.evaluate(() => window.scrollBy(0, 1600)).catch(() => {}); await page.waitForTimeout(1200); }
        const title = await page.title().catch(() => '');
        const bodyTxt = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
        if (isWall(title) || isWall(bodyTxt.slice(0, 1200))) {
          rec.blocked = true;
          try { await page.close(); } catch (_) {}
          out.push(rec);
          continue;
        }
        // The regex MUST be passed as an argument: page.evaluate serializes the
        // function into the page, where module-scope constants do not exist.
        // Referencing JOBISH_SRC inside threw a ReferenceError that the old
        // .catch(() => []) swallowed, so a broken crawl reported success with
        // zero offers (WTTJ/JobTeaser looked healthy while producing nothing).
        let links = [];
        try {
          links = await page.evaluate((rxSrc) => {
            let rx;
            try { rx = new RegExp(rxSrc, 'i'); } catch (_) { return []; }
            return [...document.querySelectorAll('a[href]')]
              .filter((a) => rx.test(a.getAttribute('href') || ''))
              .map((a) => ({ href: a.getAttribute('href'), text: (a.innerText || '').trim() }));
          }, JOBISH.source);
        } catch (e) {
          rec.error = 'link_extract_failed: ' + String((e && e.message) || e).slice(0, 120);
          try { await page.close(); } catch (_) {}
          out.push(rec);
          continue;
        }
        const seen = new Set();
        for (const l of links) {
          if (!l.href || !l.text || l.text.length < 3) continue;
          let href = l.href;
          try { href = new URL(href, url).href; } catch (_) {}
          if (seen.has(href)) continue;
          seen.add(href);
          rec.cards++;
          rec.offers.push({ link: href, title: clean(l.text).slice(0, 140) });
        }
        try { await page.close(); } catch (_) {}
      } catch (e) {
        rec.error = String((e && e.message) || e).slice(0, 160);
      }
      out.push(rec);
    }
  } finally {
    try { await browser.close(); } catch (_) {}
  }
  return out;
}

module.exports = { crawlRenderListings };
