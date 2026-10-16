'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const api = require('./api_client.js');
const driver = require('./apply-driver.js');
const stealth = require('./stealth.js');

const DIR = __dirname;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CONFIG_PATH = path.join(DIR, 'auto-postule.config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (_) { return { linkedin: {}, stealth: {} }; }
}

async function getLinkedInCookies() {
  const cookieFile = path.join(DIR, 'linkedin.session.json');
  try {
    const j = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
    if (j.valid) return j.cookies || [];
  } catch (_) {}
  return [];
}

async function launchLinkedInBrowser() {
  const config = loadConfig();
  const profileDir = path.join(DIR, 'linkedin-autopostule-profile');
  fs.mkdirSync(profileDir, { recursive: true });
  // Headed by default: headless Chromium gets served the /authwall on the
  // search endpoints. The UA is only overridden when we MUST hide
  // "HeadlessChrome" — in headed mode the browser's own UA is used so it can
  // never contradict the sec-ch-ua client hint it also sends.
  const headless = (config.linkedin && config.linkedin.headless === true) || process.env.HEADLESS === '1';
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless,
    ...(headless ? { userAgent: UA } : {}),
    viewport: { width: 1366, height: 900 },
    locale: 'fr-FR',
    acceptDownloads: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
    ],
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return ctx;
}

async function navigateToLinkedIn(ctx) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.setDefaultTimeout(15000);
  // Inject the session BEFORE any navigation so every page loads as the authenticated user.
  const cookies = await getLinkedInCookies();
  if (cookies.length > 0) {
    await ctx.addCookies(cookies);
  }
  // Warm-up: LinkedIn requires a coherent browsing history (feed -> network -> jobs)
  // before honoring the session on protected endpoints like search.
  for (const u of ['https://www.linkedin.com/feed/', 'https://www.linkedin.com/mynetwork/', 'https://www.linkedin.com/jobs/']) {
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }
  return page;
}

