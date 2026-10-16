'use strict';
// Apply worker — executes kind:'apply' tasks in two gated phases:
// queued -> preview (fill+screenshot, NEVER submit) -> awaiting_confirm
// awaiting_confirm -> (user says OUI) confirmed -> submit -> done/failed.
// needs_info pauses with a chat message listing what's missing.
const fs = require('fs');
const path = require('path');
const api = require('./api_client.js');
const driver = require('./apply-driver.js');

const DIR = __dirname;
const EVENTS = path.join(DIR, 'events-apply.log');

function log(ev) {
  const line = JSON.stringify({ ts: new Date().toISOString(), proc: 'apply-worker', ...ev });
  try { fs.appendFileSync(EVENTS, line + '\n'); } catch (_) {}
  if (process.env.VERBOSE) console.log(line);
}

function parseRef(request) {
  const t = String(request || '');
  // 1. Prefixed ref: auto_apply/adapter/apply + token
  const m = t.match(/(auto_apply|adapter|apply)\s+([A-Za-z0-9][A-Za-z0-9-]{2,})/i);
  if (m && m[2]) return m[2];
  // 2. Long numeric ref (LinkedIn/SmartRecruiters: 744000150959799)
  const num = t.match(/\b(\d{9,})\b/);
  if (num) return num[1];
  // 3. Long hex ref (Jobijoba: f3b3d1a159ef410795822d84b20dd661)
  const hex = t.match(/\b([a-f0-9]{24,})\b/i);
  if (hex) return hex[1];
  return '';
}


async function resolveOffer(task) {
  const v = task;
  const ref = v.offerRef || parseRef(v.request);
  if (ref) {
    try { const o = await api.getOffer(ref); if (o && o.id) return o; } catch (_) {}
    const all = await api.listOffers({ limit: 1000 });
    const hit = all.find((o) => o.ref === ref) || all.find((o) => o.id === ref);
    if (hit) return hit;
  }
  return null;
}

function shortId(id) { return String(id).slice(-5).toUpperCase(); }

const busy = new Set();

// Watchdogs: a browser run must never orphan a task or a window.
// - withTimeout caps any preview/submit run (kills bot browsers on expiry).
// - poll reclaims in_progress tasks older than 45 min (max legit run ~30 min).
async function withTimeout(promise, ms, label) {
  let tm;
  const to = new Promise((_, rej) => { tm = setTimeout(() => rej(new Error('run_timeout:' + label)), ms); });
  try { return await Promise.race([promise, to]); }
  finally { clearTimeout(tm); }
}

function killBotBrowsers() {
  try {
    require('child_process').spawnSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'jobcenter-docker' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"],
      { timeout: 20000, stdio: 'ignore' });
  } catch (_) {}
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// CAPTCHA / bot-challenge detection on a preview result. Never auto-submits
// through a challenge (CLAUDE.md safety rule 3): pause and ask the user.
function challengeDetected(pv) {
  const err = String((pv && pv.error) || '');
  const errs = Array.isArray(pv && pv.formErrs) ? pv.formErrs.join(' ') : '';
  return /captcha|recaptcha|unusual traffic|checking your browser|verifi(er|cation) de votre navigateur|challenge|access denied|too many requests|rate limit/i.test(err + ' ' + errs);
}

// THE GATE. Positive evidence only — we submit when everything is clean, and we
// refuse in every other case. The old code applied two of these checks ONLY
// when action !== 'auto_apply', which meant auto mode skipped them entirely.
function submitGate(pv, prev) {
  const reasons = [];
  if (prev && prev.manual) reasons.push('board manuel');
  if (challengeDetected(pv)) reasons.push('captcha/défi anti-bot');
  if (pv && pv.authWall) reasons.push('mur de connexion');
  if (pv && pv.error === 'jail_violation') reasons.push('hors domaine autorisé');
  const unfilled = Number(prev ? prev.filled : (pv ? pv.filled.length : 0)) || 0;
  const cvOk = !!(prev ? prev.cvAttached : pv && pv.cvAttached);
  if (!cvOk) reasons.push('CV non joint');
  if (!unfilled) reasons.push('0 champ rempli');
  if (prev && Array.isArray(prev.formErrs) && prev.formErrs.length) reasons.push(prev.formErrs.length + ' erreur(s) formulaire');
  if (prev && Array.isArray(prev.unanswered) && prev.unanswered.length) reasons.push(prev.unanswered.length + ' question(s) sans réponse');
  if (pv && Array.isArray(pv.unanswered) && pv.unanswered.length) reasons.push(pv.unanswered.length + ' question(s) sans réponse');
  if (pv && !pv.atReview) reasons.push('page de révision non atteinte');
  return { ok: reasons.length === 0, reasons };
}

