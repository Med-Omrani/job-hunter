const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const api = require('./api_client.js');

const DIR = __dirname;
const GEN = path.join(DIR, '..', '..', 'tailored', 'gen_tailored.py');
const KB_FETCH = path.join(DIR, '..', '..', 'scripts', 'fetch_github_kb.js');
const KB = path.join(DIR, '..', '..', 'tailored', 'github_kb.json');
const EVENTS = path.join(DIR, 'events-worker.log');

function log(ev) {
  const line = JSON.stringify({ ts: new Date().toISOString(), proc: 'task-worker', ...ev });
  try { fs.appendFileSync(EVENTS, line + '\n'); } catch (_) {}
  if (process.env.VERBOSE) console.log(line);
}

function parseRef(request) {
  const t = String(request || '');
  // A source-prefixed offer id ("ashby-nubank-268e385a-...", "keejob-index-247193")
  // is the most reliable token, and getOffer() resolves it exactly. It has to be
  // tested FIRST: the numeric pattern below matches a FRAGMENT of a UUID -- in
  // "268e385a-35a4-442b-8078-2bd36d5491ab" it returns "8078-2", which 404s.
  const token = t.replace(/^\s*adapter\s+(documents\s+)?(pour\s+)?/i, '')
    .trim().split(/\s+/)[0] || '';
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{10,}$/.test(token) && /\d/.test(token)) return token;
  const m = t.match(/(adapter\s+)?((?:[a-z0-9-]+-)?\d{4}-\d+(?:-\d+)?)/i);
  if (m && m[2]) return m[2];
  const h = t.match(/[A-Za-z0-9][A-Za-z0-9-]{23,}/);
  if (h) return h[0];
  return '';
}

function runGen(payload, outdir) {
  const pfile = path.join(outdir, 'payload.json');
  fs.writeFileSync(pfile, JSON.stringify(payload, null, 1), 'utf8');
  return new Promise((resolve, reject) => {
    const c = spawn('python', [GEN, pfile, outdir], { cwd: path.dirname(GEN), windowsHide: true });
    let so = '', se = '';
    c.stdout.on('data', (d) => (so += d));
    c.stderr.on('data', (d) => (se += d));
    c.on('error', reject);
    const tm = setTimeout(() => { c.kill(); reject(new Error('gen timeout')); }, 240000);
    c.on('close', (code) => {
      clearTimeout(tm);
      if (code === 0) return resolve({ stdout: so, stderr: se });
      reject(new Error('gen exit ' + code + ' ' + String(se || so).slice(0, 300)));
    });
  });
}

function ensureGithubKb() {
  return new Promise((resolve) => {
    try {
      const st = fs.existsSync(KB) ? JSON.parse(fs.readFileSync(KB, 'utf8')) : null;
      const fresh = st && st.fetchedAt && Date.now() - new Date(st.fetchedAt).getTime() < 6 * 3600 * 1000;
      if (fresh) return resolve(false);
    } catch (_) {}
    const c = spawn('node', [KB_FETCH], { cwd: path.join(DIR, '..', '..'), windowsHide: true, stdio: 'ignore' });
    const tm = setTimeout(() => { try { c.kill(); } catch (_) {} resolve(false); }, 30000);
    c.on('close', () => { clearTimeout(tm); resolve(true); });
    c.on('error', () => { clearTimeout(tm); resolve(false); });
  });
}

function inlineOfferToOffer(v) {
  const o = { offerRef: '', title: '', company: '', location: '', contract: '', link: '', description: '', ...(v.offer || {}) };
  const slug = String(o.title || o.offerRef || 'external').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'external';
  if (!o.offerRef) o.offerRef = 'ext-' + slug;
  if (o._offerId) return { id: String(o._offerId), ...o, isExternal: false };
  return { id: 'external-' + slug, ...o, isExternal: true };
}

const busy = new Set();