async function searchJobs(page, config) {
  const keywords = (config.linkedin && config.linkedin.searchKeywords) || ['embedded', 'iot'];
  const locations = (config.linkedin && config.linkedin.locations) || ['Tunisia', 'Remote'];
  const results = [];
  for (const keyword of keywords) {
    for (const location of locations) {
      try {
        const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}&location=${encodeURIComponent(location)}&f_TPR=r${Math.floor(Date.now() / 1000 - 86400)}&f_AL=true`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(6000);
        // LinkedIn's card markup changes per A/B test and uses obfuscated classes,
        // but <li data-occludable-job-id> and the <a href="/jobs/view/..."> inside are stable.
        const cards = await page.locator('li[data-occludable-job-id]').all().catch(() => []);
        for (const card of cards) {
          try {
            const linkEl = card.locator('a[href*="/jobs/view/"]').first();
            const href = await linkEl.getAttribute('href').catch(() => '');
            if (!href) continue;
            const link = href.split('?')[0];
            const title = (await linkEl.innerText().catch(() => '') || '').trim().replace(/\s+/g, ' ');
            if (title && link) {
              results.push({ title, company: '', link: link.startsWith('http') ? link : 'https://www.linkedin.com' + link });
            }
          } catch (_) {}
        }
      } catch (_) {}
    }
  }
  return results.slice(0, 50);
}

async function clickEasyApply(page) {
  try {
    const btn = page.locator('button:has-text("Easy Apply"), .jobs-apply-button, [data-control-name="job_apply"].ember-view, .jobs-s-apply').first();
    if (await btn.count() > 0) {
      await btn.click({ timeout: 10000 });
      await page.waitForTimeout(3000);
      return true;
    }
    const textBtn = page.getByText(/easy apply|postuler facilement/i).first();
    if (await textBtn.count() > 0) {
      await textBtn.click({ timeout: 10000 });
      await page.waitForTimeout(3000);
      return true;
    }
    return false;
  } catch (_) { return false; }
}

async function fillLinkedInForm(page, profile, cvPath) {
  const filled = [];
  try {
    const inputs = page.locator('input[type="text"], input[type="email"], input[type="tel"]');
    const n = await inputs.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 40); i++) {
      const el = inputs.nth(i);
      try { if (!(await el.isVisible())) continue; } catch (_) { continue; }
      const meta = await el.getAttribute('name').catch(() => '') + ' ' + await el.getAttribute('placeholder').catch(() => '');
      if (/first.*name|prénom/i.test(meta) && profile.name) {
        const name = String(profile.name).split(' ')[0];
        await el.fill(name).catch(() => {});
        filled.push('first-name');
      } else if (/last.*name|nom/i.test(meta) && profile.name) {
        const name = String(profile.name).split(' ').slice(1).join(' ');
        await el.fill(name).catch(() => {});
        filled.push('last-name');
      } else if (/email/i.test(meta) && profile.email) {
        await el.fill(profile.email).catch(() => {});
        filled.push('email');
      } else if (/phone|tel|téléphone/i.test(meta) && profile.phone) {
        await el.fill(profile.phone).catch(() => {});
        filled.push('phone');
      }
    }
    if (cvPath) {
      const fileInputs = page.locator('input[type="file"]');
      const fn = await fileInputs.count().catch(() => 0);
      if (fn > 0) {
        await fileInputs.first().setInputFiles(cvPath, { timeout: 10000 }).catch(() => {});
        filled.push('cv-attached');
      }
    }
    const coverInputs = page.locator('textarea');
    const cn = await coverInputs.count().catch(() => 0);
    if (cn > 0) {
      const first = coverInputs.first();
      await first.fill('').catch(() => {});
    }
  } catch (_) {}
  return filled;
}

async function submitLinkedInApplication(page) {
  try {
    await page.waitForTimeout(3000);
    const submitBtn = page.locator('button:has-text("Submit"), button:has-text("Submit application"), button:has-text("Candidater")').first();
    if (await submitBtn.count() > 0) {
      await submitBtn.click({ timeout: 10000 });
      await page.waitForTimeout(5000);
      const body = await page.locator('body').innerText().catch(() => '');
      if (/candidature|application|submitted|envoyé|reçu/i.test(body)) {
        return { submitted: true, confirmation: 'text detected' };
      }
    }
    const reviewBtn = page.locator('button:has-text("Review"), button:has-text("Review application")').first();
    if (await reviewBtn.count() > 0) {
      await reviewBtn.click({ timeout: 10000 });
      await page.waitForTimeout(3000);
      const submitBtn = page.locator('button:has-text("Submit application")').first();
      if (await submitBtn.count() > 0) {
        await submitBtn.click({ timeout: 10000 });
        await page.waitForTimeout(5000);
      }
    }
    const body = await page.locator('body').innerText().catch(() => '');
    return { submitted: /candidature|application|submitted|envoyé|reçu/i.test(body), confirmation: 'page check' };
  } catch (_) { return { submitted: false }; }
}

async function applyToLinkedInJob(offer, profile, cvPath) {
  const config = loadConfig();
  let ctx;
  try {
    ctx = await launchLinkedInBrowser();
    const page = await navigateToLinkedIn(ctx);
    const linkedOffer = { ...offer, link: offer.link || offer.url };
    const board = driver.detectBoard(linkedOffer);
    if (board === 'linkedin' || !offer.link) {
      if (!offer.link) {
        const searchResults = await searchJobs(page, config);
        const match = searchResults.find((r) => r.title.toLowerCase().includes((offer.title || '').toLowerCase().slice(0, 5)));
        if (match) linkedOffer.link = match.link;
      }
      if (linkedOffer.link) {
        await page.goto(linkedOffer.link, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(4000);
        const applied = await clickEasyApply(page);
        if (applied) {
          const filled = await fillLinkedInForm(page, profile, cvPath);
          const result = await submitLinkedInApplication(page);
          await stealth.stealthDelay('between_apps');
          return { ...result, filled, board: 'linkedin' };
        }
      }
    }
    return { submitted: false, reason: 'no_easy_apply' };
  } catch (e) {
    return { submitted: false, error: String(e.message || e).slice(0, 200) };
  } finally {
    try { await ctx.close().catch(() => {}); } catch (_) {}
  }
}

async function batchApply() {
  const config = loadConfig();
  const profile = await driver.profileCheck().catch(() => ({ profile: {} }));
  const profileData = profile.profile || {};
  const cvPath = path.join(DIR, '..', '..', 'CV', 'cv.pdf');
  const offers = await (async () => { try { return await api.listOffers({ limit: 100 }); } catch (_) { return []; } })();
  const eligible = offers.filter((o) => isAutoApplyOffer(o) && (o.status === 'new' || o.status === 'applied')).slice(0, config.dailyCap || 20);
  const results = [];
  for (const offer of eligible) {
    try {
      const result = await applyToLinkedInJob(offer, profileData, cvPath);
      results.push({ offerId: offer.id || offer.ref, title: offer.title, ...result });
      await stealth.stealthDelay('between_apps');
    } catch (e) {
      results.push({ offerId: offer.id || offer.ref, title: offer.title, submitted: false, error: String(e.message || e).slice(0, 200) });
    }
  }
  return { applied: results.length, total: eligible.length, results };
}

function isAutoApplyOffer(o) {
  if (!o) return false;
  const action = String(o.action || '').toLowerCase();
  return action === 'auto_apply' || action === 'autopostule' || action === 'auto-postule';
}

module.exports = {
  loadConfig,
  launchLinkedInBrowser,
  navigateToLinkedIn,
  searchJobs,
  clickEasyApply,
  fillLinkedInForm,
  submitLinkedInApplication,
  applyToLinkedInJob,
  batchApply,
  isAutoApplyOffer,
};