async function runTask(id, doc) {
  if (busy.has(id)) return;
  busy.add(id);
  try {
    // Fresh snapshot: poll-time copies go stale (loginWatch/loginCode set by chat after listing).
    try { const fresh = await api.getTask(id); if (fresh && fresh.id) doc = fresh; } catch (_) {}
    const status = doc.status;
    if (status === 'queued') await doPreview(id, doc);
    else if (status === 'confirmed') await doSubmit(id, doc);
  } catch (e) {
    log({ type: 'task_error', id, error: String((e && e.message) || e).slice(0, 200) });
    try { await api.updateTask(id, { status: 'failed', result: 'Erreur interne : ' + String((e && e.message) || e).slice(0, 140), needs: [], questions: [] }); } catch (_) {}
  } finally { busy.delete(id); }
}

async function doPreview(id, doc) {
  await api.updateTask(id, { status: 'in_progress', startedAt: new Date().toISOString() });
  const offer = await resolveOffer(doc);
  if (!offer) {
    await api.updateTask(id, { status: 'failed', result: "Offre introuvable. Précise un lien ou une référence.", needs: [], questions: [] });
    try { await api.sendChat("❌ Candidature : offre introuvable. Donne-moi un lien ou une référence exacte.", 'agent'); } catch (_) {}
    return;
  }
  const offerRef = String(offer.ref || offer.id || '');
  const { profile, missing: pMissing } = await driver.profileCheck();
  const { cvId, lettreId, missing: dMissing } = await driver.docsCheck(offerRef);
  const needs = [...pMissing, ...dMissing];
  if (needs.length) {
    await api.updateTask(id, { status: 'needs_info', offerRef, needs });
    try { await api.sendChat(`❓ Avant de postuler chez « ${offer.title || offerRef} », il me manque :\n- ` + needs.join('\n- '), 'agent'); } catch (_) {}
    log({ type: 'preview_needs_info', id, offerRef, needs: needs.join('|').slice(0, 160) });
    return;
  }
  const board = driver.detectBoard(offer);
  // download tailored CV + cover letter for attachment
  let cvPath = '';
  try {
    const buf = await api.docPdf(cvId);
    cvPath = path.join(driver.runDir(id), 'cv.pdf');
    fs.writeFileSync(cvPath, buf);
  } catch (e) { log({ type: 'cv_download_error', id, error: String(e.message || e).slice(0, 100) }); }
  let lettrePath = '';
  try {
    const buf = await api.docPdf(lettreId);
    lettrePath = path.join(driver.runDir(id), 'lettre.pdf');
    fs.writeFileSync(lettrePath, buf);
  } catch (e) { log({ type: 'lettre_download_error', id, error: String(e.message || e).slice(0, 100) }); }

  if (board === 'experteer') {
    const login = await driver.experteerEnsureLogin();
    if (!login.ok) {
      await api.updateTask(id, { status: 'needs_info', offerRef, needs: [login.need] });
      try { await api.sendChat(`❓ Experteer : ${login.need}`, 'agent'); } catch (_) {}
      return;
    }
  }

  const files = { cv: cvPath, lettre: lettrePath };
  const flowOpts = { headed: true, watchMs: doc.loginWatch ? 300000 : 0, email: profile.email, taskId: id, awaitCodeMs: 720000, standbyMs: 720000 };
  killBotBrowsers(); // sweep stale bot windows: single lane, no live run to disturb
  let pv;
  try {
    pv = await withTimeout(driver.preview(id, offer, profile, files, flowOpts), 30 * 60 * 1000, 'preview');
  } catch (e) {
    killBotBrowsers();
    pv = { error: 'run_timeout_30min', board: driver.detectBoard(offer), auto: true };
  }
  if (/open_failed/.test(String((pv && pv.error) || ''))) {
    // Browser rot: sweep leaked bot windows once and retry the preview cleanly.
    killBotBrowsers();
    await sleepMs(5000);
    log({ type: 'preview_retry_open', id, offerRef });
    try {
      pv = await withTimeout(driver.preview(id, offer, profile, files, flowOpts), 30 * 60 * 1000, 'preview-retry');
    } catch (e) {
      killBotBrowsers();
      pv = { error: 'run_timeout_30min', board: driver.detectBoard(offer), auto: true };
    }
  }
  if (pv.error && !pv.authWall) {
    const err = String(pv.error || '');
    const friendly = /page_empty_retry/.test(err)
      ? `Page employeur vide (chargement ${board} incomplet). Dis-moi « relance » pour réessayer.`
      : /run_timeout_30min/.test(err)
        ? 'Run bloqué 30 min sans réponse (navigateur bot relancé). Dis-moi « relance » pour réessayer.'
        : 'Préparation impossible : ' + pv.error;
    await api.updateTask(id, { status: 'failed', result: friendly, loginWatch: false, needs: [], questions: [] });
    try { await api.sendChat(`❌ Candidature « ${offer.title || offerRef} » : ${friendly}`, 'agent'); } catch (_) {}
    return;
  }
  if (pv.authWall) {
    const err = String(pv.error || 'signin_required');
    let needs, chat;
    if (/email_code_sent/.test(err)) {
      needs = [`code de connexion envoyé à ${driver.maskEmail(profile.email)}`, 'dicte le code reçu par mail en chat (12 min max, anciens codes ignorés)'];
      chat = `📩 « ${offer.title || offerRef} » (${board}) : code de connexion envoyé à ${driver.maskEmail(profile.email)}.\nDicte-moi le code reçu par mail — je le saisis et je continue tout seul.`;
    } else if (/email_code_timeout/.test(err)) {
      needs = ['code non reçu à temps', 'dis « renvoie » pour un nouveau code'];
      chat = `⏰ « ${offer.title || offerRef} » : pas de code reçu en 12 min. Dis « renvoie » et je renvoie un code frais.`;
    } else if (/code_rejected|code_failed|bad_code/.test(err)) {
      needs = ['code refusé ou expiré', 'dis « renvoie » pour un nouveau code'];
      chat = `❌ « ${offer.title || offerRef} » : code refusé. Dis « renvoie » pour un nouveau code.`;
    } else if (/sso_password_prompt/.test(err)) {
      needs = ['Google demande le mot de passe du compte', 'termine la connexion dans Chrome puis dis « relance »'];
      chat = `🔐 « ${offer.title || offerRef} » : Google redemande le mot de passe (session trop vieille). Connecte-toi dans Chrome puis dis « relance ».`;
    } else if (/standby_timeout/.test(err)) {
      needs = ['pas de connexion détectée en 12 min', 'connecte-toi dans Chrome puis dis « relance »'];
      chat = `⏰ « ${offer.title || offerRef} » : toujours pas connecté après 12 min d'attente. Connecte-toi dans Chrome puis dis « relance ».`;
    } else {
      needs = [`connexion ${board} requise`, `une fenêtre Chrome est ouverte sur le PC (page ${board}) : connecte-toi (ton compte Google si proposé), je détecte et je continue tout seul`, `lien direct : ${offer.link || ''}`, `dis « login » pour 5 min d'attente active`];
      chat = `🔐 « ${offer.title || offerRef} » (${board}) : compte requis.\nUne fenêtre Chrome est ouverte sur le PC — connecte-toi (ton compte Google si proposé), je reprends tout seul.\nLien : ${offer.link || ''}\nSi Google demande une validation sur ton téléphone, accepte-la.`;
    }
    await api.updateTask(id, { status: 'needs_info', offerRef, needs, loginWatch: false,
      preview: { board, manual: false, url: offer.link, title: pv.title || '', filled: 0, cvAttached: !!pv.cvAttached, lettreAttached: !!pv.lettreAttached, hasApply: false, atReview: false, steps: 0, formErrs: [], dialogMethod: pv.dialogMethod || '', loginMethod: pv.loginMethod || '', screenshot: pv.screenshot || '' } });
    try { await api.sendChat(chat, 'agent'); } catch (_) {}
    try { await require('./push.js').notify({ title: 'Action requise — candidature', body: String(chat).slice(0, 180), tag: 'apply_blocked' }); } catch (_) {}
    log({ type: 'preview_authwall', id, offerRef, board, err: err.slice(0, 60) });
    return;
  }
  if (pv.unanswered && pv.unanswered.length) {
    // Prefer the label/options captured by scanFields: the user must be able to
    // answer a concrete question ("Pays — Tunisie / France / ...") instead of
    // guessing a value we were never given.
    const qs = pv.unanswered.slice(0, 6).map((q, i) => {
      const nm = q.label || q.field || '(sans nom)';
      const opts = (q.options && q.options.length) ? ` (choix : ${q.options.slice(0, 8).join(' / ')})` : '';
      const req = q.required ? ' *' : '';
      return `Q${i + 1} [${q.type || 'text'}] ${nm}${req}${opts}`;
    });
    // A CV that could not be attached to a real resume slot is a hard stop for
    // auto mode: submitting without it produces a rejected application.
    const attachNote = (Array.isArray(pv.attachNotes) ? pv.attachNotes : []).filter((n) => n.kind === 'cv' && !/attached/.test(n.reason || ''));
    const attachNeed = attachNote.length ? [`CV non joint (${attachNote[0].reason}${attachNote[0].into ? ' — champ « ' + attachNote[0].into + ' »' : ''})`, 'ouvre le formulaire à la main pour vérifier le dépôt du CV, puis dis « relance »'] : [];
    await api.updateTask(id, { status: 'needs_info', offerRef, needs: ['questions formulaire obligatoires :', ...qs, 'réponds en chat puis dis « relance »', ...attachNeed], questions: pv.unanswered.slice(0, 6), loginWatch: false,
      fieldScan: (pv.fieldScan || []).slice(0, 120),
      preview: { board, manual: false, url: offer.link, title: pv.title, filled: pv.filled.length, cvAttached: !!pv.cvAttached, lettreAttached: !!pv.lettreAttached, hasApply: !!pv.hasApply, atReview: !!pv.atReview, steps: (pv.steps || []).length, formErrs: pv.formErrs || [], attachNotes: pv.attachNotes || [], dialogMethod: pv.dialogMethod || '', loginMethod: pv.loginMethod || '', screenshot: pv.screenshot } });
    try { await api.sendChat(`❓ « ${offer.title || offerRef} » : le formulaire exige des réponses que je ne peux pas inventer :\n- ` + qs.join('\n- ') + (attachNeed.length ? `\n- ` + attachNeed[0] : '') + `\nRéponds en chat, j'enregistre et je reprends avec « relance ».`, 'agent'); } catch (_) {}
    try { await require('./push.js').notify({ title: 'Questions avant de postuler', body: String(offer.title || offerRef).slice(0, 120), tag: 'apply_questions' }); } catch (_) {}
    log({ type: 'preview_questions', id, offerRef, n: pv.unanswered.length, attach: attachNote.length });
    return;
  }
  if (pv.auto && !pv.atReview && !pv.hasApply && !(pv.unanswered && pv.unanswered.length)) {
    await api.updateTask(id, { status: 'failed', result: 'Page formulaire inaccessible (mur de connexion non détecté ou mise en page inconnue). Dis-moi « relance » pour réessayer.', loginWatch: false, needs: [], questions: [] });
    try { await api.sendChat(`❌ Candidature « ${offer.title || offerRef} » : page formulaire inaccessible. Dis-moi « relance » pour réessayer.`, 'agent'); } catch (_) {}
    log({ type: 'preview_noreview', id, offerRef, board, dialog: pv.dialogMethod || '', diag: pv.diag || {} });
    return;
  }
  // LinkedIn: apply-driver deliberately reports auto:false (ban risk). The
  // sanctioned route is linkedin-bot.js EasyApply, reached from doSubmit when
  // the action is auto_apply. Here we only mark the task confirmed; doSubmit
  // dispatches to the dedicated bot.
  if (board === 'linkedin') {
    if (doc.action === 'auto_apply' || doc.action === 'autopostule' || doc.action === 'auto-postule') {
      await api.updateTask(id, { status: 'confirmed', confirmedAt: new Date().toISOString(), action: 'auto_apply', preview: { board, manual: false, route: 'linkedin-bot', url: offer.link, title: offer.title, filled: 0, cvAttached: !!cvPath, lettreAttached: !!lettrePath, hasApply: false, atReview: false, steps: 0, formErrs: [] } });
      try { await require('./push.js').notify({ title: 'Auto-Apply LinkedIn', body: `${offer.title || offerRef} → EasyApply`, tag: 'auto_apply_started' }); } catch (_) {}
      log({ type: 'auto_apply_confirmed_linkedin', id, offerRef, board });
      return;
    }
    const msg = `🔍 « ${offer.title || offerRef} » est sur LinkedIn : je prépare tout mais c'est toi qui cliques (risque de bannissement sinon).\nLien : ${offer.link}\nDocuments prêts : CV + lettre adaptés (${offerRef}).\nPostule à la main, puis dis-moi « c'est postulé ».`;
    await api.updateTask(id, { status: 'awaiting_confirm', offerRef, preview: { board, manual: true, url: offer.link } });
    try { await api.sendChat(msg, 'agent'); } catch (_) {}
    log({ type: 'preview_manual', id, offerRef, board });
    return;
  }
  if (!pv.auto) {
    if (doc.action === 'auto_apply' || doc.action === 'autopostule') {
      await api.updateTask(id, { status: 'confirmed', confirmedAt: new Date().toISOString(), action: 'auto_apply' });
      try { await require('./push.js').notify({ title: 'Auto-Apply en cours', body: `${offer.title || offerRef} → soumission auto`, tag: 'auto_apply_started' }); } catch (_) {}
      log({ type: 'auto_apply_confirmed', id, offerRef, board });
      return;
    }
    const msg = `🔍 « ${offer.title || offerRef} » (${board}) : candidature manuelle.\nLien : ${offer.link}\nDocuments prêts : CV + lettre adaptés (${offerRef}).\nPostule à la main, puis dis-moi « c'est postulé ».`;
    await api.updateTask(id, { status: 'awaiting_confirm', offerRef, preview: { board, manual: true, url: offer.link } });
    try { await api.sendChat(msg, 'agent'); } catch (_) {}
    log({ type: 'preview_manual', id, offerRef, board });
    return;
  }
  if (pv.auto && (doc.action === 'auto_apply' || doc.action === 'autopostule' || doc.action === 'auto-postule')) {
    // Pre-authorized auto mode: no OUI. The gate in doSubmit still decides.
    const autoReasons = [];
    if (challengeDetected(pv)) autoReasons.push('captcha/défi anti-bot');
    if (Array.isArray(pv.formErrs) && pv.formErrs.length) autoReasons.push(pv.formErrs.length + ' erreur(s) formulaire');
    if (autoReasons.length) {
      await api.updateTask(id, { status: 'needs_info', offerRef, needs: [...autoReasons, 'rien n\'a été envoyé : résous le blocage puis dis « relance »'], loginWatch: false,
        preview: { board, manual: false, url: offer.link, title: pv.title, filled: pv.filled.length, cvAttached: pv.cvAttached, lettreAttached: !!pv.lettreAttached, hasApply: pv.hasApply, atReview: !!pv.atReview, steps: (pv.steps || []).length, formErrs: pv.formErrs || [], attachNotes: pv.attachNotes || [], dialogMethod: pv.dialogMethod || '', loginMethod: pv.loginMethod || '', screenshot: pv.screenshot } });
      try { await api.sendChat(`⛔ « ${offer.title || offerRef} » (${board}) : auto-postule bloquée — ${autoReasons.join(', ')}. Rien n'a été envoyé.`, 'agent'); } catch (_) {}
      try { await require('./push.js').notify({ title: 'Auto-Apply bloquée', body: autoReasons.join(', ').slice(0, 140), tag: 'apply_blocked' }); } catch (_) {}
      log({ type: 'auto_apply_blocked', id, offerRef, board, reasons: autoReasons });
      return;
    }
    await api.updateTask(id, { status: 'confirmed', confirmedAt: new Date().toISOString(), action: 'auto_apply',
      preview: { board, manual: false, url: offer.link, title: pv.title, filled: pv.filled.length, cvAttached: pv.cvAttached, lettreAttached: !!pv.lettreAttached, hasApply: pv.hasApply, atReview: !!pv.atReview, steps: (pv.steps || []).length, formErrs: pv.formErrs || [], attachNotes: pv.attachNotes || [], dialogMethod: pv.dialogMethod || '', loginMethod: pv.loginMethod || '', screenshot: pv.screenshot } });
    try { await require('./push.js').notify({ title: 'Auto-Apply en cours', body: `${offer.title || offerRef} → soumission auto`, tag: 'auto_apply_started' }); } catch (_) {}
    log({ type: 'auto_apply_confirmed_auto', id, offerRef, board });
    return;
  }
  const masked = `${profile.name} · ${driver.maskEmail(profile.email)} · ${profile.phone ? 'tél OK' : 'tél ?'}`;
  const msg = `📝 Aperçu de candidature (#${shortId(id)}) — « ${offer.title || offerRef} » [${board}]\n` +
    `Page : ${pv.title || offer.link}\n` +
    `Profil : ${masked}\n` +
    `Parcours : ${pv.dialogMethod || '?'} · login : ${pv.loginMethod || '?'} · étapes : ${(pv.steps || []).length} · page finale : ${pv.atReview ? 'révision' : 'à vérifier'}\n` +
    `Champs remplis : ${pv.filled.length} · CV joint : ${pv.cvAttached ? 'oui' : 'NON'} · Lettre jointe : ${pv.lettreAttached ? 'oui' : 'NON'}\n` +
    ((pv.formErrs && pv.formErrs.length) ? `⚠️ Alertes formulaire : ${pv.formErrs.length} (voir capture)\n` : '') +
    `Bouton de candidature détecté : ${pv.hasApply ? 'oui' : 'non (à vérifier)'}\n` +
    `Réponds OUI pour que je postule, ou NON pour annuler.`;
  await api.updateTask(id, {
    status: 'awaiting_confirm', offerRef, loginWatch: false,
    result: '', needs: [], questions: [],
    preview: { board, manual: false, url: offer.link, title: pv.title, filled: pv.filled.length, cvAttached: pv.cvAttached, lettreAttached: !!pv.lettreAttached, hasApply: pv.hasApply, atReview: !!pv.atReview, steps: (pv.steps || []).length, formErrs: pv.formErrs || [], attachNotes: pv.attachNotes || [], dialogMethod: pv.dialogMethod || '', loginMethod: pv.loginMethod || '', screenshot: pv.screenshot },
  });
  try { await api.sendChat(msg, 'agent'); } catch (_) {}
  try { await require('./push.js').notify({ title: 'Aperçu candidature — réponds OUI ou NON', body: String(offer.title || offerRef).slice(0, 140), tag: 'apply_preview' }); } catch (_) {}
  log({ type: 'preview_done', id, offerRef, board });
  return;
}