async function runTask(id, doc) {
  if (busy.has(id)) return;
  busy.add(id);
  try {
    await runTaskInner(id, doc);
  } catch (e) {
    log({ type: 'task_error', id, error: String((e && e.message) || e).slice(0, 200) });
    try {
      await api.updateTask(id, { status: 'failed', result: 'Erreur interne du worker : ' + String((e && e.message) || e).slice(0, 160), failedAt: new Date().toISOString() });
    } catch (_) {}
  } finally {
    busy.delete(id);
  }
}

async function runTaskInner(id, doc) {
  const v = doc;
  const request = String(v.request || '');
  if (!/^adapt/i.test(request.trim())) {
    log({ type: 'skip_non_tailor', id, request: request.slice(0, 40) });
    return;
  }
  await api.updateTask(id, { status: 'in_progress', startedAt: new Date().toISOString() });
  log({ type: 'tailor_start', id, request: request.slice(0, 80) });

  let offer = null;
  let wantedRef = '';
  let wantedTitle = '';
  if (v.offer && (v.offer.title || v.offer.description)) {
    offer = inlineOfferToOffer(v);
  } else {
    const ref = parseRef(request);
    if (ref) {
      wantedRef = ref;
      try {
        const byId = await api.getOffer(ref);
        if (byId && byId.id) { offer = byId; log({ type: 'tailor_offer_by_id', id, ref }); }
      } catch (_) {}
      if (!offer) {
        // The full table first: the 1000-row window below misses older offers.
        let hits = [];
        try { hits = await api.searchOffers(ref, 25); } catch (_) {}
        let all = [];
        let hit = hits.find((o) => o.ref === ref) || hits.find((o) => o.id === ref)
               || hits.find((o) => String(o.ref || '').includes(ref)
                              || String(o.id || '').includes(ref));
        if (!hit) {
          all = await api.listOffers({ limit: 1000 });
          hit = all.find((o) => o.ref === ref) || all.find((o) => o.id === ref);
        }
        if (hit) { offer = hit; log({ type: 'tailor_offer_by_ref', id, ref, foundId: hit.id }); }
        if (!offer && ref.length >= 6) {
          const fuzzy = all.find((o) => String(o.ref || '').includes(ref) || String(o.id || '').includes(ref));
          if (fuzzy) { offer = fuzzy; log({ type: 'tailor_offer_by_ref_fuzzy', id, ref, foundId: fuzzy.id }); }
        }
      }
    }
    if (!offer && request) {
      const titleKw = request.replace(/^\s*adapter\s+(documents\s+)?(pour\s+)?/i, '').replace(/^\s*adapt\s+.*?\bfor\s+(offer\s+)?/i, '').replace(/^\S+\s+/, '').trim();
      if (titleKw.length > 6) {
        wantedTitle = titleKw;
        // The 1000-row window below only ever holds the newest offers, so an
        // older one asked for by title was unreachable. Search first.
        let all = [];
        try { all = await api.searchOffers(titleKw, 50); } catch (_) {}
        if (!all.length) all = await api.listOffers({ limit: 1000 });
        const td = all.find((o) => o.title === titleKw);
        if (td) offer = td;
        if (!offer) {
          const fz = all.find((o) => String(o.ref || '').includes(titleKw) || String(o.id || '').includes(titleKw));
          if (fz) { offer = fz; log({ type: 'tailor_offer_by_title_fuzzy', id, title: titleKw.slice(0, 60), foundId: fz.id }); }
        }
        log({ type: 'tailor_offer_by_title', id, title: titleKw.slice(0, 60), found: !!offer });
      }
    }
    if (!offer && (wantedRef || wantedTitle)) {
      // Explicit offer requested but not found: NEVER fall back to a random
      // top offer (that once tailored the wrong job). Fail loudly instead.
      const want = (wantedRef || wantedTitle).slice(0, 60);
      await api.updateTask(id, { status: 'failed', result: `Offre introuvable pour « ${want} ». Précise un lien ou une référence exacte.`, failedAt: new Date().toISOString() });
      try { await api.sendChat(`❌ Adaptation impossible : offre « ${want} » introuvable. Envoie-moi le lien ou la référence exacte.`, 'agent'); } catch (_) {}
      log({ type: 'tailor_offer_not_found', id, want });
      return;
    }
    if (!offer) {
      const all = await api.listOffers({ limit: 100 });
      const list = all.filter((o) => o.status === 'new' && o.match);
      list.sort((a, b) => (b.score || 0) - (a.score || 0));
      if (!list.length) {
        await api.updateTask(id, { status: 'failed', result: "Aucune offre éligible trouvée pour l'adaptation.", failedAt: new Date().toISOString() });
        try { await api.sendChat("❌ Aucune offre éligible trouvée. Précise-moi un lien ou une référence d'offre.", 'agent'); } catch (_) {}
        return;
      }
      offer = list[0];
    }
  }

  await ensureGithubKb();

  // agentNote is our own meta-text ("Correspond a ton profil (Keejob Tunisie
  // (index llms))"), never the employer's wording, and it must not reach the
  // analyser: the keejob-index source name contains "llms", which matched the
  // \bllm pattern in gen_tailored.ML_TITLE/AI_SIGNALS and forced flavor='ai'.
  // Offer 247590 (KROMBERG & SCHUBERT, network/security post) got an AI/ML CV
  // and a letter about "missions de conseil" because of that; without the note
  // _flavor() correctly returns 'embedded'. Only title/keywords/description --
  // i.e. the ad's own vocabulary -- decide the flavour now.
  const descParts = [offer.title, Array.isArray(offer.keywords) ? offer.keywords.join(', ') : '', Array.isArray(offer.matches) ? offer.matches.join(', ') : '', offer.description].filter(Boolean);
  const payload = {
    // Doc ids are keyed off this value, and chat-bot.docker.js looks docs up with
    // `offer.ref || offer.id`, so they MUST agree or "apply" finds no document.
    // Inline offers (chat-bot bridge, pasted ads) carry `offerRef` and no `ref`,
    // so without the middle term they silently fell back to the long offer id and
    // created a duplicate `cv-arbeitnow-...` set the apply flow never reads.
    offerRef: String(offer.ref || offer.offerRef || offer.id || ''),
    title: offer.title || 'le poste',
    company: offer.company || '',
    location: offer.location || '',
    contract: offer.contract || '',
    link: offer.link || '',
    description: String(descParts.join('. ')).slice(0, 4000),
  };

  // Optional second CV skin. Set per task by chat-bot's takeCvTemplate(), or
  // globally with the CV_TEMPLATE env var (gen_tailored.py falls back to it).
  // Absent/unknown values keep the default frozen CV/cv.tex.
  const cvTpl = String(v.cvTemplate || process.env.CV_TEMPLATE || '').trim();
  if (cvTpl) payload.cvTemplate = cvTpl;

  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobcenter-'));
  let gen;
  try {
    gen = await runGen(payload, outdir);
  } catch (e) {
    const msg = String((e && e.message) || e);
    // The generator refuses to emit a document that fails a quality gate (no
    // invented skill, wrong row last, generic letter, >1 page). Those are not
    // "technical problems" to shrug off, so the reason is surfaced verbatim and
    // the offer is marked errored: a stale 'ready' from a previous generation
    // must not keep a rejected pair attached in the app.
    log({ type: 'tailor_gen_error', id, offerRef: payload.offerRef, error: msg });
    await api.updateTask(id, { status: 'failed', result: 'La génération des documents a échoué : ' + msg.slice(0, 300), failedAt: new Date().toISOString() });
    if (!offer.isExternal) {
      try {
        await api.updateOffer(offer.id, { tailorStatus: 'error', tailoredOfferRef: payload.offerRef, tailorError: msg.slice(0, 300), updatedAt: new Date().toISOString() });
      } catch (_) {}
    }
    try { await api.sendChat('❌ La génération a été refusée par les contrôles qualité : ' + msg.slice(0, 200) + '\nDis-moi « statut » pour le détail.', 'agent'); } catch (_) {}
    return;
  }
  try {
    const cv = fs.readFileSync(path.join(outdir, 'cv.pdf'));
    const letter = fs.readFileSync(path.join(outdir, 'lettre.pdf'));
    const enPdfPath = path.join(outdir, 'letter_en.pdf');
    const hasEn = fs.existsSync(enPdfPath);
    const mainLetter = hasEn ? fs.readFileSync(enPdfPath) : letter;
    // Strip gender markers from the display label: the raw board title carries
    // "(all genders)"/"(m/f/d)", which was ending up in the document name shown
    // in the app. Mirrors GENDER_MARKERS in tailored/gen_tailored.py.
    // Case-INSENSITIVE (2026-10-06): French boards write "(H/F)" and "(F/H)" in
    // uppercase, which the former [hmdxwf] class (no `i` flag) never matched, so
    // "Embedded Software Engineer (F/H)" shipped verbatim into the doc name.
    const label = payload.title
      .replace(/\(?\s*all\s+genders?\s*\)?/gi, ' ')
      .replace(/\(?\s*[hmdxwf](?:\s*\/\s*[hmdxwf]){1,4}\s*\)?/gi, ' ')
      .replace(/\(?\s*[mf]\s+ou\s+[mf]\s*\)?/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim() || payload.title;
    const cvB64 = cv.toString('base64');
    const letB64 = mainLetter.toString('base64');
    await api.createDoc({
      id: 'cv-' + payload.offerRef,
      offerRef: payload.offerRef,
      offreTitle: payload.title,
      name: 'CV — ' + label + ' (' + payload.offerRef + ')',
      type: 'cv',
      pdfBase64: cvB64,
    });
    if (hasEn) {
      // Keep the French letter available whenever the English one takes the
      // main 'lettre-<ref>' slot (docsCheck / apply attach that one).
      await api.createDoc({
        id: 'lettre-fr-' + payload.offerRef,
        offerRef: payload.offerRef,
        offreTitle: payload.title,
        name: 'Lettre (FR) — ' + label + ' (' + payload.offerRef + ')',
        type: 'letter',
        pdfBase64: letter.toString('base64'),
      });
    }
    await api.createDoc({
      id: 'lettre-' + payload.offerRef,
      offerRef: payload.offerRef,
      offreTitle: payload.title,
      name: 'Lettre' + (hasEn ? ' (EN)' : '') + ' — ' + label + ' (' + payload.offerRef + ')',
      type: 'letter',
      pdfBase64: letB64,
    });
    if (!offer.isExternal) {
      await api.updateOffer(offer.id, { tailorStatus: 'ready', tailoredOfferRef: payload.offerRef, updatedAt: new Date().toISOString() });
    }
    await api.updateTask(id, {
      status: 'done',
      offerId: offer.id,
      result: 'CV + lettre adaptés pour « ' + payload.title + ' » (' + payload.offerRef + '). Prêts dans l\'onglet CV & Lettres.',
      doneAt: new Date().toISOString(),
    });
    try { await api.sendChat('✅ CV + lettre prêts pour « ' + payload.title + ' » (' + payload.offerRef + ') — onglet CV & Lettres.', 'agent'); } catch (_) {}
    try { await require('./push.js').notify({ title: 'Documents prêts', body: 'CV + lettre : ' + payload.title, tag: 'task_done' }); } catch (_) {}
    // The generator prints one JSON line describing what it produced (flavor,
    // role, skill_rows, qa). tailor_done used to log only the byte sizes, so a
    // generic letter or an off-flavor CV could not be diagnosed after the fact.
    let qa = null;
    try {
      const line = String(gen.stdout || '').trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
      if (line) qa = JSON.parse(line);
    } catch (_) {}
    log({ type: 'tailor_done', id, offerId: offer.id, ref: payload.offerRef, kbCv: Math.round(cv.length / 1024), kbLet: Math.round(letter.length / 1024),
          flavor: qa && qa.flavor, role: qa && qa.role, skillRows: qa && qa.skill_rows,
          pagesCv: qa && qa.pages_cv, pagesLettre: qa && qa.pages_lettre, qa: qa && qa.qa });

    // Auto-apply chain: if the offer is marked auto_apply, queue an apply task
    // immediately so the apply-worker picks it up without manual intervention.
    // AUTO-APPLY IS FROZEN (2026-09-25): tailoring still runs, but we never
    // chain an apply task. Without this, every re-tailor of a score>=3 offer
    // minted another 'auto-<ref>' row that nothing would ever claim.
    const autoFlow = require('./auto-apply-flow.js');
    const offerAction = String((offer.action || '')).toLowerCase();
    if (!autoFlow.isAutoApplyEnabled()) {
      log({ type: 'auto_apply_chain_frozen', tailorTaskId: id, offerRef: payload.offerRef });
    } else if (!offer.isExternal && (offerAction === 'auto_apply' || offerAction === 'autopostule')) {
      try {
        // Deterministic id, same namespace as batch-apply.js / auto-apply-flow.js
        // ('auto-' + offerRef). The previous 'apply-auto-<ref>-<ts>' minted a NEW
        // row on every re-tailor, so an offer already queued/in-flight got a
        // second apply task -> double application. Upsert-on-id makes the chain
        // idempotent; the active-task guard keeps an in-flight run from being
        // reset to 'queued' underneath the apply-worker.
        const applyTaskId = 'auto-' + payload.offerRef;
        const existing = await api.getTask(applyTaskId).catch(() => null);
        if (existing && ['queued', 'in_progress', 'confirmed', 'awaiting_confirm'].includes(String(existing.status || ''))) {
          log({ type: 'auto_apply_chain_skipped', applyTaskId, offerRef: payload.offerRef, status: existing.status });
          return;
        }
        await api.createTask({
          id: applyTaskId,
          kind: 'apply',
          action: 'auto_apply',
          request: 'auto_apply ' + payload.offerRef,
          status: 'queued',
          offerRef: payload.offerRef,
          offerId: offer.id,
          createdAt: new Date().toISOString(),
          autoChained: true,
        });
        log({ type: 'auto_apply_chained', tailorTaskId: id, applyTaskId, offerRef: payload.offerRef });
        try { await api.sendChat('🤖 Documents prêts → candidature automatique lancée pour « ' + payload.title + ' » (task ' + applyTaskId + ').', 'agent'); } catch (_) {}
      } catch (chainErr) {
        log({ type: 'auto_chain_error', id, error: String((chainErr && chainErr.message) || chainErr).slice(0, 200) });
      }
    }
  } catch (e) {
    log({ type: 'tailor_upload_error', id, error: String((e && e.message) || e) });
    await api.updateTask(id, { status: 'failed', result: 'Enregistrement des documents échoué : ' + String((e && e.message) || e).slice(0, 160), failedAt: new Date().toISOString() });
  } finally {
    try { fs.rmSync(outdir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function pollQueued() {
  let tasks;
  try {
    tasks = await api.listTasks({ status: 'queued', limit: 25 });
  } catch (e) {
    log({ type: 'poll_error', error: String((e && e.message) || e) });
    return;
  }
  for (const t of tasks) {
    if (busy.has(t.id)) continue;
    if (t.status !== 'queued') continue;
    // simple age check: created_at
    let age = 0;
    if (t.created_at) age = Date.now() - new Date(t.created_at).getTime();
    if (age > 0 && age < 20000) continue;
    log({ type: 'poll_claim', id: t.id, ageMs: age });
    await runTask(t.id, t);
  }
}

process.on('unhandledRejection', (e) => log({ type: 'worker_error', context: 'unhandled_rejection', error: String((e && e.message) || e) }));
process.on('uncaughtException', (e) => log({ type: 'worker_error', context: 'uncaught_exception', error: String((e && e.message) || e) }));

(async () => {
  log({ type: 'worker_start', runId: Date.now() });
  setInterval(() => { pollQueued().catch((e) => log({ type: 'poll_error', error: String((e && e.message) || e) })); }, 10000);
  console.log('task-worker-docker running API=' + api.API);
  // initial poll
  pollQueued();
})().catch((e) => { console.error('WORKER FATAL', e); log({ type: 'worker_fatal', error: String((e && e.message) || e) }); process.exit(1); });
