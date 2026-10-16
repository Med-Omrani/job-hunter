'use strict';
// Apply driver framework — per-board job application via Playwright.
// Flow per offer: preview (fill + screenshot, NO submit) -> user confirms ->
// submit -> receipt. Manual boards stop at preview with instructions.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const api = require('./api_client.js');
const { getAnswers, workAuthFor } = require('./answers.js');
const { getEffectiveProfile } = require('./profile.js');

const DIR = __dirname;
const RUNS = path.join(DIR, '.apply-runs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function runDir(taskId) {
  const d = path.join(RUNS, String(taskId));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function hostOf(link) {
  try { return new URL(link).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return ''; }
}

// ATS family detection. These are NOT "hacks" — they are the standard applicant
// tracking systems, and each has its own known-good flow: greenhouse/lever/ashby
// are guest-first, personio/taleo/icims/jobvite/teamtailor/workable/jazzhr have
// their own form markup. detectBoard maps a link to the family so
// apply-driver knows which renderer and which login strategy to use.
//
// Key insight for RSS/outbound sources (sagemcom, himalayas, remote.co,
// remotive, remoteok): the useful URL is the EMPLOYER's ATS page, not the
// aggregator's. resolveApplyUrl() in hunter-agent.js unwraps the redirect and
// stores it as offer.applyUrl BEFORE the offer reaches this function.
const ATS_FAMILIES = [
  // [board name, host substrings (any), sourceId values]
  ['experteer', ['experteer.'], ['experteer']],
  ['workday', ['myworkdayjobs.com', 'myworkdaysite.com', 'wd1.myworkdayjobs', 'wd3.myworkdayjobs', 'wd5.myworkdayjobs', 'wd103.myworkdayjobs'], []],
  // NB: the SmartRecruiters family keeps the historical board id
  // 'workday-smart' — it owns workday-smart-profile/ and the shadow-DOM hack.
  // Renaming it would orphan that session and silently restart the bypass work.
  ['workday-smart', ['smartrecruiters.com', 'jobs.smartrecruiters', 'careers.smartrecruiters'], ['smartrecruiters']],
  ['eightfold', ['eightfold.ai', 'eightfoldhq.com'], ['eightfold']],
  ['greenhouse', ['greenhouse.io', 'greenhouse2.io', 'boards.greenhouse', 'job-boards.greenhouse'], ['greenhouse']],
  ['lever', ['lever.co'], ['lever']],
  ['ashby', ['ashbyhq.com'], ['ashby']],
  ['personio', ['personio.de', 'personio.com', 'jobs.personio'], ['personio']],
  ['taleo', ['taleo.net', 'oracle.com', 'oraclecloud.com'], ['taleo']],
  ['icims', ['icims.com'], ['icims']],
  ['jobvite', ['jobvite.com'], ['jobvite']],
  ['teamtailor', ['teamtailor.com'], ['teamtailor']],
  ['workable', ['workable.com'], ['workable']],
  ['jazzhr', ['jazzhr.com', 'apply.jazzhr'], ['jazzhr']],
  ['bamboohr', ['bamboohr.com'], ['bamboohr']],
  ['linkedin', ['linkedin.com'], ['linkedin']],
  ['tunisian', ['keejob', 'tanitjobs', 'tunisiejob', 'jobijoba', 'emploi.com'], ['keejob', 'tanitjobs', 'tunisiejob', 'jobijoba']],
  ['wttj', ['wttj.com'], ['wttj']],
  ['jobteaser', ['jobteaser.com'], ['jobteaser']],
  ['sagemcom', ['sagemcom.com'], ['sagemcom']],
  ['capgemini', ['capgemini.com'], ['capgemini']],
  ['outbound', ['remotive.com', 'remoteok.com', 'remote.co', 'himalayas'], ['remotive', 'remoteok', 'remote']],
];

// Board detection: explicit sourceId first, then link hostname.
function detectBoard(offer) {
  const o = offer || {};
  const sid = String(o.sourceId || o.source || '').toLowerCase();
  // applyUrl is the employer ATS page resolved at harvest time (WP5). It wins
  // over the aggregator listing link, otherwise outbound offers (remoteok,
  // remotive…) would always land on "outbound = manual".
  const host = hostOf(o.applyUrl || o.link || '');
  for (const [name, hosts, sids] of ATS_FAMILIES) {
    if (sids.includes(sid)) return name;
  }
  for (const [name, hosts] of ATS_FAMILIES) {
    if (hosts.some((h) => host.includes(h))) return name;
  }
  if (o.applyUrl && hostOf(o.link || '') !== host) {
    // The listing link is an aggregator we know, but the resolved ATS host is
    // unfamiliar: still manual, never improvise on an unknown host.
    // (No logger in this module by design — the worker logs the verdict.)
  }
  return 'manual';
}

// Boards the daemon can fill + submit on its own. Everything else stays
// manual on purpose: an unknown host is not a licence to improvise.
const AUTO_BOARDS = new Set(['experteer', 'workday', 'workday-smart', 'eightfold', 'tunisian', 'linkedin', 'greenhouse', 'lever', 'ashby', 'personio', 'taleo', 'icims', 'jobvite', 'teamtailor', 'workable', 'jazzhr', 'bamboohr', 'wttj', 'jobteaser']);
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

async function profileCheck() {
  const missing = [];
  const eff = await getEffectiveProfile();
  const p = { ...eff.profile };
  const profileSource = eff.source;
  const name = String(p.name || '').trim();
  const email = String(p.email || '').trim();
  const phone = String(p.phone || '').trim();
  if (!name) missing.push('nom complet (écran Profil)');
  if (!email || !email.includes('@')) missing.push('email (écran Profil)');
  if (!phone) missing.push('téléphone (écran Profil)');
  return { profile: { ...p, name, email, phone }, missing, source: profileSource };
}

async function docsCheck(offerRef) {
  const missing = [];
  let cvId = 'cv-' + offerRef;
  let lettreId = 'lettre-' + offerRef;
  try {
    const docs = await api.listDocs();
    const ids = new Set(docs.map((d) => d.id));
    if (!ids.has(cvId) || !ids.has(lettreId)) {
      missing.push(`documents non prêts — demande « adapter ${offerRef} » d'abord`);
      cvId = ''; lettreId = '';
    }
  } catch (_) { missing.push('documents illisibles (API docs)'); cvId = ''; lettreId = ''; }
  return { cvId, lettreId, missing };
}

async function launchCtx(board) {
  const profileDir = path.join(DIR, board + '-profile');
  fs.mkdirSync(profileDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: process.env.HEADLESS !== '0',
    userAgent: UA,
    viewport: { width: 1366, height: 900 },
    locale: 'fr-FR',
    acceptDownloads: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  // Inject saved session cookies for specific boards
  const sessionFiles = {
    tunisian: path.join(DIR, 'jobijoba.session.json'),
  };
  if (sessionFiles[board]) {
    try {
      const sess = JSON.parse(fs.readFileSync(sessionFiles[board], 'utf8'));
      if (Array.isArray(sess.cookies) && sess.cookies.length > 0) {
        await ctx.addCookies(sess.cookies);
      }
    } catch (_) {}
  }
  return ctx;
}


async function dismissConsent(page) {
  const labels = ['Tout accepter', 'Accepter tout', 'Accept all', 'Accepter', 'OK', 'Got it', 'J\'accepte'];
  for (const label of labels) {
    try {
      const b = page.locator(`button:text-is("${label}")`).first();
      if (await b.count()) { await b.click({ timeout: 4000 }); await page.waitForTimeout(1200); return; }
    } catch (_) {}
  }
  // cookie banners often use generic classes
  for (const sel of ['[id*="cookie"] button', '[class*="cookie"] button', '[id*="consent"] button']) {
    try {
      const b = page.locator(sel).first();
      if (await b.count()) { await b.click({ timeout: 3000 }); await page.waitForTimeout(1000); return; }
    } catch (_) {}
  }
}

async function hasApplyButton(page) {
  try {
    const c = await page.locator('button, a').filter({ hasText: /postuler|apply now|apply|candidature|je postule|bewerben/i }).count();
    return c > 0;
  } catch (_) { return false; }
}

// Generic identity fill: label/placeholder/name heuristics, never touches checkboxes/radios/selects.
async function genericFill(page, profile) {
  const { first, last } = splitName(profile.name);
  const filled = [];
  const targets = [
    { keys: ['first', 'prénom', 'prenom', 'firstname', 'given'], value: first },
    { keys: ['last', 'nom', 'lastname', 'family', 'surname'], value: last },
    { keys: ['full name', 'nom complet', 'fullname', 'your name'], value: profile.name },
    { keys: ['email', 'e-mail', 'courriel', 'mail'], value: profile.email },
    { keys: ['phone', 'téléphone', 'telephone', 'tel', 'mobile', 'portable'], value: profile.phone },
  ];
  const inputs = page.locator('input[type="text"], input[type="search"], input:not([type]), input[type="email"], input[type="tel"]');
  const n = await inputs.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 40); i++) {
    const el = inputs.nth(i);
    let meta = '';
    try {
      meta = [
        await el.getAttribute('name').catch(() => ''),
        await el.getAttribute('placeholder').catch(() => ''),
        await el.getAttribute('autocomplete').catch(() => ''),
        await el.getAttribute('aria-label').catch(() => ''),
      ].join(' ').toLowerCase();
    } catch (_) { continue; }
    // linked label text
    try {
      const id = await el.getAttribute('id').catch(() => '');
      if (id) {
        const lab = page.locator(`label[for="${id}"]`).first();
        if (await lab.count()) meta += ' ' + String(await lab.innerText().catch(() => '')).toLowerCase();
      }
    } catch (_) {}
    for (const t of targets) {
      if (!t.value) continue;
      if (t.keys.some((k) => meta.includes(k))) {
        try {
          if (!String(await el.inputValue().catch(() => '')).trim()) {
            await el.fill(t.value, { timeout: 4000 });
            filled.push(meta.slice(0, 40));
          }
        } catch (_) {}
        break;
      }
    }
  }
  return filled;
}

async function attachCv(page, runD, cvPath) {
  const inputs = page.locator('input[type="file"]');
  const n = await inputs.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    try {
      await inputs.nth(i).setInputFiles(cvPath, { timeout: 8000 });
      return true;
    } catch (_) {}
  }
  return false;
}

function maskEmail(e) {
  const [u, d] = String(e).split('@');
  if (!d) return '***';
  return (u ? u[0] + '***' : '***') + '@' + d;
}

// ================= end-to-end engine (dialog -> auth -> multi-step -> review) ====
// Rules: mandatory fields only (answers.mandatoryOnly), locked sensitive answers
// from answers.js, never invent, screenshots at every step.

async function metaFor(el, page) {
  let meta = '';
  try {
    meta = [
      await el.getAttribute('name').catch(() => ''),
      await el.getAttribute('placeholder').catch(() => ''),
      await el.getAttribute('autocomplete').catch(() => ''),
      await el.getAttribute('aria-label').catch(() => ''),
      await el.getAttribute('id').catch(() => ''),
    ].join(' ').toLowerCase();
  } catch (_) {}
  try {
    const id = await el.getAttribute('id').catch(() => '');
    if (id) {
      const lab = page.locator(`label[for="${id}"]`).first();
      if (await lab.count()) meta += ' ' + String(await lab.innerText().catch(() => '')).toLowerCase();
    }
  } catch (_) {}
  // wrapping label (Workday pattern: label > input)
  try {
    const wrap = el.locator('xpath=ancestor::label[1]');
    if (await wrap.count()) meta += ' ' + String(await wrap.innerText().catch(() => '')).toLowerCase();
  } catch (_) {}
  // field-container label (SmartRecruiters pattern: label div beside the input)
  try { meta += ' ' + String(await labelTextFor(el)).toLowerCase(); } catch (_) {}
  return meta.replace(/\s+/g, ' ').trim().slice(0, 160);
}