async function doSubmit(id, doc) {
  const offer = await resolveOffer(doc);
  if (!offer) {
    await api.updateTask(id, { status: 'failed', result: 'Offre introuvable à la soumission.', needs: [], questions: [] });
    return;
  }
  const offerRef = String(offer.ref || offer.id || '');
  const prev = doc.preview || {};

  // ---- LinkedIn: dedicated EasyApply bot (apply-driver reports auto:false
  // there on purpose — ban risk). Dispatched here, before the generic gate,
  // because the EasyApply modal has no "review page" to walk to. ----
  if (prev.route === 'linkedin-bot' || driver.detectBoard(offer) === 'linkedin') {
    if (doc.action !== 'auto_apply' && doc.action !== 'autopostule' && doc.action !== 'auto-postule') {
      await api.updateTask(id, { status: 'needs_info', result: 'LinkedIn : postule via EasyApply à la main puis dis « c\'est postulé ».' });
      return;
    }
    const { profile } = await driver.profileCheck();
    let liCv = path.join(driver.runDir(id), 'cv.pdf');
    if (!fs.existsSync(liCv)) {
      try { const { cvId } = await driver.docsCheck(offerRef); if (cvId) fs.writeFileSync(liCv, await api.docPdf(cvId)); else liCv = ''; }
      catch (_) { liCv = ''; }
    }
    if (!liCv) {
      await api.updateTask(id, { status: 'failed', result: 'CV absent — impossible de postuler sur LinkedIn.', needs: [], questions: [] });
      return;
    }
    await api.updateTask(id, { status: 'in_progress', submittedAt: new Date().toISOString(), loginWatch: false });
    killBotBrowsers();
    const lr = await withTimeout(
      require('./linkedin-bot.js').applyToLinkedInJob(offer, profile, liCv),
      30 * 60 * 1000, 'linkedin-submit',
    ).catch((e) => ({ submitted: false, error: String((e && e.message) || e).slice(0, 160) }));
    if (lr && lr.submitted) {
      const at = new Date().toISOString();
      const receipt = { board: 'linkedin', at, confirmation: lr.reason || lr.confirmation || 'EasyApply sent', loginMethod: 'session-injection', dialogMethod: 'easy-apply', screenshot: lr.screenshot || '' };
      await api.updateOffer(offer.id, { status: 'applied', appliedAt: at, appliedBoard: 'linkedin', applyReceipt: receipt.confirmation });
      await api.updateTask(id, { status: 'done', result: `Candidature envoyée chez « ${offer.title || offerRef} » (linkedin).`, receipt, needs: [], questions: [] });
      try { await api.sendChat(`✅ Candidature LinkedIn envoyée : « ${offer.title || offerRef} ».`, 'agent'); } catch (_) {}
      try { await require('./push.js').notify({ title: 'Candidature envoyée', body: String(offer.title || offerRef).slice(0, 140), tag: 'apply_done' }); } catch (_) {}
      log({ type: 'linkedin_submit_done', id, offerRef });
      return;
    }
    const reason = (lr && (lr.reason || lr.error)) || 'easy_apply_failed';
    await api.updateTask(id, { status: 'failed', result: 'LinkedIn EasyApply non abouti : ' + reason + '. Rien n\'a été envoyé.', needs: [], questions: [] });
    try { await api.sendChat(`❌ « ${offer.title || offerRef} » : EasyApply non abouti (${reason}). Rien n'a été envoyé — postule à la main si besoin.`, 'agent'); } catch (_) {}
    try { await require('./push.js').notify({ title: 'Candidature LinkedIn échouée', body: String(offer.title || offerRef).slice(0, 140), tag: 'apply_failed' }); } catch (_) {}
    log({ type: 'linkedin_submit_failed', id, offerRef, reason: String(reason).slice(0, 120) });
    return;
  }

  // ---- HARD GATE: no action, not even auto_apply, may bypass this. ----
  const gate = submitGate(null, prev);
  if (!gate.ok) {
    if (prev.manual) {
      await api.updateTask(id, { status: 'needs_info', result: 'Board manuel : postule via le lien puis dis « c\'est postulé ».' });
      return;
    }
    const friendly = 'Soumission bloquée (soumission refusée) : ' + gate.reasons.join(', ') + '. Rien n\'a été envoyé.';
    await api.updateTask(id, { status: 'failed', result: friendly, needs: [], questions: [] });
    try { await api.sendChat(`❌ « ${offer.title || offerRef} » : ${friendly}\nMotif probable : mur de compte ou mise en page inconnue. Postule à la main via ${offer.link} puis dis « c'est postulé ».`, 'agent'); } catch (_) {}
    try { await require('./push.js').notify({ title: 'Candidature bloquée (rien envoyé)', body: String(offer.title || offerRef).slice(0, 140), tag: 'apply_blocked' }); } catch (_) {}
    log({ type: 'submit_blocked_gate', id, offerRef, reasons: gate.reasons });
    return;
  }
  const { profile } = await driver.profileCheck();
  let cvPath = path.join(driver.runDir(id), 'cv.pdf');
  if (!fs.existsSync(cvPath)) {
    try {
      const { cvId } = await driver.docsCheck(offerRef);
      if (cvId) { fs.writeFileSync(cvPath, await api.docPdf(cvId)); } else cvPath = '';
    } catch (_) { cvPath = ''; }
  }
  let lettrePath = path.join(driver.runDir(id), 'lettre.pdf');
  if (!fs.existsSync(lettrePath)) {
    try {
      const { lettreId } = await driver.docsCheck(offerRef);
      if (lettreId) { fs.writeFileSync(lettrePath, await api.docPdf(lettreId)); } else lettrePath = '';
    } catch (_) { lettrePath = ''; }
  }
  const files = { cv: cvPath, lettre: lettrePath };
  const flowOpts = { headed: true, watchMs: doc.loginWatch ? 300000 : 0, email: profile.email, taskId: id, awaitCodeMs: 720000, standbyMs: 720000 };
  killBotBrowsers();
  await api.updateTask(id, { status: 'in_progress', submittedAt: new Date().toISOString(), loginWatch: false });
  let r;
  try {
    r = await withTimeout(driver.submit(id, offer, profile, files, flowOpts), 60 * 60 * 1000, 'submit');
  } catch (e) {
    killBotBrowsers();
    r = { error: 'run_timeout_60min', board: driver.detectBoard(offer) };
  }
  if (/open_failed/.test(String((r && r.error) || ''))) {
    killBotBrowsers();
    await sleepMs(5000);
    log({ type: 'submit_retry_open', id, offerRef });
    try {
      r = await withTimeout(driver.submit(id, offer, profile, files, flowOpts), 60 * 60 * 1000, 'submit-retry');
    } catch (e) {
      killBotBrowsers();
      r = { error: 'run_timeout_60min', board: driver.detectBoard(offer) };
    }
  }
  if (r.authWall) {
    await api.updateTask(id, { status: 'needs_info', offerRef, needs: ['connexion perdue pendant la soumission', 'dis « login » ou dicte le code reçu, puis « relance »'] });
    try { await api.sendChat(`🔐 « ${offer.title || offerRef} » : connexion perdue pendant la soumission. Dis « login » ou dicte le code, puis « relance ».`, 'agent'); } catch (_) {}
    log({ type: 'submit_authwall', id, offerRef, error: String(r.error || '').slice(0, 60) });
    return;
  }
  if (r.error === 'jail_violation') {
    await api.updateTask(id, { status: 'failed', result: 'Bloqué : la page a quitté le domaine autorisé de l\'offre. Rien n\'a été envoyé.', needs: [], questions: [] });
    try { await api.sendChat(`⛔ « ${offer.title || offerRef} » : la page a quitté le domaine autorisé, soumission refusée.`, 'agent'); } catch (_) {}
    log({ type: 'submit_jail', id, offerRef });
    return;
  }
  if (r.error === 'unanswered_blocked') {
    const qs = (r.unanswered || []).slice(0, 6);
    const lines = qs.map((q, i) => `Q${i + 1} [${q.type}] ${q.field}${q.options && q.options.length ? ` (choix : ${q.options.slice(0, 8).join(' / ')})` : ''}`);
    await api.updateTask(id, { status: 'needs_info', offerRef, needs: ['questions formulaire obligatoires :', ...lines, 'réponds en chat puis dis « relance »'], questions: qs, loginWatch: false });
    try { await api.sendChat(`❓ « ${offer.title || offerRef} » : champs obligatoires non renseignés, rien n'a été envoyé :\n- ` + lines.join('\n- ') + `\nRéponds en chat puis « relance ».`, 'agent'); } catch (_) {}
    try { await require('./push.js').notify({ title: 'Questions avant de postuler', body: String(offer.title || offerRef).slice(0, 120), tag: 'apply_questions' }); } catch (_) {}
    log({ type: 'submit_unanswered', id, offerRef, n: qs.length });
    return;
  }
  if (r.error === 'no_review_reached') {
    await api.updateTask(id, { status: 'failed', result: 'Page de révision jamais atteinte (formulaire non rendu ou dialogue de choix). Rien n\'a été envoyé.', needs: [], questions: [] });
    try { await api.sendChat(`❌ « ${offer.title || offerRef} » : je n'ai pas atteint la page de soumission, rien n'a été envoyé.`, 'agent'); } catch (_) {}
    log({ type: 'submit_no_review', id, offerRef });
    return;
  }
  if (r.error === 'form_invalid') {
    const errs = (r.formErrs || []).slice(0, 4).join(' | ').slice(0, 200);
    await api.updateTask(id, { status: 'failed', result: 'Formulaire invalide, soumission refusée : ' + errs, needs: [], questions: [] });
    try { await api.sendChat(`❌ Candidature « ${offer.title || offerRef} » : formulaire invalide (${errs}). Corrigez puis « relance ».`, 'agent'); } catch (_) {}
    log({ type: 'submit_form_invalid', id, offerRef, errs: errs.slice(0, 140) });
    return;
  }
  if (r.error === 'submit_no_confirmation') {
    const errs = (r.formErrs || []).slice(0, 4).join(' | ').slice(0, 200);
    await api.updateTask(id, { status: 'failed', result: 'Soumission sans confirmation' + (errs ? ' : ' + errs : ' (page inchangée). Dis-moi « relance » pour réessayer.'), needs: [], questions: [] });
    try { await api.sendChat(`❌ Candidature « ${offer.title || offerRef} » : pas de confirmation après clic${errs ? ' — ' + errs : ''}. Dis-moi « relance » pour réessayer.`, 'agent'); } catch (_) {}
    log({ type: 'submit_no_confirmation', id, offerRef, errs: errs.slice(0, 140) });
    return;
  }
  if (r.error || !r.submitted) {
    const reason = r.error || (r.confirmation ? 'clic sans confirmation : ' + r.confirmation : 'échec de soumission');
    await api.updateTask(id, { status: 'failed', result: 'Soumission impossible : ' + reason, needs: [], questions: [] });
    try { await api.sendChat(`❌ Candidature « ${offer.title || offerRef} » : ${reason}.\nDis-moi « relance » pour réessayer, ou postule à la main (${offer.link}).`, 'agent'); } catch (_) {}
    try { await require('./push.js').notify({ title: 'Candidature échouée', body: String(offer.title || offerRef).slice(0, 140), tag: 'apply_failed' }); } catch (_) {}
    log({ type: 'submit_failed', id, offerRef, error: reason.slice(0, 140) });
    return;
  }
  const receipt = { board: r.board, at: new Date().toISOString(), confirmation: r.confirmation, appId: r.appId || '', loginMethod: r.loginMethod || '', dialogMethod: r.dialogMethod || '', steps: (r.steps || []).length, screenshot: r.screenshot };
  await api.updateOffer(offer.id, { status: 'applied', appliedAt: receipt.at, appliedBoard: r.board, applyReceipt: (r.confirmation || '') + (r.appId ? ' [#' + r.appId + ']' : '') });
  await api.updateTask(id, { status: 'done', result: `Candidature envoyée chez « ${offer.title || offerRef} » (${r.board}).`, receipt, needs: [], questions: [] });
  try { await api.sendChat(`✅ Candidature envoyée : « ${offer.title || offerRef} » (${r.board}). ${r.confirmation}${r.appId ? ' Réf: ' + r.appId : ''}`, 'agent'); } catch (_) {}
  try { await require('./push.js').notify({ title: 'Candidature envoyée', body: String(offer.title || offerRef).slice(0, 140), tag: 'apply_done' }); } catch (_) {}
  log({ type: 'submit_done', id, offerRef, board: r.board });
}

async function pollOnce() {
  // Single lane: overlapping polls stampeded Playwright (open_failed everywhere).
  if (pollOnce.running) return;
  pollOnce.running = true;
  try {
  let queued = [], confirmed = [];
  try {
    queued = await api.listTasks({ status: 'queued', limit: 25 });
    confirmed = await api.listTasks({ status: 'confirmed', limit: 25 });
  } catch (e) { log({ type: 'poll_error', error: String((e && e.message) || e).slice(0, 120) }); pollOnce.running = false; return; }
  // Reclaim orphaned runs (a dead run must never park a task forever).
  try {
    const stuck = await api.listTasks({ status: 'in_progress', limit: 25 });
    for (const t of stuck) {
      if (t.kind !== 'apply') continue;
      const age = t.updated_at ? Date.now() - new Date(t.updated_at).getTime() : 0;
      if (age > 45 * 60 * 1000 && !busy.has(t.id)) {
        log({ type: 'stuck_reclaim', id: t.id });
        try { await api.updateTask(t.id, { status: 'queued', resumedAt: new Date().toISOString(), reclaimNote: 'orphaned run requeued' }); } catch (_) {}
      }
    }
  } catch (_) {}
  for (const t of [...queued, ...confirmed]) {
    if (t.kind !== 'apply') continue;
    if (busy.has(t.id)) continue;
    let age = 0;
    if (t.created_at) age = Date.now() - new Date(t.created_at).getTime();
    if (t.status === 'queued' && age > 0 && age < 10000) continue;
    log({ type: 'poll_claim', id: t.id, status: t.status });
    await runTask(t.id, t);
  }
  } catch (e) { log({ type: 'poll_fatal', error: String((e && e.message) || e).slice(0, 120) }); }
  pollOnce.running = false;
}

process.on('unhandledRejection', (e) => log({ type: 'worker_error', error: String((e && e.message) || e) }));
process.on('uncaughtException', (e) => log({ type: 'worker_error', error: String((e && e.message) || e) }));

(async () => {
  log({ type: 'worker_start', runId: Date.now() });
  console.log('apply-worker-docker running API=' + api.API);
  await pollOnce();
  setInterval(() => { pollOnce().catch((e) => log({ type: 'poll_error', error: String((e && e.message) || e) })); }, 10000);
})().catch((e) => { console.error('APPLY WORKER FATAL', e); process.exit(1); });