// Label words for inputs whose <label> isn't associated: nearest short text
// row, excluding popups (calendars, suggestion lists, option menus).
// Cached per run (field ids are stable across steps of the same page).
const labelCache = new Map();
function labelCacheClear() { try { labelCache.clear(); } catch (_) {} }
async function labelTextFor(el) {
  try {
    let key = '';
    try {
      key = String(await el.getAttribute('id').catch(() => '') || await el.getAttribute('name').catch(() => '') || await el.getAttribute('placeholder').catch(() => '')).slice(0, 80);
    } catch (_) {}
    if (key && labelCache.has(key)) return labelCache.get(key);
    const found = await el.evaluate((node) => {
      const bad = (e) => {
        if (!e || !e.closest) return true;
        try {
          if (e.closest('.flatpickr-calendar, [role="listbox"], [role="menu"], ul, datalist')) return true;
        } catch (_) {}
        return false;
      };
      const t = (e) => ((e && e.innerText) || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      const good = (s) => s && s.length >= 2 && s.length <= 45 && /[a-zA-Zàâäéèêëîïôöùûüç]{2,}/.test(s);
      // wrapping label first
      let a = node;
      for (let d = 0; d < 3 && a; d++) {
        if (/^label$/i.test(a.tagName)) { const s = t(a); if (good(s)) return s; }
        a = a.parentElement;
      }
      // nearby rows, nearest first
      let cur = node;
      for (let d = 0; d < 4 && cur; d++) {
        const par = cur.parentElement;
        if (!par) break;
        const kids = [...par.children];
        const idx = kids.indexOf(cur);
        for (let i = idx - 1; i >= Math.max(0, idx - 2); i--) {
          const k = kids[i];
          if (/^(input|select|textarea|button)$/i.test(k.tagName) || bad(k)) continue;
          const s = t(k);
          if (good(s)) return s;
        }
        cur = par;
      }
      return '';
    });
    if (key) { try { labelCache.set(key, found || ''); } catch (_) {} }
    return found || '';
  } catch (_) { return ''; }
}

// React-proof fill: native setter + input/change events (SmartRecruiters
// controlled components revert plain DOM fills). Falls back to Playwright fill,
// then to real keystrokes. Verifies the value stuck. Blurs at the end so
// validators re-run on the new value.
async function reliableFill(el, value, timeoutMs) {
  const v = String(value == null ? '' : value);
  const readback = async () => {
    try { return String(await el.inputValue().catch(() => '')); } catch (_) { return ''; }
  };
  const blurOk = async () => {
    try { await el.press('Tab').catch(() => {}); } catch (_) {}
    try { await el.page().waitForTimeout(300).catch(() => {}); } catch (_) {}
  };
  try {
    await el.fill(v, { timeout: timeoutMs || 4000 });
    if ((await readback()) === v) { await blurOk(); return true; }
  } catch (_) {}
  try {
    await el.evaluate((node, val) => {
      node.focus();
      const proto = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(node, val);
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }, v);
    await el.page().waitForTimeout(500).catch(() => {});
    if ((await readback()) === v) { await blurOk(); return true; }
  } catch (_) {}
  // Last resort: real keystrokes (React onChange commits to state).
  try {
    await el.click({ timeout: 4000 }).catch(() => {});
    await el.press('ControlOrMeta+a').catch(() => {});
    await el.pressSequentially(v, { delay: 15, timeout: 15000 }).catch(() => {});
    if ((await readback()) === v) { await blurOk(); return true; }
  } catch (_) {}
  return false;
}

// Date pickers (flatpickr): drive the widget API with an ISO date when the
// learned value is DD/MM/YYYY, else unlock readonly and fill MM/YYYY text.
async function fillDate(page, el, value) {
  const v = String(value == null ? '' : value);
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const iso = m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
  const my = m ? `${m[2].padStart(2, '0')}/${m[3]}` : v;
  try {
    const mode = await el.evaluate((node, val) => {
      try {
        if (node._flatpickr) { node._flatpickr.setDate(val, true); return 'fp'; }
      } catch (_) {}
      return '';
    }, iso || v).catch(() => '');
    if (mode === 'fp') {
      try { await el.press('Tab').catch(() => {}); } catch (_) {}
      await page.waitForTimeout(1000).catch(() => {});
      let cur = '';
      try { cur = String(await el.inputValue().catch(() => '')); } catch (_) {}
      if (cur) return true;
    }
  } catch (_) {}
  try { await el.evaluate((node) => node.removeAttribute('readonly')).catch(() => {}); } catch (_) {}
  if (await reliableFill(el, my, 4000)) return true;
  return reliableFill(el, v, 4000);
}

async function isRequired(el, page) {
  try {
    const req = await el.getAttribute('required').catch(() => null);
    if (req !== null && req !== undefined) return true;
    const aria = String(await el.getAttribute('aria-required').catch(() => '')).toLowerCase();
    if (aria === 'true') return true;
    const id = await el.getAttribute('id').catch(() => '');
    if (id) {
      const lab = page.locator(`label[for="${id}"]`).first();
      if (await lab.count()) {
        if (String(await lab.innerText().catch(() => '')).includes('*')) return true;
      }
    }
    // "Requis" error text next to the field overrides missing attributes
    // (validators mark fields required only after a Continue attempt).
    try {
      const errNear = await el.evaluate((node) => {
        const t = (e) => ((e && e.innerText) || '').trim().replace(/\s+/g, ' ').slice(0, 100);
        let cur = node;
        for (let d = 0; d < 4 && cur; d++) {
          const par = cur.parentElement;
          if (!par) break;
          const kids = [...par.children];
          const idx = kids.indexOf(cur);
          for (let i = 0; i < kids.length; i++) {
            if (i === idx) continue;
            if (/requis|required|obligatoire/i.test(t(kids[i]))) return true;
          }
          cur = par;
        }
        return false;
      }).catch(() => false);
      if (errNear) return true;
    } catch (_) {}
    // Custom widgets: red asterisk in a nearby label row ("Intitulé *").
    try {
      const star = await el.evaluate((node) => {
        const t = (e) => ((e && e.innerText) || '').slice(0, 80);
        const prev = node.previousElementSibling;
        if (prev && /\*/.test(t(prev))) return true;
        const par = node.parentElement;
        if (par) {
          const kids = [...par.children];
          const idx = kids.indexOf(node);
          for (let i = idx - 1; i >= Math.max(0, idx - 2); i--) {
            if (/\*/.test(t(kids[i]))) return true;
          }
          // label one level up (field wrapper pattern: label-div + input-div)
          const gp = par.parentElement;
          if (gp) {
            const gkids = [...gp.children];
            const pidx = gkids.indexOf(par);
            for (let i = pidx - 1; i >= Math.max(0, pidx - 1); i--) {
              if (/\*/.test(t(gkids[i]))) return true;
            }
          }
          let a = node;
          for (let d = 0; d < 3 && a; d++) {
            if (a.tagName === 'LABEL' && /\*/.test(t(a))) return true;
            a = a.parentElement;
          }
        }
        return false;
      });
      if (star) return true;
    } catch (_) {}
  } catch (_) {}
  return false;
}

// International phone widgets: country search/select + national number.
// Handles both sibling <select> and section-level search inputs (SmartRecruiters).
async function fillPhoneIntl(page, profile, requiredOnly) {
  const filled = [];
  const digits = String(profile.phone || '').replace(/\D/g, '');
  if (!digits) return filled;
  let national = digits;
  let wantCountryRe = /tunis/i.test(profile.country || '') ? /tunisia/i : null;
  for (const prefix of ['00216', '216']) {
    if (digits.startsWith(prefix)) { national = digits.slice(prefix.length); wantCountryRe = /tunisia/i; break; }
  }
  const countryName = profile.country || '';
  const inputs = page.locator('input[type="tel"]');
  const n = await inputs.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 10); i++) {
    const el = inputs.nth(i);
    try { if (!(await el.isVisible())) continue; } catch (_) { continue; }
    if (requiredOnly && !(await isRequired(el, page))) continue;
    try {
      const cur = String(await el.inputValue().catch(() => '')).trim();
      if (cur) continue;
    } catch (_) {}
    // 1. sibling <select> country picker
    try {
      const sib = el.locator('xpath=preceding-sibling::*[1]');
      if (await sib.count()) {
        const tag = String(await sib.evaluate((e) => e.tagName).catch(() => ''));
        if (/select/i.test(tag)) {
          const opts = await sib.locator('option').allInnerTexts().catch(() => []);
          const pick = opts.find((o) => countryOptionMatch(o, profile.country || ''));
          if (pick) {
            try { await sib.selectOption({ label: pick }).catch(() => {}); } catch (_) {}
            if (await reliableFill(el, national, 4000)) { filled.push('phone-intl=>' + national); continue; }
          }
        }
      }
    } catch (_) {}
    // 2. section-level country search input (type country, pick suggestion)
    try {
      const section = el.locator('xpath=ancestor::*[self::div or self::section or self::form][1]');
      const srch = section.locator('input').filter({ hasNotText: /^$/ }).first();
      void srch;
      const cand = page.locator('input[placeholder*="pays" i], input[placeholder*="country" i], input[placeholder*="gion" i], input[placeholder*="code" i], input[aria-label*="pays" i], input[aria-label*="country" i]');
      const cn = await cand.count().catch(() => 0);
      for (let k = 0; k < Math.min(cn, 5); k++) {
        const c = cand.nth(k);
        let vis = false;
        try { vis = await c.isVisible(); } catch (_) {}
        if (!vis) continue;
        try {
          await reliableFill(c, countryName, 4000);
          await page.waitForTimeout(2000).catch(() => {});
          const sug = page.locator('[role="option"]').filter({ hasText: new RegExp(String(countryName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 5), 'i') }).first();
          if (await sug.count()) { await sug.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(1500).catch(() => {}); }
          if (await reliableFill(el, national, 4000)) { filled.push('phone-intl=>' + national); break; }
        } catch (_) {}
      }
      const cur2 = String(await el.inputValue().catch(() => '')).trim();
      if (cur2) continue;
    } catch (_) {}
  }
  return filled;
}

// Normalized answer key: accent-folded so « Intitulé* » → intitule,
// « À » → a (plain stripping would erase both).
function normKey(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
// NEVER_FILL_RE guards fields we cannot safely fill from profile/learned.
// Intentionally excludes: intitulé/job title (learned.intitule), ville/lieu
// (profile.city) — those are now filled proactively via learned-key targets.
const NEVER_FILL_RE = /\bemployeur\b|\bentreprise\b|\bcompany\b|societ[eé]|\bsalaire\b|\bsalary\b|pr[eé]tention|date de d[eé]but|date de fin|\bstart date\b|\bend date\b|emplacement du bureau|office location|ann[eé]es? d.exp/i;

async function fieldName(el, meta) {
  const cands = [];
  try {
    const a = await el.getAttribute('aria-label').catch(() => null);
    if (a) cands.push(String(a).trim().slice(0, 40));
  } catch (_) {}
  try {
    const lab = await labelTextFor(el);
    if (lab) cands.push(lab.slice(0, 60));
  } catch (_) {}
  const m = String(meta || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (m) cands.push(m);
  for (const c of cands) {
    if (!c || c.length < 1 || c.length > 60) continue;
    if (/^(null|undefined|input|text|on)$/i.test(c)) continue;
    if (!/[a-zA-Zàâäéèêëîïôöùûüç]{2,}/.test(c)) continue;
    if (/janv|fév|mars|avr|juin|juil|août|sept|oct|nov|déc/i.test(c) && c.length > 30) continue;
    return c;
  }
  return 'champ';
}

// Required-only text fill (extends genericFill with required filtering).
async function fillText(page, profile, requiredOnly, answers) {
  const { first, last } = splitName(profile.name);
  const filled = [];
  const unanswered = [];
  const learned = (answers && answers.learned) || {};
  const targets = [
    { keys: ['first', 'prenom', 'firstname', 'given'], value: first },
    { keys: ['last', 'nom', 'lastname', 'family', 'surname'], value: last },
    { keys: ['full name', 'nom complet', 'fullname', 'your name'], value: profile.name },
    { keys: ['email', 'e-mail', 'courriel', 'mail'], value: profile.email },
    { keys: ['phone', 'telephone', 'tel', 'mobile', 'portable'], value: profile.phone },
    { keys: ['city', 'ville', 'lieu de residence', 'lieu residence', 'residence', 'location'], value: profile.city || learned.ville || '' },
    { keys: ['country', 'pays'], value: profile.country || '' },
    // Job title — from learned (user-approved, never invented)
    { keys: ['intitule', 'intitulé', 'job title', 'titre du poste', 'titre poste', 'titre actuel', 'current title', 'current position', 'poste actuel'], value: learned.intitule || '' },
  ];
  const inputs = page.locator('input[type="text"], input[type="search"], input:not([type]), input[type="email"], input[type="tel"]');
  const n = await inputs.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 40); i++) {
    const el = inputs.nth(i);
    try { if (!(await el.isVisible())) continue; } catch (_) { continue; }
    let meta = '';
    try { meta = await metaFor(el, page); } catch (_) { continue; }
    const req = await isRequired(el, page);
    let labNorm = '';
    try {
      const aria = await el.getAttribute('aria-label').catch(() => null);
      if (aria && aria.trim()) labNorm = normKey(aria);
    } catch (_) {}
    if (!labNorm) labNorm = normKey(await labelTextFor(el).catch(() => ''));
    if (NEVER_FILL_RE.test(meta) && !(labNorm && learned[labNorm])) {
      if (req) unanswered.push({ field: await fieldName(el, meta), type: 'text' });
      continue;
    }
    if (requiredOnly && !req) continue;
    let done = false;
    for (const t of targets) {
      if (!t.value) continue;
      if (t.keys.some((k) => meta.includes(k))) {
        try {
          const cur = String(await el.inputValue().catch(() => '')).trim();
          // Identity fields: profile is the source of truth — normalize any
          // stale draft (saved form drafts from previous runs) to it.
          // For autocomplete fields (city, intitule), force refill even if text matches,
          // because restored drafts lose their internal selected ID.
          const isAutoComp = t.keys.includes('city') || t.keys.includes('ville') || t.keys.includes('intitule');
          if (cur !== t.value || isAutoComp) {
            if (await reliableFill(el, t.value, 4000)) {
              filled.push(meta.slice(0, 40));
              if (isAutoComp) {
                await page.waitForTimeout(1500).catch(() => {});
                await el.press('ArrowDown', { timeout: 2000 }).catch(() => {});
                await page.waitForTimeout(500).catch(() => {});
                await el.press('Enter', { timeout: 2000 }).catch(() => {});
                // Wicked trick: aggressively hunt any visible option and force click
                try {
                  const sugs = page.locator('[role="option"], li[role="treeitem"], .autocomplete-suggestion, [data-test="dropdown-item"], .sr-location-autocomplete-suggestion');
                  const cn = await sugs.count().catch(()=>0);
                  for (let q=0; q<cn; q++) {
                    if (await sugs.nth(q).isVisible().catch(()=>false)) {
                      await sugs.nth(q).click({force: true, timeout: 2000}).catch(()=>{});
                      break;
                    }
                  }
                } catch(_) {}
              }
            }
          }
        } catch (_) {}
        done = true;
        break;
      }
    }
    if (!done && req) {
      // Explicit user answers (chat) apply even to guarded fields.
      const lv = labNorm && learned[labNorm];
      if (lv) {
        try {
          const isDate = /date|du$|^a$|d.but|fin|start|end|choisissez/i.test(meta + ' ' + labNorm);
          const ok = isDate
            ? await fillDate(page, el, String(lv).slice(0, 200))
            : await reliableFill(el, String(lv).slice(0, 200), 4000);
          if (ok) { filled.push('learned:' + labNorm); done = true; }
        } catch (_) {}
      }
      if (!done) unanswered.push({ field: await fieldName(el, meta), type: 'text' });
    }
  }
  return { filled, unanswered };
}

// Policy for a <select>: returns a predicate matching the option we are
// ALLOWED to choose, or null when we have no approved answer. NEVER falls back
// to a hardcoded default — an unknown sensitive question must stay unknown so
// the caller can ask the user (see answers.js header: sensitive items are
// never invented). `learned` holds explicit user replies from chat.
function selectPolicy(meta, answers, profile, learned) {
  const a = answers || {};
  const l = learned || {};
  const has = (k) => { const v = l[k]; return v ? String(v).trim() : ''; };
  if (/countr|pays|nation/.test(meta)) {
    const c = String((profile && profile.country) || '').trim();
    if (!c) return null;
    return { kind: 'country', value: c, test: (o) => countryOptionMatch(o, c) };
  }
  if (/gender|sexe/.test(meta)) {
    const g = has('gender') || String(a.gender || '').trim();
    if (!g) return null;
    const rx = /^(f|female|femme|f)\b/i.test(g) ? /^(f|female|femme|f)\b/i : /^(m|male|homme|m)\b/i;
    return { kind: 'gender', value: g, test: (o) => rx.test(String(o).trim()) };
  }
  if (/disab|handicap|invalide/.test(meta)) {
    const d = has('disability') || (a.disability === undefined ? '' : (a.disability ? 'yes' : 'no'));
    if (!d) return null;
    const yes = /^(y|yes|oui|o)\b/i.test(String(d));
    return { kind: 'disability', value: d, test: (o) => (yes ? /^(y|yes|oui|o)\b/i : /^(n|no|non)\b/i).test(String(o).trim()) };
  }
  if (/veteran/.test(meta)) {
    const v = has('veteran') || (a.veteran === undefined ? '' : (a.veteran ? 'yes' : 'no'));
    if (!v) return null;
    const yes = /^(y|yes|oui|o)\b/i.test(String(v));
    return { kind: 'veteran', value: v, test: (o) => (yes ? /^(y|yes|oui|o)\b/i : /not .*veteran|not a veteran|^(n|no|non)\b/i).test(String(o).trim()) };
  }
  if (/race|ethnic|origine/.test(meta)) {
    const e = has('race') || String(a.ethnicity || '').trim();
    if (!e) return null;
    const decline = /decline|prefer not|don.t wish|ne souhaite/i.test(e);
    return { kind: 'ethnicity', value: e, test: (o) => (decline ? /decline|prefer not|don.t wish|ne souhaite/i.test(String(o)) : new RegExp(e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(String(o))) };
  }
  // Generic learned answer for any other select (e.g. 'niveau_etudes',
  // 'type_contrat'): only if the user explicitly answered this question before.
  const k = normKey(meta);
  const lv = has(k);
  if (lv) {
    const esc = lv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { kind: 'learned', value: lv, test: (o) => new RegExp(esc, 'i').test(String(o)) };
  }
  return null;
}

async function fillSelects(page, answers, requiredOnly, profile, step) {
  const filled = [], unanswered = [];
  const learned = (answers && answers.learned) || {};
  const sels = page.locator('select');
  const n = await sels.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 20); i++) {
    const el = sels.nth(i);
    try { if (!(await el.isVisible())) continue; } catch (_) { continue; }
    let enabled = true;
    try { enabled = await el.isEnabled().catch(() => true); } catch (_) {}
    if (!enabled) continue;
    const meta = await metaFor(el, page);
    const req = await isRequired(el, page);
    if (requiredOnly && !req) continue;
    let opts = [];
    try {
      const texts = await el.locator('option').allInnerTexts().catch(() => []);
      for (const o of texts) { const t = String(o).trim().replace(/\s+/g, ' '); if (t) opts.push(t); }
    } catch (_) {}
    if (!opts.length) continue;
    const pol = selectPolicy(meta, answers, profile, learned);
    let picked = '';
    if (pol) picked = opts.find((o) => { try { return pol.test(o); } catch (_) { return false; } }) || '';
    if (picked) {
      // label match first, then value match (SmartRecruiters/Eightfold often
      // ship options whose visible label differs from the submitted value).
      let done = false;
      try { await el.selectOption({ label: picked }, { timeout: 4000 }); done = true; } catch (_) {}
      if (!done) {
        try {
          const val = await el.locator('option').evaluateAll((os, want) => {
            const hit = os.find((o) => ((o.innerText || o.textContent || '').trim()) === want);
            return hit ? hit.value : '';
          }, picked).catch(() => '');
          if (val) { await el.selectOption({ value: val }, { timeout: 4000 }); done = true; }
        } catch (_) {}
      }
      if (done) filled.push(meta.slice(0, 30) + '=>' + picked.slice(0, 30));
      else if (req) unanswered.push({ field: (meta || 'champ').slice(0, 80), type: 'select', options: opts.slice(0, 12), required: true, step: step || 0 });
    } else if (req) {
      // No approved answer: ask, never guess.
      unanswered.push({ field: (meta || 'champ').slice(0, 80), type: 'select', options: opts.slice(0, 12), required: true, step: step || 0 });
    }
  }
  return { filled, unanswered };
}

async function fillChecks(page, answers, requiredOnly, step) {
  const filled = [], unanswered = [];
  const inputs = page.locator('input[type="radio"], input[type="checkbox"]');
  const n = await inputs.count().catch(() => 0);
  const groups = new Map(); // name -> {els:[], meta:''}
  for (let i = 0; i < Math.min(n, 60); i++) {
    const el = inputs.nth(i);
    let name = '';
    try { name = String(await el.getAttribute('name').catch(() => '') || ('idx' + i)); } catch (_) { name = 'idx' + i; }
    if (!groups.has(name)) groups.set(name, { els: [], meta: '' });
    groups.get(name).els.push(el);
  }
  for (const [name, g] of groups) {
    let meta = String(name).toLowerCase();
    try {
      const first = g.els[0];
      meta += ' ' + await metaFor(first, page);
      const fs = first.locator('xpath=ancestor::fieldset[1]');
      if (await fs.count()) meta += ' ' + String(await fs.innerText().catch(() => '')).toLowerCase().slice(0, 200);
    } catch (_) {}
    meta = meta.replace(/\s+/g, ' ').trim().slice(0, 220);
    const type = String(await g.els[0].getAttribute('type').catch(() => '')).toLowerCase();
    const req = await isRequired(g.els[0], page);
    if (requiredOnly && !req && type === 'checkbox') continue;
    if (requiredOnly && !req) continue;
    const optTexts = [];
    for (const el of g.els) {
      let t = await metaFor(el, page);
      if (!t) { try { t = String(await el.getAttribute('value').catch(() => '')); } catch (_) {} }
      optTexts.push({ el, t: t.slice(0, 80) });
    }
    const kind =
      /gender|sexe/.test(meta) ? 'gender' :
      /disab|handicap|invalide/.test(meta) ? 'disability' :
      /veteran/.test(meta) ? 'veteran' :
      /race|ethnic|origine/.test(meta) ? 'ethnicity' : '';
    // Only act on a sensitive group when the answer file/learned map actually
    // provides the value. An absent answer stays absent -> ask, never guess.
    const learned = (answers && answers.learned) || {};
    const learnedKey = { gender: 'gender', disability: 'disability', veteran: 'veteran', ethnicity: 'race' }[kind];
    let approved = '';
    if (kind) {
      const lv = learnedKey ? learned[learnedKey] : '';
      if (lv) approved = String(lv);
      else if (kind === 'gender' && answers && answers.gender !== undefined) approved = String(answers.gender);
      else if (kind === 'disability' && answers && answers.disability !== undefined) approved = answers.disability ? 'yes' : 'no';
      else if (kind === 'veteran' && answers && answers.veteran !== undefined) approved = answers.veteran ? 'yes' : 'no';
      else if (kind === 'ethnicity' && answers && answers.ethnicity) approved = String(answers.ethnicity);
    } else {
      const gk = normKey(meta);
      if (learned[gk]) approved = String(learned[gk]);
    }
    let target = -1;
    if (approved) {
      const a = approved.trim();
      if (/^(f|female|femme|f)\b/i.test(a)) target = optTexts.findIndex((o) => /(^|\b)(f|female|femme)\b/i.test(o.t) && !/male/i.test(o.t));
      else if (/^(m|male|homme|m)\b/i.test(a)) target = optTexts.findIndex((o) => /(^|\b)(m|male|homme)\b/i.test(o.t) && !/female/i.test(o.t));
      else if (/^(y|yes|oui|o|true|1)\b/i.test(a)) target = optTexts.findIndex((o) => /(^|\b)(y|yes|oui|o|true)\b/i.test(o.t));
      else if (/^(n|no|non|false|0)\b/i.test(a)) target = optTexts.findIndex((o) => /not .*veteran|not a veteran|(^|\b)(n|no|non|false)\b/i.test(o.t));
      else if (/decline|prefer not|don.t wish|ne souhaite/i.test(a)) target = optTexts.findIndex((o) => /decline|prefer not|don.t wish|ne souhaite/i.test(o.t));
      else target = optTexts.findIndex((o) => o.t.toLowerCase().includes(a.toLowerCase()));
    }
    if (target >= 0) {
      try {
        if (type === 'checkbox') await optTexts[target].el.check({ timeout: 4000 }).catch(() => {});
        else await optTexts[target].el.check({ timeout: 4000 }).catch(() => {});
        filled.push(meta.slice(0, 40) + '=>' + optTexts[target].t.slice(0, 30));
      } catch (_) {}
    } else if (req) {
      unanswered.push({ field: meta.slice(0, 100), type: type || 'check', options: optTexts.map((o) => o.t).slice(0, 10), required: true, step: step || 0 });
    }
  }
  return { filled, unanswered };
}

// Email coherence: confirmation fields must equal the primary email
// (mismatches invalidate the whole form server-side). Matches by meta words
// AND by pairing: two email-ish inputs in the same row, second = confirm.
async function cohereEmails(page, primaryEmail) {
  const fixed = [];
  try {
    const emailIdx = []; // collect all email-like inputs first
    const inputs = page.locator('input[type="email"], input[type="text"], input[type="search"], input:not([type])');
    const n = await inputs.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 40); i++) {
      const el = inputs.nth(i);
      try { if (!(await el.isVisible())) continue; } catch (_) { continue; }
      const meta = await metaFor(el, page).catch(() => '');
      if (!/e-?mail|courriel/.test(meta)) continue;
      emailIdx.push({ el, meta });
    }
    // explicit confirm fields first
    for (const { el, meta } of emailIdx) {
      if (!/confirmez|confirm|repeat|re-enter|verify|second/.test(meta)) continue;
      let cur = '';
      try { cur = String(await el.inputValue().catch(() => '')).trim(); } catch (_) {}
      if (cur !== primaryEmail) {
        if (await reliableFill(el, primaryEmail, 4000)) fixed.push(meta.slice(0, 40));
      }
    }
    // row pairing: same parent, 2+ email inputs, values differ -> align to primary
    const groups = new Map();
    for (let k = 0; k < emailIdx.length; k++) {
      let key = 'g' + k;
      try {
        key = await emailIdx[k].el.evaluate((node) => {
          const p = node.parentElement;
          if (!p) return 'none';
          const sibs = [...p.querySelectorAll('input')].length;
          return sibs + ':' + (p.className || '').toString().slice(0, 30);
        }).catch(() => 'g' + k);
      } catch (_) {}
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(emailIdx[k]);
    }
    for (const [, g] of groups) {
      if (g.length < 2) continue;
      for (let j = 1; j < g.length; j++) {
        let cur = '';
        try { cur = String(await g[j].el.inputValue().catch(() => '')).trim(); } catch (_) {}
        if (cur !== primaryEmail) {
          try { await g[j].el.fill(primaryEmail, { timeout: 4000 }); fixed.push('paired-confirm'); } catch (_) {}
        }
      }
    }
  } catch (_) {}
  return fixed;
}

// Visible validation errors (to block submits, never to fix blindly).
// Blurs + waits first so stale messages from intermediate states clear.
// Reads twice: only errors persisting across both reads count.
async function formErrors(page) {
  const readOnce = async () => {
    const hits = [];
    try {
      const els = page.locator('.error, .field-error, .form-error, [role="alert"], .invalid-feedback, .help-block.text-danger, p.error');
      const n = await els.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 15); i++) {
        let vis = false;
        try { vis = await els.nth(i).isVisible(); } catch (_) {}
        if (!vis) continue;
        let t = '';
        try { t = String(await els.nth(i).innerText()).trim().replace(/\s+/g, ' ').slice(0, 120); } catch (_) {}
        if (t) hits.push(t);
      }
    } catch (_) {}
    return hits;
  };
  try { await page.keyboard.press('Tab').catch(() => {}); } catch (_) {}
  try { await page.waitForTimeout(2000).catch(() => {}); } catch (_) {}
  const a = await readOnce();
  if (!a.length) return [];
  try { await page.waitForTimeout(3000).catch(() => {}); } catch (_) {}
  const b = await readOnce();
  return a.filter((x) => b.includes(x));
}

// Country matching across locales (Tunisia/Tunisie, etc.): first-5-letters
// substring is stable across languages for almost every country.
function countryOptionMatch(optionText, country) {
  const c = String(country || '').trim().toLowerCase();
  if (!c) return false;
  const stem = c.replace(/[^a-z]/g, '').slice(0, 5);
  if (!stem) return false;
  return String(optionText || '').toLowerCase().includes(stem);
}

// Location-search widgets (autocomplete dropdowns): after a city value was
// typed, pick the suggestion matching it. Scoped to the input's own section
// (never page-wide lists). Runs only mid-form, right after fill.
async function pickLocationSuggestions(page, city) {
  const picked = [];
  if (!city) return picked;
  const esc = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(esc, 'i');
  // Re-open: retype the city so the suggestion list is freshly open now
  // (it auto-closes after seconds of inactivity).
  try {
    const inputs = page.locator('input[type="text"], input[type="search"], input:not([type])');
    const n = await inputs.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 40); i++) {
      const el = inputs.nth(i);
      let v = '';
      try { v = String(await el.inputValue().catch(() => '')); } catch (_) { continue; }
      if (!v || !rx.test(v)) continue;
      try {
        await el.click({ timeout: 4000 }).catch(() => {});
        await reliableFill(el, v, 4000);
        await page.waitForTimeout(2000).catch(() => {});
      } catch (_) {}
      break;
    }
  } catch (_) {}
  // Exact canonical pick FIRST ("Tunis, Tunisie" or "Tunis, Tunisia"):
  // tag-agnostic getByText, mouse coordinates. Highest confidence.
  if (!picked.length && city) {
    try {
      const cityStem = city.toLowerCase().replace(/[^a-z]/g, '').slice(0, 5);
      const exact = page.getByText(new RegExp('^\\s*' + esc + '\\s*,\\s*' + cityStem + '\\w*\\s*$', 'i')).first();
      if (await exact.count().catch(() => 0) > 0) {
        let vis = false;
        try { vis = await exact.isVisible(); } catch (_) {}
        if (vis) {
          try { await exact.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {}); } catch (_) {}
          try {
            const box = await exact.boundingBox({ timeout: 3000 }).catch(() => null);
            if (box) {
              await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
              await page.waitForTimeout(2000).catch(() => {});
              picked.push('exact-pick');
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
  // Keyboard first (same focus session as typing): ArrowDown + Enter on the
  // open list, before any click elsewhere can blur it shut.
  if (!picked.length) {
    try {
      const inputs = page.locator('input[type="text"], input[type="search"], input:not([type])');
      const n = await inputs.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 40); i++) {
        const el = inputs.nth(i);
        let v = '';
        try { v = String(await el.inputValue().catch(() => '')); } catch (_) { continue; }
        if (!v || !rx.test(v)) continue;
        try {
          await el.click({ timeout: 4000 }).catch(() => {});
          await page.waitForTimeout(1500).catch(() => {});
          await el.press('ArrowDown', { timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(500).catch(() => {});
          await el.press('Enter', { timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(2000).catch(() => {});
          let nv = '';
          try { nv = String(await el.inputValue().catch(() => '')); } catch (_) {}
          if (nv && nv !== v) { picked.push('kbd:' + nv.slice(0, 50)); break; }
          // dropdown may have closed with selection applied invisibly: check
          try {
            const still = await page.getByText(/remplir manuellement/i).count().catch(() => 0);
            if (still === 0) { picked.push('kbd:closed'); break; }
          } catch (_) {}
        } catch (_) {}
      }
    } catch (_) {}
  }
  // Scoped click pass (suggestions under the field's own section).
  try {
    await page.waitForTimeout(1500).catch(() => {});
    const inputs = page.locator('input[type="text"], input[type="search"], input:not([type])');
    const n = await inputs.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 40); i++) {
      const el = inputs.nth(i);
      let v = '';
      try { v = String(await el.inputValue().catch(() => '')); } catch (_) { continue; }
      if (!v || !rx.test(v)) continue;
      // climb to the field section, look for a suggestion item inside it
      for (let d = 0; d < 5; d++) {
        let scope = null;
        try { scope = el.locator('xpath=ancestor::*[' + (d + 1) + ']'); } catch (_) { break; }
        const items = scope.locator('li, [role="option"], div[data-value], div[role="button"]');
        const m = Math.min(await items.count().catch(() => 0), 12);
        for (let k = 0; k < m; k++) {
          const it = items.nth(k);
          let vis = false;
          try { vis = await it.isVisible(); } catch (_) {}
          if (!vis) continue;
          let t = '';
          try { t = String(await it.innerText()).trim().replace(/\s+/g, ' '); } catch (_) {}
          if (t && t.length < 120 && rx.test(t)) {
            try { await it.click({ timeout: 4000 }); picked.push(t.slice(0, 50)); } catch (_) {}
            break;
          }
        }
        if (picked.length) break;
      }
      if (picked.length) break;
    }
  } catch (_) {}
  // Portal-rendered / virtualized dropdowns: wheel the list until the option
  // renders, then click. Strict start-match only (never page-list items).
  if (!picked.length) {
    // Fast exit: no open suggestion list at all (common case).
    let listOpen = false;
    try {
      const probe = page.locator('li, [role="option"], [data-value]');
      const pm = Math.min(await probe.count().catch(() => 0), 40);
      for (let k = 0; k < pm; k++) {
        try { if (await probe.nth(k).isVisible()) { listOpen = true; break; } } catch (_) {}
      }
    } catch (_) {}
    if (!listOpen) return picked;
    try {
      const strict = new RegExp('^\\s*' + esc + '\\b', 'i');
      for (let w = 0; w < 6 && !picked.length; w++) {
        const items = page.locator('li, [role="option"], [data-value], div');
        const m = Math.min(await items.count().catch(() => 0), 80);
        for (let k = 0; k < m; k++) {
          const it = items.nth(k);
          let vis = false;
          try { vis = await it.isVisible(); } catch (_) {}
          if (!vis) continue;
          let t = '';
          try { t = String(await it.innerText()).trim().replace(/\s+/g, ' '); } catch (_) {}
          if (t && t.length < 120 && strict.test(t)) {
            try { await it.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {}); } catch (_) {}
            try { await it.click({ timeout: 4000 }); picked.push(t.slice(0, 50)); break; } catch (_) {}
          }
        }
        if (picked.length) break;
        try {
          const fvis = page.locator('li, [role="option"]').first();
          try { await fvis.hover({ timeout: 3000 }); } catch (_) {}
          await page.mouse.wheel(0, 600).catch(() => {});
          await page.waitForTimeout(800).catch(() => {});
        } catch (_) { break; }
      }
    } catch (_) {}
  }
  // Manual city fallback ("remplir manuellement"): bypasses suggestion-pick.
  if (!picked.length) {
    try {
      const man = page.getByText(/remplir manuellement/i).first();
      const mc = await man.count().catch(() => 0);
      if (mc > 0) {
        await man.click({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(2500).catch(() => {});
        picked.push('manual-mode');
      }
    } catch (_) {}
  }
  return picked;
}

// Error-anchored fields: the page's own validation ("Intitulé est requis")
// points at its field. Reverse-lookup input from error text — robust when
// labels carry no usable words. Values come ONLY from profile/learned.
async function errorFields(page) {
  const out = [];
  try {
    const els = page.locator('.error, .field-error, .form-error, [role="alert"], .invalid-feedback, p.error, span.error, div.error');
    const n = await els.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 15); i++) {
      const el = els.nth(i);
      let vis = false;
      try { vis = await el.isVisible(); } catch (_) {}
      if (!vis) continue;
      let t = '';
      try { t = String(await el.innerText()).trim().replace(/\s+/g, ' ').slice(0, 150); } catch (_) {}
      if (!t) continue;
      let target = null;
      // 1. ancestor-2, -3, -4 container (SmartRecruiters/Workday: error inside field wrapper)
      for (const depth of [2, 3, 4, 5]) {
        try {
          const up = el.locator('xpath=ancestor::*[' + depth + ']');
          // Get all inputs in this wrapper
          const inners = up.locator('input, select, textarea');
          const count = await inners.count();
          for (let k = 0; k < count; k++) {
            const cand = inners.nth(k);
            if (await cand.isVisible().catch(() => false)) {
              target = cand;
              break;
            }
          }
          if (target) break;
        } catch (_) {}
      }
      // 2. preceding visible input (fallback)
      if (!target) {
        try {
          const prevs = el.locator('xpath=preceding::input | preceding::textarea | preceding::select');
          const pc = await prevs.count();
          for (let k = pc - 1; k >= Math.max(0, pc - 5); k--) {
            const cand = prevs.nth(k);
            if (await cand.isVisible().catch(() => false)) {
              target = cand;
              break;
            }
          }
        } catch (_) {}
      }
      if (target) {
        out.push({ err: t, el: target });
      }
    }
  } catch (e) {
     console.error("errorFields error:", e);
  }
  return out;
}

// Fill by error text using only known values. Returns {filled, unanswered}.
async function fillByErrors(page, profile, answers) {
  const filled = [];
  const unanswered = [];
  const learned = (answers && answers.learned) || {};
  const errs = await errorFields(page).catch(() => []);
  for (const { err, el } of errs) {
    if (!el) continue;
    const e = err.toLowerCase();
    let val = '';
    let kind = '';
    if (/intitul|job title|titre du poste/.test(e)) { val = learned.intitule || ''; kind = 'intitule'; }
    else if (/lieu|r.sidence|ville|city|location/.test(e)) { val = profile.city || ''; kind = 'ville'; }
    else if (/e-?mail|courriel/.test(e)) { val = profile.email || ''; kind = 'email'; }
    else if (/t.l.phone|phone|t.l\b/.test(e)) { val = profile.phone || ''; kind = 'phone'; }
    else if (/\bdu\b|d.but|start|depuis/.test(e)) { val = learned.du || ''; kind = 'du'; }
    else if (/fin\b|end|jusqu/.test(e)) { val = learned.a || ''; kind = 'a'; }
    if (!val) { unanswered.push({ field: err.slice(0, 80), type: 'error' }); continue; }
    try {
      const cur = String(await el.inputValue().catch(() => '')).trim();
      // If it threw an error but already matches the target text, it's a restored
      // draft of an autocomplete widget that lost its internal ID. Force re-fill!
      const isAutoComp = kind === 'ville' || kind === 'intitule';
      if (cur !== val || isAutoComp) {
        if (await reliableFill(el, val, 4000)) {
          filled.push(kind + ':' + val.slice(0, 20));
          if (isAutoComp) {
            await page.waitForTimeout(1500).catch(() => {});
            await el.press('ArrowDown', { timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(500).catch(() => {});
            await el.press('Enter', { timeout: 2000 }).catch(() => {});
            // Wicked trick: aggressively hunt any visible option and force click
            try {
              const sugs = page.locator('[role="option"], li[role="treeitem"], .autocomplete-suggestion, [data-test="dropdown-item"], .sr-location-autocomplete-suggestion');
              const cn = await sugs.count().catch(()=>0);
              for (let q=0; q<cn; q++) {
                if (await sugs.nth(q).isVisible().catch(()=>false)) {
                  await sugs.nth(q).click({force: true, timeout: 2000}).catch(()=>{});
                  break;
                }
              }
            } catch(_) {}
          }
        }
      }
    } catch (_) {}
  }
  return { filled, unanswered };
}
async function allVisibleText(page, maxLen) {
  const parts = [];
  try {
    for (const fr of page.frames()) {
      try {
        const t = await fr.locator('body').innerText({ timeout: 5000 }).catch(() => '');
        if (t && t.trim()) parts.push(t);
      } catch (_) {}
    }
  } catch (_) {}
  if (!parts.length) {
    try { parts.push(String(await page.content().catch(() => ''))); } catch (_) {}
  }
  return parts.join('\n').slice(0, maxLen || 12000);
}

// Diagnostic DOM dump: every field's markup summary (for precise matcher fixes).
// Walks ALL frames (SmartRecruiters embeds its form in an iframe).
async function dumpInputs(page, runD, name) {
  try {
    const all = [];
    for (const fr of page.frames()) {
      let data = [];
      try {
        data = await fr.evaluate(() => {
          const describe = (el) => {
            const lab = el.id ? document.querySelector('label[for="' + el.id + '"]') : null;
            const par = el.parentElement;
            return {
              tag: el.tagName, type: el.getAttribute('type') || '', name: el.name || '',
              id: el.id || '', ph: el.getAttribute('placeholder') || '',
              aria: el.getAttribute('aria-label') || '',
              cls: (el.className || '').toString().slice(0, 60),
              req: el.hasAttribute('required'), ariaReq: el.getAttribute('aria-required') || '',
              labFor: lab ? String(lab.innerText).slice(0, 50) : '',
              prev: par && par.previousElementSibling ? String(par.previousElementSibling.innerText || '').slice(0, 50) : '',
              parCls: par ? (par.className || '').toString().slice(0, 60) : '',
              val: String(el.value || '').slice(0, 40),
            };
          };
          const out = [];
          const walk = (root) => {
            if (!root || !root.querySelectorAll) return;
            root.querySelectorAll('input, select, textarea').forEach((el) => { if (out.length < 80) out.push(describe(el)); });
            root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
          };
          walk(document);
          return out;
        });
      } catch (_) {}
      if (data && data.length) {
        let furl = '';
        try { furl = fr.url().slice(0, 80); } catch (_) {}
        all.push({ frame: furl, fields: data });
      }
    }
    require('fs').writeFileSync(require('path').join(runD, name + '.json'), JSON.stringify(all, null, 1));
  } catch (_) {}
}

// ================= FIELD INVENTORY (scanFields) =================
// Complete inventory of every interactive field on the current page, including
// open shadow roots and custom widgets. Used to (a) diagnose why a board
// stalls and (b) build the ask-back questions: we report the REAL label, type
// and option list of each mandatory field, so the user answers a concrete
// question instead of us guessing. Read-only: never types, never clicks.
async function scanFields(page) {
  const all = [];
  for (const fr of page.frames()) {
    let data = [];
    try {
      data = await fr.evaluate(() => {
        const seen = new Set();
        const isVisible = (el) => {
          try {
            if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
            if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.type === 'reset') return false;
            const st = el.ownerDocument.defaultView.getComputedStyle(el);
            if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
            return true;
          } catch (_) { return true; }
        };
        const labelOf = (el) => {
          const out = [];
          try {
            if (el.id) { const l = el.ownerDocument.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) out.push(String(l.innerText || l.textContent || '')); }
            const wrap = el.closest('label');
            if (wrap) out.push(String(wrap.innerText || wrap.textContent || ''));
            const aria = el.getAttribute('aria-label');
            if (aria) out.push(aria);
            const lb = el.getAttribute('aria-labelledby');
            if (lb) { const n = el.ownerDocument.getElementById(lb); if (n) out.push(String(n.innerText || n.textContent || '')); }
            if (el.placeholder) out.push(el.placeholder);
            if (el.name) out.push(el.name);
            let prev = el.previousElementSibling;
            for (let i = 0; i < 2 && prev; i++, prev = prev.previousElementSibling) {
              const t = String(prev.innerText || prev.textContent || '').trim();
              if (t && t.length < 80) out.push(t);
            }
          } catch (_) {}
          const clean = out.map((s) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean);
          return clean[0] || '';
        };
        const optionsOf = (el) => {
          const out = [];
          try {
            if (el.tagName === 'SELECT') {
              for (const o of el.options) { const t = String(o.textContent || o.value || '').replace(/\s+/g, ' ').trim(); if (t && t.length < 60) out.push(t); if (out.length >= 40) break; }
            } else if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') {
              for (const li of el.querySelectorAll('[role="option"], li')) { const t = String(li.innerText || '').replace(/\s+/g, ' ').trim(); if (t && t.length < 60) out.push(t); if (out.length >= 40) break; }
            }
          } catch (_) {}
          return out;
        };
        const describe = (el, inShadow) => {
          const t = (el.getAttribute('type') || '').toLowerCase();
          let kind = 'text';
          if (el.tagName === 'SELECT') kind = 'select';
          else if (el.tagName === 'TEXTAREA') kind = 'textarea';
          else if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') kind = 'rich';
          else if (t === 'file') kind = 'file';
          else if (t === 'checkbox') kind = 'checkbox';
          else if (t === 'radio') kind = 'radio';
          else if (t === 'date') kind = 'date';
          else if (t === 'tel') kind = 'tel';
          else if (t === 'email') kind = 'email';
          else if (t === 'password') kind = 'password';
          else if (t === 'number') kind = 'number';
          else if (t === 'search') kind = 'search';
          else if (el.getAttribute('role') === 'combobox') kind = 'combobox';
          else if (el.getAttribute('role') === 'listbox') kind = 'listbox';
          const required = el.hasAttribute('required') || el.getAttribute('aria-required') === 'true' || el.getAttribute('aria-required') === 'true' || (el.tagName === 'INPUT' && (t === 'radio' || t === 'checkbox') && false);
          const key = (el.tagName + '|' + (el.id || '') + '|' + (el.name || '') + '|' + labelOf(el));
          if (seen.has(key)) return null;
          seen.add(key);
          return {
            id: el.id || '', name: el.name || '',
            field: (el.id || el.name || labelOf(el) || (el.placeholder || '')).replace(/\s+/g, ' ').trim().slice(0, 80),
            label: labelOf(el).slice(0, 120), type: kind, inputType: t,
            required: !!required,
            visible: isVisible(el),
            value: kind === 'password' ? '' : String(el.value || el.innerText || '').slice(0, 40),
            placeholder: (el.getAttribute('placeholder') || '').slice(0, 60),
            aria: (el.getAttribute('aria-label') || '').slice(0, 80),
            cls: (el.className || '').toString().slice(0, 60),
            options: optionsOf(el),
            empty: !el.value || el.value === '0' || !el.value,
            shadowDom: !!inShadow,
          };
        };
        const out = [];
        const walk = (root, inShadow) => {
          if (!root || !root.querySelectorAll) return;
          const sel = 'input, select, textarea, [role="combobox"], [role="listbox"], [contenteditable=""], [contenteditable="true"]';
          let els = [];
          try { els = root.querySelectorAll(sel); } catch (_) { return; }
          for (const el of els) { if (out.length < 120) { const d = describe(el, inShadow); if (d) out.push(d); } }
          let all = [];
          try { all = root.querySelectorAll('*'); } catch (_) { return; }
          for (const el of all) { if (el.shadowRoot) walk(el.shadowRoot, true); }
        };
        walk(document, false);
        return out;
      });
    } catch (_) { data = []; }
    if (data && data.length) {
      let furl = '';
      try { furl = fr.url().slice(0, 120); } catch (_) {}
      for (const d of data) all.push({ frame: furl, ...d });
    }
  }
  return all;
}

// Stale-error reconciliation: drop the email-mismatch complaint when every
// email field currently holds the profile address (async validators lag).
async function reconcileErrs(page, profile, errs, tag) {
  if (!errs || !errs.length) return errs || [];
  const before = errs.slice();
  try {
    const inputs = page.locator('input[type="email"], input[type="text"], input[type="search"], input:not([type])');
    const n = await inputs.count().catch(() => 0);
    const emails = [];
    for (let i = 0; i < Math.min(n, 40); i++) {
      const el = inputs.nth(i);
      const meta = await metaFor(el, page).catch(() => '');
      if (!/e-?mail|courriel/.test(meta)) continue;
      try { emails.push(String(await el.inputValue().catch(() => '')).trim()); } catch (_) {}
    }
    if (emails.length >= 2 && emails.every((v) => v && v === profile.email)) {
      errs = errs.filter((e) => !/adresse e-?mail.*incorrecte|mismatch|do not match/i.test(e));
    }
    // Hidden stale drafts (old values in non-visible inputs) never count.
    if (errs.length) {
      const visEmails = [];
      try {
        const inputs = page.locator('input[type="email"], input[type="text"], input[type="search"], input:not([type])');
        const n = await inputs.count().catch(() => 0);
        for (let i = 0; i < Math.min(n, 40); i++) {
          const el = inputs.nth(i);
          let vis = false;
          try { vis = await el.isVisible(); } catch (_) {}
          if (!vis) continue;
          const meta = await metaFor(el, page).catch(() => '');
          if (!/e-?mail|courriel/.test(meta)) continue;
          try { visEmails.push(String(await el.inputValue().catch(() => '')).trim()); } catch (_) {}
        }
      } catch (_) {}
      if (visEmails.length >= 2 && visEmails.every((v) => v && v === visEmails[0])) {
        errs = errs.filter((e) => !/adresse e-?mail.*incorrecte|mismatch|do not match|invalid|invalide/i.test(e));
      }
      // Email phantoms: drop mismatch text that sits outside the viewport
      // while every visible email field agrees (stale async validation).
      try {
        const vp = page.viewportSize();
        const vh = (vp && vp.height) || 900;
        const els = page.locator('.error, .field-error, .form-error, [role="alert"], .invalid-feedback, p.error');
        const n = await els.count().catch(() => 0);
        let inViewMismatch = false;
        for (let i = 0; i < Math.min(n, 15); i++) {
          let t = '';
          try { t = String(await els.nth(i).innerText()).trim().replace(/\s+/g, ' ').slice(0, 120); } catch (_) { continue; }
          if (!/adresse e-?mail.*incorrecte|mismatch|do not match/i.test(t)) continue;
          try {
            const box = await els.nth(i).boundingBox().catch(() => null);
            if (box && box.y >= 0 && box.y <= vh) inViewMismatch = true;
          } catch (_) {}
        }
        if (!inViewMismatch) {
          errs = errs.filter((e) => !/adresse e-?mail.*incorrecte|mismatch|do not match/i.test(e));
        }
      } catch (_) {}
      if (errs.some((e) => /lieu de r.sidence|location.*required/i.test(e))) {
        try {
          const inputs2 = page.locator('input[type="text"], input[type="search"], input:not([type])');
          const m = Math.min(await inputs2.count().catch(() => 0), 40);
          for (let i = 0; i < m; i++) {
            const el = inputs2.nth(i);
            const meta = await metaFor(el, page).catch(() => '');
            if (!/ville|city|lieu/.test(meta)) continue;
            let v = '';
            try { v = String(await el.inputValue().catch(() => '')).trim(); } catch (_) {}
            if (!v) continue;
            const openList = page.locator('li, [role="option"]');
            let openCt = 0;
            try {
              const om = Math.min(await openList.count().catch(() => 0), 30);
              for (let k = 0; k < om; k++) {
                try { if (await openList.nth(k).isVisible()) { openCt++; break; } } catch (_) {}
              }
            } catch (_) {}
            if (!openCt) {
              errs = errs.filter((e) => !/lieu de r.sidence|location.*required/i.test(e));
              break;
            }
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  return errs;
}

// Kind-aware file attach: cv goes to a resume/CV-scored input, cover letter
// only to a cover-letter input. NEVER attaches to an unrelated slot (photo,
// signature, "other document"): a misattached CV silently produces a broken
// application, which is worse than not attaching at all.
// Returns {ok, reason, into} so the caller can ASK instead of skipping quietly.
async function attachFile(page, filePath, kind) {
  const fail = (reason) => ({ ok: false, reason, into: '' });
  if (!filePath) return fail('no_path');
  try { if (!fs.existsSync(filePath)) return fail('file_missing'); }
  catch (_) { return fail('file_unreadable'); }
  let base = '';
  try { base = path.basename(filePath); } catch (_) {}
  const inputs = page.locator('input[type="file"]');
  const n = await inputs.count().catch(() => 0);
  if (!n) return fail('no_file_input');
  const scored = [];
  for (let i = 0; i < n; i++) {
    const meta = await metaFor(inputs.nth(i), page).catch(() => '');
    let acc = '';
    try { acc = String(await inputs.nth(i).getAttribute('accept').catch(() => '') || ''); }
    catch (_) {}
    scored.push({ i, meta, acc });
  }
  const NEVER_SLOT = /photo|picture|avatar|signature|logo|identity|carte|selfie/;
  const score = (m) => {
    const s = String(m || '').toLowerCase();
    if (NEVER_SLOT.test(s)) return 9; // never a document slot
    if (kind === 'cv') return /resum|curriculum|\bcv\b|candidature/.test(s) ? 0 : 1;
    return /cover|lettre|letter|motivation/.test(s) ? 0 : 1;
  };
  const order = scored.map((x) => ({ ...x, s: score(x.meta) })).sort((a, b) => a.s - b.s);
  const best = order[0] || { s: 9, meta: '' };
  if (best.s >= 9) return fail('only_non_document_input');
  if (kind === 'cover' && !/cover|lettre|letter|motivation/.test(String(best.meta).toLowerCase())) return fail('no_cover_input');
  // CV: only accept an input that actually advertises a resume/CV slot.
  // (The old code fell back to order[0] == "any file input", which is how a CV
  // ended up in a photo box on some boards.)
  const candidates = (kind === 'cv' ? order.filter((x) => x.s === 0) : order.filter((x) => x.s === 0));
  if (!candidates.length) return fail(kind === 'cv' ? 'no_cv_input' : 'no_cover_input');
  const withAcc = candidates.find((x) => x.acc);
  if (withAcc) candidates.unshift(withAcc);
  for (const c of candidates.slice(0, 3)) {
    const el = inputs.nth(c.i);
    try {
      await el.setInputFiles(filePath, { timeout: 10000, force: true });
      // Verify the browser really took the file, then wait for the UI to render
      // the filename (async upload widgets fail silently otherwise).
      let got = '';
      try { got = await el.evaluate((node) => (node.files && node.files[0] ? node.files[0].name : '')); }
      catch (_) {}
      let still = 0;
      try { still = await el.evaluate((node) => (node.files && node.files.length) || 0); } catch (_) {}
      if (!got && !still) continue; // widget cleared itself => treat as failure, try next
      let shown = false;
      if (base) {
        try {
          await page.waitForFunction(
            (bn) => {
              const t = document.body ? document.body.innerText : '';
              return t.includes(bn) || !!document.querySelector('.upload-success, [class*="success"], [data-uploaded]');
            },
            base, { timeout: 8000 },
          ).catch(() => {});
          shown = true;
        } catch (_) {}
      }
      return { ok: true, reason: base && shown ? 'attached' : 'attached_unverified_ui', into: String(c.meta || 'file_input').slice(0, 60) };
    } catch (_) {}
  }
  return fail('set_input_files_failed');
}

async function clickText(page, patterns, timeoutMs) {
  // Workday renders many "buttons" as divs (role=button, data-automation-id).
  const SEL = 'button, a, input[type="submit"], [role="button"], div[data-automation-id], li[data-automation-id]';
  for (const rx of patterns) {
    try {
      const b = page.locator(SEL).filter({ hasText: rx }).first();
      if (await b.count()) { await b.click({ timeout: timeoutMs || 8000 }); return rx.toString().slice(0, 40); }
    } catch (_) {}
  }
  // Fallback: plain divs/spans with click handlers (Jobijoba "Postuler").
  // Pick the smallest visible element holding the text, never a container.
  for (const rx of patterns) {
    try {
      const loc = page.getByText(rx);
      const n = await loc.count().catch(() => 0);
      if (!n) continue;
      const cands = [];
      for (let i = 0; i < Math.min(n, 15); i++) {
        const el = loc.nth(i);
        let vis = false;
        try { vis = await el.isVisible(); } catch (_) {}
        if (!vis) continue;
        let t = '';
        try { t = String(await el.innerText()).trim(); } catch (_) {}
        if (!t || t.length > 120) continue;
        cands.push({ el, len: t.length });
      }
      cands.sort((a, b) => a.len - b.len);
      for (const c of cands) {
        try { await c.el.click({ timeout: timeoutMs || 8000 }); return rx.toString().slice(0, 40) + '*'; }
        catch (_) {}
      }
      // Last resort: force-click through transient overlays (verified small button only).
      for (const c of cands) {
        try { await c.el.click({ timeout: 3000, force: true }); return rx.toString().slice(0, 40) + '!'; }
        catch (_) {}
      }
    } catch (_) {}
  }
  return '';
}

// Account-creation modals (Jobijoba "Créez un compte" & co): prefer direct
// access without account, else bare Google SSO, else the login link, else
// close. NEVER creates an account silently. Returns what happened.
async function dismissAccountWall(page, runD, ssoEmail) {
  const shot = (n) => page.screenshot({ path: path.join(runD, n + '.png'), fullPage: false }).catch(() => {});
  let body = '';
  try { body = await page.locator('body').innerText({ timeout: 8000 }).catch(() => ''); } catch (_) {}
  if (!/créez un compte|create (an |your )?account|connectez-vous|déjà un compte|already have an account|sign in to (apply|continue)/i.test(body)) return '';
  const direct = await clickText(page, [/non merci/i, /continuer sans compte/i, /sans créer de compte/i, /passer cette étape/i, /continue without/i, /maybe later/i], 6000);
  if (direct) {
    await page.waitForTimeout(3000);
    await shot('after-wall-dismiss');
    if (!(await modalOpen(page))) return 'direct';
    // Still open: try the X close as backup.
    const xshut = await closeModal(page);
    await page.waitForTimeout(2000);
    if (xshut && !(await modalOpen(page))) return 'closed';
    return 'stuck';
  }
  if (ssoEmail) {
    const g = await clickText(page, [/^\s*google\s*$/i], 6000);
    if (g) { await page.waitForTimeout(5000); await shot('after-modal-google'); return 'google'; }
  }
  const li = await clickText(page, [/connectez-vous/i, /\bse connecter\b/i, /already have an account/i, /^log in$/i, /^sign in$/i], 6000);
  if (li) { await page.waitForTimeout(3000); await shot('after-wall-login'); return 'login'; }
  if (await closeModal(page)) { await page.waitForTimeout(2000); return (await modalOpen(page)) ? 'stuck' : 'closed'; }
  return (await modalOpen(page)) ? 'stuck' : 'closed';
}

async function modalOpen(page) {
  try {
    const t = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    return /créez un compte|create (an |your )?account/i.test(t);
  } catch (_) { return false; }
}

async function closeModal(page) {
  try {
    const x = page.locator('[aria-label*="close" i], [aria-label*="fermer" i], .modal-close, button.close').first();
    if (await x.count()) { await x.click({ timeout: 4000 }).catch(() => {}); return true; }
  } catch (_) {}
  try {
    await page.keyboard.press('Escape').catch(() => {});
    return true;
  } catch (_) {}
  return false;
}

// Workday-style "Start Your Application" dialog: Autofill with Resume (cv upload)
// then Continue, else Apply Manually. Returns { method, ok, error }.
async function startApplication(page, runD, cvPath) {
  labelCacheClear(); // new page: labels may differ
  const shot = (n) => page.screenshot({ path: path.join(runD, n + '.png'), fullPage: false }).catch(() => {});
  await shot('jobpage');
  // Pages hydrate async — wait for the Apply control (any element), else reload once.
  const applyVisible = async () => {
    try {
      await page.getByText(/apply|postuler|candidater|je suis int.+ress/i).first().waitFor({ state: 'visible', timeout: 20000 });
      return true;
    } catch (_) { return false; }
  };
  if (!(await applyVisible())) {
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForTimeout(4000); } catch (_) {}
    if (!(await applyVisible())) return { method: 'none', ok: false, error: 'page_empty_retry' };
  }
  const catchPopupClick = async () => {
    let npPromise = page.context().waitForEvent('page', { timeout: 6000 }).catch(() => null);
    let clk = await clickText(page, [/^postuler$/i, /^apply$/i, /je postule/i, /^apply now$/i, /candidater/i, /je suis int.+ress.+e\)?/i]);
    let np = await npPromise;
    if (np) {
      try { await np.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch (_) {}
      const newUrl = np.url();
      try { await np.close(); } catch (_) {}
      if (newUrl && newUrl !== 'about:blank') {
        try { await page.goto(newUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (_) {}
      }
    }
    return clk;
  };
  let clicked = await catchPopupClick();
  if (!clicked) {
    // Hydration race: re-dismiss consent, reload once, re-scan.
    try { await dismissConsent(page); } catch (_) {}
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForTimeout(5000); } catch (_) {}
    try { await dismissConsent(page); } catch (_) {}
    clicked = await catchPopupClick();
  }
  if (!clicked) return { method: 'none', ok: false, error: 'no_apply_button' };
  await page.waitForTimeout(3500);
  await shot('after-apply-click');
  // Account-creation modals first (direct access > bare Google SSO > login link).
  try {
    const dw = await dismissAccountWall(page, runD, (getAnswers().ssoEmail || ''));
    if (dw) { await page.waitForTimeout(2000); await shot('after-wall-dismiss'); }
  } catch (_) {}
  // Choice dialog? Use ARIA role queries (Workday markup varies: button/div/portal).
  const diag = { url: '', autoCount: 0, manCount: 0 };
  try { diag.url = page.url().slice(0, 120); } catch (_) {}
  const btnByName = async (rx) => {
    const cands = [
      page.getByRole('button', { name: rx }).first(),
      page.getByRole('link', { name: rx }).first(),
      page.locator('button, a, [role="button"], div[data-automation-id], li[data-automation-id]').filter({ hasText: rx }).first(),
      page.getByText(rx, { exact: false }).first(),
    ];
    for (const c of cands) {
      try { if (await c.count() > 0) return c; } catch (_) {}
    }
    return null;
  };
  try {
    const auto = await btnByName(/autofill with resume/i);
    try { diag.autoCount = auto ? 1 : 0; } catch (_) {}
    if (auto) {
      await auto.click({ timeout: 8000 });
      await page.waitForTimeout(2500);
      const fi = page.locator('input[type="file"]').first();
      let uploaded = false;
      try {
        await fi.waitFor({ state: 'attached', timeout: 12000 });
        if (cvPath) { await fi.setInputFiles(cvPath, { timeout: 15000 }); uploaded = true; }
      } catch (_) {}
      await page.waitForTimeout(6000);
      await shot('after-autofill');
      const cont = await clickText(page, [/^continue$/i, /^next$/i, /suivant/i, /continuer/i]);
      await page.waitForTimeout(4000);
      await shot('after-continue');
      return { method: 'autofill', ok: true, uploaded, continued: !!cont, diag };
    }
  } catch (_) {}
  try {
    const man = await btnByName(/apply manually/i);
    try { diag.manCount = man ? 1 : 0; } catch (_) {}
    if (man) {
      await man.click({ timeout: 8000 });
      await page.waitForTimeout(3500);
      await shot('after-manual');
      return { method: 'manual-start', ok: true, diag };
    }
  } catch (_) {}
  await shot('after-choice');
  return { method: 'direct-or-login', ok: true, diag };
}

async function isSignInWall(page) {
  // Visible text (not raw HTML: tags can split phrases like "Sign in with Apple").
  let body = '';
  try { body = await allVisibleText(page, 12000); } catch (_) { body = ''; }
  try {
    const url = page.url();
    if (/\/(login|signin|sign-in|candidate\/login|logon)/i.test(url)) return true;
    if (await page.locator('input[type="password"]').count() > 0) return true;
    const emailCt = await page.locator('input[type="email"], input[name*="email" i]').count().catch(() => 0);
    if (emailCt > 0) {
      if (/sign in( to (apply|continue))?|log in( to (apply|continue))?|connectez-vous pour postuler/i.test(body)) return true;
    }
    // Sign-in gateway: no password field yet, but account-choice buttons
    // (Workday "Sign In" step: Apple / Google / LinkedIn / email).
    if (/sign in with (email|google|linkedin|apple)/i.test(body)) return true;
  } catch (_) {}
  return false;
}

function credsPath(board) { return path.join(DIR, 'creds', String(board || 'generic').toLowerCase() + '.creds.json'); }

async function credsLogin(board, page) {
  const f = credsPath(board);
  if (!fs.existsSync(f)) return { ok: false, error: 'no_creds' };
  let creds;
  try { creds = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return { ok: false, error: 'creds_unreadable' }; }
  if (!creds.email || !creds.password) return { ok: false, error: 'creds_incomplete' };
  try {
    const emailInput = await findEmailInput(page);
    if (!emailInput) return { ok: false, error: 'no_email_field' };
    await emailInput.fill(creds.email, { timeout: 15000 });
    const pwInput = await findPasswordInput(page);
    if (!pwInput) return { ok: false, error: 'no_password_field' };
    await pwInput.fill(creds.password, { timeout: 10000 });
    const btn = await clickText(page, [/sign in/i, /log in/i, /se connecter/i, /^submit$/i, /connexion/i], 10000);
    if (!btn) return { ok: false, error: 'no_signin_button' };
    await page.waitForTimeout(6000);
    return (await isSignInWall(page)) ? { ok: false, error: 'login_rejected' } : { ok: true, method: 'creds' };
  } catch (e) { return { ok: false, error: 'login_failed: ' + String((e && e.message) || e).split('\n')[0].slice(0, 100) }; }
}

// Sign-in watch: headed browser is open, user logs in by hand. Polls for the
// wall to disappear. Never touches credentials.
async function watchLogin(page, timeoutMs) {
  const t0 = Date.now();
  const max = timeoutMs || 300000;
  while (Date.now() - t0 < max) {
    try { if (!(await isSignInWall(page))) return { ok: true, method: 'watch' }; } catch (_) {}
    await page.waitForTimeout(5000).catch(() => {});
  }
  return { ok: false, error: 'watch_timeout' };
}

async function openBoardPage(board, url, headed, opts) {
  // Prefer the user's own Chrome (its Google session signs SSO by itself).
  // Attach via CDP; NEVER close the user's browser or context (page only).
  // Falls back to the isolated board profile when the debug port is closed.
  if (!(opts && opts.forceProfile)) {
    try {
      const browser = await chromium.connectOverCDP('http://localhost:9222', { timeout: 8000 });
      const ctxs = browser.contexts();
      const uctx = ctxs[0];
      if (uctx) {
        const page = await uctx.newPage();
        try { await page.setDefaultTimeout(5000); } catch (_) {}
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3500);
        await dismissConsent(page);
        const done = async () => { try { await page.close(); } catch (_) {} };
        return { ctx: null, page, cdp: true, done };
      }
      try { await browser.close(); } catch (_) {}
    } catch (_) { /* CDP unavailable -> isolated profile */ }
  }
  const profileDir = path.join(DIR, board + '-profile');
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch (_) {}
  try {
    const ctx = await chromium.launchPersistentContext(profileDir, {
      headless: headed ? false : process.env.HEADLESS !== '0',
      userAgent: UA,
      viewport: { width: 1366, height: 900 },
      locale: 'fr-FR',
      acceptDownloads: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
    });
    await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    const page = ctx.pages()[0] || (await ctx.newPage());
    try { await page.setDefaultTimeout(5000); } catch (_) {}
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3500);
    await dismissConsent(page);
    const done = async () => { try { await ctx.close(); } catch (_) {} };
    return { ctx, page, cdp: false, done };
  } catch (e) { return { error: 'open_failed: ' + String((e && e.message) || e).split('\n')[0].slice(0, 120) }; }
}

// URL jail: the bot (especially attached to the user's Chrome) may only visit
// the offer host and Google SSO. Anything else aborts the run.
function hostAllowed(urlStr, offer) {
  try {
    const h = new URL(urlStr).hostname.toLowerCase();
    if (h === 'accounts.google.com' || h.endsWith('.accounts.google.com')) return true;
    // Allow BOTH the listing host and the resolved employer ATS host (WP5).
    // Checking only offer.link jailed every outbound offer the moment it moved
    // from the aggregator to the real ATS page.
    for (const u of [offer && offer.link, offer && offer.applyUrl]) {
      if (!u) continue;
      const oh = new URL(u).hostname.toLowerCase();
      if (h === oh || h.endsWith('.' + oh)) return true;
    }
  } catch (_) {}
  return false;
}

const CONTINUE_RX = [/save and continue/i, /^continue$/i, /^next$/i, /suivant/i, /continuer/i, /save & continue/i];
// SUBMIT_RX: SmartRecruiters uses 'Envoyer' or 'Envoyer ma candidature';
// Workday uses 'Submit Application'; French boards use 'Valider' / 'Soumettre'.
const SUBMIT_RX = [
  /^submit application$/i, /^submit$/i,
  /^soumettre (ma )?candidature/i, /^envoyer (ma )?candidature/i,
  /^valider (ma )?candidature/i, /^envoyer$/i,
  /soumettre/i, /envoyer ma candidature/i, /valider ma candidature/i,
];

// Multi-step walk to the Review page. NEVER clicks submit. Returns evidence.
async function solveToReview(page, profile, answers, files, runD, maxSteps, offer) {
  const reqOnly = answers.mandatoryOnly !== false;
  const steps = [];
  let filledAll = [];
  let cvAttached = false, lettreAttached = false;
  let unanswered = [];
  const attachNotes = [];
  let lastScan = [];
  // Merge a field inventory entry into an unanswered question so the ask-back
  // carries the REAL label, type and option list (scanFields) instead of a
  // bare field name.
  const enrich = (list, scan) => {
    if (!list || !list.length || !scan || !scan.length) return list || [];
    return list.map((q) => {
      const f = String(q.field || '').toLowerCase();
      const hit = scan.find((s) => {
        const hay = (s.field + ' ' + s.label + ' ' + s.name + ' ' + s.id + ' ' + s.aria).toLowerCase();
        return f && hay && (hay.includes(f) || f.includes(s.field.toLowerCase()));
      });
      if (!hit) return q;
      return { ...q, type: q.type || hit.type, label: hit.label || q.label, required: q.required !== undefined ? q.required : hit.required, options: (q.options && q.options.length) ? q.options : (hit.options || []), dom: hit };
    });
  };
  const max = maxSteps || 10;
  for (let s = 0; s < max; s++) {
    if (offer && !hostAllowed(page.url(), offer)) return { atReview: false, steps, filled: filledAll, unanswered, cvAttached, lettreAttached, attachNotes, formErrs: [], error: 'jail_violation' };
    const fp = await fillPhoneIntl(page, profile, reqOnly).catch(() => []);
    const ftr = await fillText(page, profile, reqOnly, answers).catch(() => ({ filled: [], unanswered: [] }));
    const ft = ftr.filled || [];
    // profile + step are REQUIRED here: fillSelects used to reference a
    // `profile` that was not in scope, and the ReferenceError was swallowed by
    // .catch() — silently skipping EVERY <select> on EVERY board.
    const se = await fillSelects(page, answers, reqOnly, profile, s).catch((e) => ({ filled: [], unanswered: [], error: String((e && e.message) || e).slice(0, 120) }));
    const ch = await fillChecks(page, answers, reqOnly, s).catch((e) => ({ filled: [], unanswered: [], error: String((e && e.message) || e).slice(0, 120) }));
    const coh = await cohereEmails(page, profile.email || '').catch(() => []);
    const loc = await pickLocationSuggestions(page, profile.city || '').catch(() => []);
    const bef = await fillByErrors(page, profile, answers).catch(() => ({ filled: [], unanswered: [] }));
    await wickedSmartRecruitersHack(page, profile, answers);
    filledAll = filledAll.concat(fp, ft, se.filled, ch.filled, coh, loc, bef.filled);
    unanswered = (ftr.unanswered || []).concat(se.unanswered, ch.unanswered, bef.unanswered);
    if (files.cv && !cvAttached) {
      const r = await attachFile(page, files.cv, 'cv').catch(() => ({ ok: false, reason: 'attach_failed' }));
      cvAttached = !!r.ok;
      if (r.reason) attachNotes.push({ kind: 'cv', reason: r.reason, into: r.into || '' });
    }
    if (files.lettre && !lettreAttached) {
      const r = await attachFile(page, files.lettre, 'cover').catch(() => ({ ok: false, reason: 'attach_failed' }));
      lettreAttached = !!r.ok;
      if (r.reason && r.reason !== 'no_cover_input') attachNotes.push({ kind: 'cover', reason: r.reason, into: r.into || '' });
    }
    await page.screenshot({ path: path.join(runD, 'step-' + s + '.png'), fullPage: false }).catch(() => {});
    steps.push({ step: s, filled: fp.length + ft.length + se.filled.length + ch.filled.length, Shot: 'step-' + s + '.png' });
    await dumpInputs(page, runD, 'dom-latest').catch(() => {});
    // Read-only inventory: kept in the run dir and returned with the result so
    // the worker can ask the user about the exact fields it could not fill.
    lastScan = await scanFields(page).catch(() => []);
    if (lastScan && lastScan.length) {
      try { require('fs').writeFileSync(path.join(runD, 'field-scan.json'), JSON.stringify(lastScan, null, 1)); } catch (_) {}
    }
    if (unanswered.length) return { atReview: false, steps, filled: filledAll, unanswered: enrich(unanswered, lastScan), cvAttached, lettreAttached, attachNotes, fieldScan: lastScan, formErrs: await reconcileErrs(page, profile, await formErrors(page).catch(() => []), 'unans') };
    const cont = await clickText(page, CONTINUE_RX, 6000);
    if (!cont) break;
    await page.waitForTimeout(4000);
    // Post-continue pass: validators fire AFTER clicking Continue/Next and may
    // reveal new required fields (SmartRecruiters "Intitulé est requis", "Ville est requis").
    // Re-run fill + error-anchored fixer before the next step loop iteration.
    try {
      const bef2 = await fillByErrors(page, profile, answers).catch(() => ({ filled: [], unanswered: [] }));
      await wickedSmartRecruitersHack(page, profile, answers);
      const ftr2 = await fillText(page, profile, reqOnly, answers).catch(() => ({ filled: [], unanswered: [] }));
      // Validators fire AFTER Continue and commonly reveal required SELECTs
      // ("Pays est requis", "Civilité est requise") that had no error text on
      // arrival. Re-run the select pass here or the walk stalls on step 2.
      const se2 = await fillSelects(page, answers, reqOnly, profile, s).catch(() => ({ filled: [], unanswered: [] }));
      const loc2 = await pickLocationSuggestions(page, profile.city || '').catch(() => []);
      filledAll = filledAll.concat(bef2.filled, ftr2.filled || [], se2.filled || [], loc2);
      // Only block if there are still unanswered after this remediation pass.
      const stillUnans = (bef2.unanswered || []).concat(ftr2.unanswered || [], se2.unanswered || []);
      if (stillUnans.length) {
        unanswered = stillUnans;
        return { atReview: false, steps, filled: filledAll, unanswered: enrich(unanswered, lastScan), cvAttached, lettreAttached, attachNotes, fieldScan: lastScan, formErrs: await reconcileErrs(page, profile, await formErrors(page).catch(() => []), 'post-cont') };
      }
    } catch (_) {}
    await page.waitForTimeout(1500);
  }
  // Detect final submit button across all SUBMIT_RX patterns.
  let hasSubmit = false;
  for (const rx of SUBMIT_RX) {
    try { hasSubmit = (await page.locator('button, a, input[type="submit"], [role="button"]').filter({ hasText: rx }).count()) > 0; } catch (_) {}
    if (hasSubmit) break;
  }
  return { atReview: hasSubmit, steps, filled: filledAll, unanswered: enrich(unanswered, lastScan), cvAttached, lettreAttached, attachNotes, fieldScan: lastScan, formErrs: await reconcileErrs(page, profile, await formErrors(page).catch(() => []), 'final') };
}

// ================= WICKED HACK =================
async function wickedSmartRecruitersHack(page, profile, answers) {
  try {
    const targets = [
      { label: /Ville|City|Location|Lieu/i, val: profile.city },
      { label: /Intitul[eé]|Job title|Current title|Titre/i, val: (answers.learned && answers.learned.intitule) || '' }
    ];
    for (const { label, val } of targets) {
      if (!val) continue;
      // Look for the text label visually
      const lbls = page.getByText(label);
      const cn = await lbls.count().catch(()=>0);
      for (let i=0; i<cn; i++) {
        const l = lbls.nth(i);
        if (!(await l.isVisible().catch(()=>false))) continue;
        const txt = await l.innerText().catch(()=>'');
        if (!txt.match(label)) continue;
        
        let foundInput = false;
        
        // Strategy 1: SmartRecruiters specific aria/combobox targeting near the label
        const container = l.locator('xpath=..'); // Parent
        let inputs = container.locator('input[type="text"], input[role="combobox"], input:not([type])');
        
        // Strategy 2: If not found in parent, widen search to up to 4 ancestors
        if (await inputs.count().catch(()=>0) === 0) {
           for (let depth of [2, 3, 4, 5, 6]) {
               const up = l.locator('xpath=ancestor::*[' + depth + ']');
               inputs = up.locator('input[type="text"], input[role="combobox"], input:not([type])');
               if (await inputs.count().catch(()=>0) > 0) break;
           }
        }

        if (await inputs.count().catch(()=>0) > 0) {
            const input = inputs.first();
            if (await input.isVisible().catch(()=>false)) {
                await input.click({force: true}).catch(()=>{});
                await input.fill('');
                await page.waitForTimeout(500);
                // Type character by character to reliably trigger dropdown
                await input.pressSequentially(val, { delay: 100 }).catch(()=>{});
                await page.waitForTimeout(2000);
                
                // Aggressive dropdown selection
                await input.press('ArrowDown').catch(()=>{});
                await page.waitForTimeout(500);
                await input.press('Enter').catch(()=>{});
                
                try {
                   // Target ANY visible autocomplete suggestion item in the entire DOM
                   const sugs = page.locator('[role="option"], li[role="treeitem"], .autocomplete-suggestion, [data-test="dropdown-item"], .sr-location-autocomplete-suggestion, [data-test="autocomplete-item"], li[data-test="list-item"]');
                   const sn = await sugs.count().catch(()=>0);
                   for(let s=0; s<sn; s++) {
                      if (await sugs.nth(s).isVisible().catch(()=>false)) {
                         await sugs.nth(s).click({force:true});
                         foundInput = true;
                         break;
                      }
                   }
                } catch(_) {}
                
                if (!foundInput) {
                   // Fallback: Just blur if no suggestion clicked, sometimes enough
                   await input.evaluate(node => node.blur()).catch(()=>{});
                }
                foundInput = true;
            }
        }
        if (foundInput) break;
      }
    }
  } catch(e) {}
}

function extractAppId(bodyText) {
  const t = String(bodyText || '');
  const rxs = [
    /(?:application|reference|candidature)[\s]*(?:id|number|no\.?|num[eé]ro)?[\s]*[:#]?\s*([A-Z0-9][A-Z0-9\-]{4,30})/i,
    /confirmation[\s]*(?:number|no\.?)?[\s]*[:#]?\s*([A-Z0-9][A-Z0-9\-]{4,30})/i,
  ];
  for (const rx of rxs) {
    const m = t.match(rx);
    if (m && m[1] && !/^(the|and|pour|votre|your)$/i.test(m[1])) return m[1];
  }
  return '';
}

// Workday inputs often lack type=email/name (data-automation-id + label only).
async function findEmailInput(page) {
  const sels = [
    'input[type="email"]',
    'input[name*="email" i]',
    'input[data-automation-id*="email" i]',
    'input[aria-label*="email" i]',
    'input[data-automation-id*="userName" i]',
  ];
  for (const s of sels) {
    try {
      const el = page.locator(s).first();
      if (await el.count() > 0) return el;
    } catch (_) {}
  }
  // label-text association ("Email Address *")
  try {
    const lab = page.locator('label').filter({ hasText: /^e-?mail/i }).first();
    if (await lab.count() > 0) {
      const forId = await lab.getAttribute('for').catch(() => '');
      if (forId) {
        const el = page.locator('#' + forId).first();
        if (await el.count() > 0) return el;
      }
      const inner = lab.locator('input').first();
      if (await inner.count() > 0) return inner;
    }
  } catch (_) {}
  return null;
}

async function findPasswordInput(page) {
  try {
    const el = page.locator('input[type="password"]').first();
    if (await el.count() > 0) return el;
  } catch (_) {}
  return null;
}

// Email-code sign-in ("Sign in with email"): bot enters the email, the board
// mails a one-time code, the user dictates it in chat, the SAME run enters it.
// Cross-run codes are never trusted (each request invalidates the previous).
async function requestEmailCode(page, runD, email) {
  const shot = (n) => page.screenshot({ path: path.join(runD, n + '.png'), fullPage: false }).catch(() => {});
  // Exact-match the email option: partial matching would hit
  // "Sign in with Apple/Google/LinkedIn". Reject those explicitly.
  const EMAIL_RX = [/^\s*sign in with email\s*$/i, /^\s*continuer avec email\s*$/i, /^\s*se connecter (avec|par) e-?mail\s*$/i, /^\s*connexion par e-?mail\s*$/i];
  let emailBtn = null;
  for (const rx of EMAIL_RX) {
    const cands = [
      page.getByRole('button', { name: rx }).first(),
      page.getByText(rx).first(),
      page.locator('button, a, [role="button"], div[data-automation-id]').filter({ hasText: rx }).first(),
    ];
    for (const c of cands) {
      try {
        if (await c.count() > 0) {
          const txt = String(await c.innerText().catch(() => '')).toLowerCase();
          if (txt && !/apple|google|linkedin/.test(txt)) { emailBtn = c; break; }
        }
      } catch (_) {}
    }
    if (emailBtn) break;
  }
  if (!emailBtn) return { error: 'no_email_signin' };
  try { await emailBtn.click({ timeout: 10000 }); } catch (_) { return { error: 'no_email_signin' }; }
  await page.waitForTimeout(2500);
  await shot('after-email-click');
  // The email step can hydrate slowly: re-click if the button is still there,
  // then wait generously for any email-ish field.
  let emVisible = false;
  let emEl = null;
  for (let attempt = 0; attempt < 3 && !emVisible; attempt++) {
    try {
      emEl = await findEmailInput(page);
      if (emEl) {
        await emEl.waitFor({ state: 'visible', timeout: 12000 });
        emVisible = true;
      } else {
        throw new Error('absent');
      }
    } catch (_) {
      emEl = null;
      try {
        const b2 = page.locator('button, a, [role="button"], div[data-automation-id]').filter({ hasText: /sign in with email/i }).first();
        if (await b2.count()) await b2.click({ timeout: 5000 }).catch(() => {});
      } catch (_) {}
    }
  }
  if (!emVisible || !emEl) { await shot('no-email-field'); return { error: 'no_email_field' }; }
  try {
    await emEl.fill(String(email), { timeout: 8000 });
  } catch (_) { return { error: 'no_email_field' }; }
  await clickText(page, [/^continue$/i, /^next$/i, /^continuer$/i, /^sign in$/i, /send (the )?code/i, /envoyer (le )?code/i], 8000);
  await page.waitForTimeout(5000);
  await shot('after-email-code-request');
  if (!(await isSignInWall(page))) return { direct: true };
  let txt = '';
  try { txt = await page.locator('body').innerText({ timeout: 8000 }).catch(() => ''); } catch (_) {}
  const codeCt = await page.locator('input[inputmode="numeric"], input[name*="code" i], input[name*="otp" i], input[autocomplete="one-time-code"]').count().catch(() => 0);
  if (codeCt > 0 || /verification code|check your email|enter.*code|code.*(envoye|sent)|verifie/i.test(txt)) return { requested: true };
  return { error: 'email_code_unknown' };
}

async function submitLoginCode(page, code) {
  const clean = String(code || '').replace(/\D/g, '').slice(0, 8);
  if (clean.length < 4) return { ok: false, error: 'bad_code' };
  try {
    const single = page.locator('input[inputmode="numeric"], input[name*="code" i], input[name*="otp" i], input[autocomplete="one-time-code"]').first();
    if (await single.count()) {
      await single.fill(clean, { timeout: 8000 });
    } else {
      const boxes = page.locator('input[type="text"], input[type="search"], input:not([type])');
      const n = Math.min(await boxes.count().catch(() => 0), clean.length);
      if (!n) return { ok: false, error: 'no_code_field' };
      for (let i = 0; i < n; i++) { try { await boxes.nth(i).fill(clean[i], { timeout: 4000 }); } catch (_) {} }
    }
  } catch (_) { return { ok: false, error: 'code_fill_failed' }; }
  await page.waitForTimeout(2000);
  await clickText(page, [/verify/i, /verifier/i, /valider/i, /confirmer/i, /submit/i, /^continue$/i], 8000);
  await page.waitForTimeout(5000);
  return (await isSignInWall(page)) ? { ok: false, error: 'code_rejected' } : { ok: true, method: 'email-code' };
}

// Google SSO click-through: clicks ONLY "Sign in with Google" (exact match),
// then ONLY the configured account address. Stops at any password prompt.
async function googleSso(page, runD, ssoEmail) {
  const shot = (n) => page.screenshot({ path: path.join(runD, n + '.png'), fullPage: false }).catch(() => {});
  let btn = null;
  for (const rx of [/^\s*sign in with google\s*$/i, /^\s*continuer avec google\s*$/i, /^\s*se connecter avec google\s*$/i]) {
    const cands = [
      page.getByRole('button', { name: rx }).first(),
      page.getByText(rx).first(),
      page.locator('button, a, [role="button"], div[data-automation-id]').filter({ hasText: rx }).first(),
    ];
    for (const c of cands) {
      try {
        if (await c.count() > 0) {
          const txt = String(await c.innerText().catch(() => '')).toLowerCase();
          if (txt && !/apple|linkedin/.test(txt)) { btn = c; break; }
        }
      } catch (_) {}
    }
    if (btn) break;
  }
  if (!btn) return { error: 'no_google_signin' };
  try { await btn.click({ timeout: 10000 }); } catch (_) { return { error: 'no_google_signin' }; }
  await page.waitForTimeout(5000);
  await shot('after-google-click');
  if (!(await isSignInWall(page))) return { ok: true, method: 'google-sso' };
  // Account chooser (existing Google session, e.g. attached user Chrome):
  // click ONLY the configured address, never anything else.
  const want = String(ssoEmail || '').trim().toLowerCase();
  if (want) {
    try {
      const acc = page.getByText(want, { exact: false }).first();
      if (await acc.count() > 0) {
        await acc.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(5000);
        await shot('after-google-account');
        if (!(await isSignInWall(page))) return { ok: true, method: 'google-sso' };
      }
    } catch (_) {}
  }
  // No session: Google asks for the account identifier first. Typing the
  // (non-secret) email is safe and moves the flow to the password step,
  // where the bot ALWAYS stops and parks.
  if (want) {
    try {
      const idf = page.locator('input[type="email"], input[name="identifier"]').first();
      if (await idf.count() > 0) {
        await idf.fill(want, { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1500);
        await shot('after-google-identifier');
        const nxt = page.getByRole('button', { name: /suivant|next/i }).first();
        try { if (await nxt.count() > 0) await nxt.click({ timeout: 8000 }); } catch (_) {}
        await page.waitForTimeout(5000);
        await shot('after-google-next');
        if (!(await isSignInWall(page))) return { ok: true, method: 'google-sso' };
      }
    } catch (_) {}
  }
  try {
    if (await page.locator('input[type="password"]').count() > 0) return { ok: false, error: 'sso_password_prompt' };
  } catch (_) {}
  return { ok: false, error: 'sso_incomplete' };
}

// Standby catcher: hold the tab and poll for signed-in state (silent SSO
// landing, manual completion, fresh account). Evidence shots, honest timeout.
async function standbySignedIn(page, runD, timeoutMs) {
  const max = timeoutMs || 720000;
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < max) {
    try { if (!(await isSignInWall(page))) return { ok: true }; } catch (_) {}
    await page.waitForTimeout(10000).catch(() => {});
    if (Date.now() - t0 >= (n + 1) * 60000) {
      n++;
      await page.screenshot({ path: path.join(runD, 'standby-' + n + '.png'), fullPage: false }).catch(() => {});
    }
  }
  return { ok: false, error: 'standby_timeout' };
}

// Auth-aware opener: job page -> start dialog -> wall? -> creds, then optional
// headed sign-in watch. Returns { ctx, page, dialogMethod, loginMethod } or
// { authWall: true, error } (ctx already closed) or { error }.
async function resolveAuth(board, url, runD, opts) {
  const cvPath = opts && opts.cvPath;
  const watchMs = (opts && opts.watchMs) || 0;
  let op = await openBoardPage(board, url, !!(opts && opts.headed));
  if (op.error) return { error: op.error };
  let ctx = op.ctx, page = op.page;
  let done = op.done || (async () => { try { await ctx.close(); } catch (_) {} });
  const st = await startApplication(page, runD, cvPath);
  if (!st.ok) { await done(); return { error: st.error || 'dialog_failed' }; }
  if (!(await isSignInWall(page))) return { ctx, page, done, dialogMethod: st.method, diag: st.diag || {}, loginMethod: 'session' };
  if (opts && opts.skipAuth) { await done(); return { ctx, page, done, dialogMethod: st.method, diag: st.diag || {}, loginMethod: 'auto_apply_skip' }; }
  const li = await credsLogin(board, page);
  if (li.ok) return { ctx, page, done, dialogMethod: st.method, diag: st.diag || {}, loginMethod: li.method };
  // Email-code relay: request a one-time code, then wait (same run, same
  // browser context) for the user-dictated code. Cross-run codes are ignored
  // (each request invalidates the previous one) via the loginCodeAt guard.
  const email = opts && opts.email;
  let emailErr = '';
  if (email && email.includes('@')) {
    const rq = await requestEmailCode(page, runD, email);
    if (rq.direct) return { ctx, page, done, dialogMethod: st.method, diag: st.diag || {}, loginMethod: 'email-code' };
    if (rq.requested) {
      const waitMs = (opts && opts.awaitCodeMs) || 0;
      const taskId = opts && opts.taskId;
      const tReq = Date.now();
      if (waitMs > 0 && taskId) {
        while (Date.now() - tReq < waitMs) {
          await page.waitForTimeout(10000).catch(() => {});
          let code = '', codeAt = 0;
          try {
            const t = await api.getTask(taskId);
            code = String(t.loginCode || '');
            codeAt = Date.parse(t.loginCodeAt || '') || 0;
          } catch (_) {}
          if (code.replace(/\D/g, '').length >= 4 && codeAt > tReq) {
            try { await api.updateTask(taskId, { loginCode: null, loginCodeAt: null }); } catch (_) {}
            const sc = await submitLoginCode(page, code);
            if (sc.ok) return { ctx, page, done, dialogMethod: st.method, diag: st.diag || {}, loginMethod: sc.method };
            await done();
            return { authWall: true, error: sc.error || 'code_failed' };
          }
          try { if (!(await isSignInWall(page))) return { ctx, page, done, dialogMethod: st.method, diag: st.diag || {}, loginMethod: 'email-code' }; } catch (_) {}
        }
        try { await api.updateTask(taskId, { loginCode: null, loginCodeAt: null }); } catch (_) {}
        await done();
        return { authWall: true, error: 'email_code_timeout' };
      }
      await done();
      return { authWall: true, error: 'email_code_sent' };
    }
    emailErr = rq.error || 'email_failed';
  }
  // Google SSO with the user's own session (CDP attached Chrome signs itself
  // in; isolated profiles park here unless logged in before).
  const ssoEmail = (getAnswers().ssoEmail || '').trim();
  if (ssoEmail && (await isSignInWall(page).catch(() => true))) {
    const g = await googleSso(page, runD, ssoEmail);
    if (g.ok) return { ctx, page, done, dialogMethod: st.method, diag: st.diag || {}, loginMethod: g.method };
    if (g.error === 'sso_password_prompt') { await done(); return { authWall: true, error: 'sso_password_prompt' }; }
  }
  // Standby: the session may land on its own (SSO auto-redirect, manual
  // completion in the user's browser, fresh account). Wait with evidence.
  const standbyMs = (opts && opts.standbyMs) || 0;
  if (standbyMs > 0 && !(opts && opts.skipAuth)) {
    const sb = await standbySignedIn(page, runD, standbyMs);
    if (sb.ok) return { ctx, page, done, dialogMethod: st.method, diag: st.diag || {}, loginMethod: 'standby' };
    await done();
    return { authWall: true, error: 'standby_timeout' };
  }
  if (!watchMs) { await done(); return { authWall: true, error: (emailErr ? 'email:' + emailErr + '|' : '') + (li.error || 'signin_required') }; }
  await done();
  const hop = await openBoardPage(board, url, true);
  if (hop.error) return { authWall: true, error: hop.error };
  const w = await watchLogin(hop.page, watchMs);
  try { await hop.ctx.close(); } catch (_) {}
  if (!w.ok) return { authWall: true, error: 'watch_timeout' };
  // session persisted -> continue headless from a clean state
  op = await openBoardPage(board, url, false);
  if (op.error) return { authWall: true, error: op.error };
  ctx = op.ctx; page = op.page;
  done = op.done || (async () => { try { await ctx.close(); } catch (_) {} });
  const st2 = await startApplication(page, runD, cvPath);
  if (!st2.ok) { await done(); return { error: st2.error || 'dialog_failed' }; }
  if (await isSignInWall(page)) { await done(); return { authWall: true, error: 'still_signed_out' }; }
  return { ctx, page, done, dialogMethod: st2.method, diag: st2.diag || {}, loginMethod: 'watch' };
}

// ---- preview: dialog -> auth-detect -> dry walk to Review. NEVER submits. ----
async function preview(taskId, offer, profile, files, opts) {
  const board = detectBoard(offer);
  // Navigate to the resolved employer ATS page when we have one (WP5): the
  // aggregator listing is a dead end for form filling, whereas the ATS page
  // is where the documented bypass strategies actually apply.
  const targetUrl = (offer && offer.applyUrl) || (offer && offer.link) || '';
  const d = runDir(taskId);
  const out = { board, url: offer.link || '', title: '', hasApply: false, filled: [], cvAttached: false, lettreAttached: false, attachNotes: [], steps: [], unanswered: [], formErrs: [], authWall: false, loginMethod: '', dialogMethod: '', atReview: false, screenshot: '', auto: AUTO_BOARDS.has(board), fieldScan: [] };
  if (!targetUrl) { out.error = 'no_link'; return out; }
  if (!out.auto) return out; // manual/outbound/linkedin: no browser needed
  let done = async () => {};
  try {
    const ra = await resolveAuth(board, targetUrl, d, { cvPath: files && files.cv, headed: !!(opts && opts.headed), watchMs: (opts && opts.watchMs) || 0, email: opts && opts.email, taskId, awaitCodeMs: (opts && opts.awaitCodeMs) || 0, standbyMs: (opts && opts.standbyMs) || 0 });
    if (ra.authWall || !ra.page) { out.authWall = !!ra.authWall; out.error = ra.error || 'auth_wall'; return out; }
    done = ra.done || done;
    const page = ra.page;
    out.loginMethod = ra.loginMethod || '';
    out.dialogMethod = ra.dialogMethod || '';
    out.diag = ra.diag || {};
    out.title = String(await page.title().catch(() => '')).slice(0, 120);
    const answers = getAnswers();
    const sol = await solveToReview(page, profile, answers, files || {}, d, 8, offer);
    out.filled = sol.filled; out.steps = sol.steps; out.unanswered = sol.unanswered;
    out.formErrs = sol.formErrs || [];
    out.cvAttached = sol.cvAttached; out.lettreAttached = sol.lettreAttached;
    out.attachNotes = sol.attachNotes || [];
    out.fieldScan = sol.fieldScan || [];
    out.atReview = sol.atReview;
    out.hasApply = sol.atReview || (await hasApplyButton(page).catch(() => false));
    const shot = path.join(d, 'preview.png');
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    if (fs.existsSync(shot)) out.screenshot = shot;
  } catch (e) {
    out.error = 'preview_failed: ' + String((e && e.message) || e).split('\n')[0].slice(0, 160);
  } finally {
    try { await done(); } catch (_) {}
  }
  return out;
}

// ---- submit: dialog -> auth -> walk to Review -> SUBMIT -> proof. ----
async function submit(taskId, offer, profile, files, opts) {
  const board = detectBoard(offer);
  const targetUrl = (offer && offer.applyUrl) || (offer && offer.link) || '';
  const d = runDir(taskId);
  const out = { board, submitted: false, confirmation: '', appId: '', loginMethod: '', dialogMethod: '', steps: [], screenshot: '' };
  let done = async () => {};
  try {
    const ra = await resolveAuth(board, targetUrl, d, { cvPath: files && files.cv, headed: !!(opts && opts.headed), watchMs: (opts && opts.watchMs) || 0, email: opts && opts.email, taskId, awaitCodeMs: (opts && opts.awaitCodeMs) || 0, standbyMs: (opts && opts.standbyMs) || 0 });
    if (ra.authWall || !ra.page) { out.error = ra.error || 'auth_wall'; out.authWall = !!ra.authWall; return out; }
    done = ra.done || done;
    const page = ra.page;
    out.loginMethod = ra.loginMethod || '';
    out.dialogMethod = ra.dialogMethod || '';
    const answers = getAnswers();
    const sol = await solveToReview(page, profile, answers, files || {}, d, 10, offer);
    out.steps = sol.steps;
    if (sol.error === 'jail_violation') { out.error = 'jail_violation'; return out; }
    if (sol.unanswered.length) { out.error = 'unanswered_blocked'; out.unanswered = sol.unanswered; return out; }
    if (!sol.atReview) { out.error = 'no_review_reached'; return out; }
    if (!hostAllowed(page.url(), offer)) { out.error = 'jail_violation'; return out; }
    const clicked = await clickText(page, SUBMIT_RX, 12000);
    if (!clicked) { out.error = 'no_submit_button'; return out; }
    await page.waitForTimeout(8000);
    let body = '';
    try { body = await allVisibleText(page, 8000); } catch (_) { body = ''; }
    body = body.toLowerCase();
    const ok = /candidature (envoyée|bien reçue|reçue)|application (submitted|received|complete)|merci.*candidature|thank you.*application|votre candidature a bien/i.test(body);
    out.confirmation = ok ? 'confirmation text detected' : 'clicked, no confirmation text detected';
    if (!ok) {
      // No confirmation: harvest the LIVE post-click validation errors.
      let live = [];
      try { live = await formErrors(page).catch(() => []); } catch (_) {}
      out.error = 'submit_no_confirmation';
      out.formErrs = live.slice(0, 6);
      const shot = path.join(d, 'submit.png');
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      if (fs.existsSync(shot)) out.screenshot = shot;
      return out;
    }
    out.appId = ok ? extractAppId(body) : '';
    out.submitted = ok; // a click without confirmation (account wall, choice dialog) is NOT a submission
    const shot = path.join(d, 'submit.png');
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    if (fs.existsSync(shot)) out.screenshot = shot;
  } catch (e) {
    out.error = 'submit_failed: ' + String((e && e.message) || e).split('\n')[0].slice(0, 160);
  } finally {
    try { await done(); } catch (_) {}
  }
  return out;
}

// ---- experteer login (creds vault; session persists in profile dir) ----
async function experteerEnsureLogin() {
  const credsFile = path.join(DIR, 'creds', 'experteer.creds.json');
  if (!fs.existsSync(credsFile)) return { ok: false, need: 'identifiants Experteer (fichier creds/experteer.creds.json : {"email","password"})' };
  let creds;
  try { creds = JSON.parse(fs.readFileSync(credsFile, 'utf8')); } catch (_) { return { ok: false, need: 'creds/experteer.creds.json illisible' }; }
  if (!creds.email || !creds.password) return { ok: false, need: 'email + password dans creds/experteer.creds.json' };
  let ctx = null;
  try {
    ctx = await launchCtx('experteer');
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto('https://www.experteer.fr/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    await dismissConsent(page);
    const url = page.url();
    if (!/\/login(?:\?|$)/.test(new URL(url).pathname)) return { ok: true };
    const emailInput = page.locator('input[type="email"], input[name*="email"]').first();
    await emailInput.fill(creds.email, { timeout: 15000 });
    await page.locator('input[type="password"]').first().fill(creds.password, { timeout: 10000 });
    await page.locator('button[type="submit"]').filter({ hasText: 'Se connecter' }).first().click({ timeout: 10000 });
    await page.waitForTimeout(6000);
    const stillLogin = /\/login(?:\?|$)/.test(new URL(page.url()).pathname);
    return stillLogin ? { ok: false, need: 'connexion Experteer refusée (vérifie email/password, ou 2FA/CAPTCHA à résoudre à la main)' } : { ok: true };
  } catch (e) {
    return { ok: false, need: 'login Experteer impossible : ' + String((e && e.message) || e).split('\n')[0].slice(0, 140) };
  } finally {
    try { await ctx.close(); } catch (_) {}
  }
}

module.exports = {
  detectBoard, AUTO_BOARDS, splitName, profileCheck, docsCheck,
  preview, submit, experteerEnsureLogin, maskEmail, runDir,
  startApplication, isSignInWall, credsLogin, watchLogin, resolveAuth,
  requestEmailCode, submitLoginCode, googleSso, standbySignedIn,
  openBoardPage, hostAllowed, dismissAccountWall,
  solveToReview, extractAppId, attachFile, fillText, fillSelects, fillChecks, scanFields,
};
