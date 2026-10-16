'use strict';
// diagnose-bypass.js — the 0-application sweep required before enabling real
// submissions. It calls driver.preview() ONLY: fill + screenshot + field
// inventory, never driver.submit(). Nothing is sent to any employer.
//
// Goal: prove, per board, that the documented bypass strategy works
// (resolve employer ATS host -> session injection / guest flow / shadow DOM),
// and show exactly which mandatory fields we cannot fill without asking.
//
// Usage:
//   node diagnose-bypass.js                 one offer per auto board
//   node diagnose-bypass.js --board workday focus one board family
//   node diagnose-bypass.js --offer <ref>   a specific offer
//   node diagnose-bypass.js --per-host 2    2 offers per board (default 1)
//   node diagnose-bypass.js --headless      no visible browser (default headed)
//   node diagnose-bypass.js --out report.json
//
// Safety: preview() is the only driver entry point called here. This file
// deliberately does not require linkedin-bot.js, which is the only other way
// to actually submit.
const fs = require('fs');
const path = require('path');
const api = require('./api_client.js');
const driver = require('./apply-driver.js');

const args = process.argv.slice(2);
const argVal = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const onlyBoard = argVal('--board');
const onlyOffer = argVal('--offer');
const perHost = Math.max(1, Number(argVal('--per-host')) || 1);
const headed = !args.includes('--headless');
const outFile = argVal('--out') || path.join(__dirname, '..', '..', '.apply-runs', 'bypass-report.json');

const OUT_DIR = path.join(__dirname, '..', '..', '.apply-runs');

function hostOf(u) { try { return new URL(u).hostname; } catch (_) { return '?'; } }

// Preview outcomes are bucketed so a sweep can be read at a glance:
//   OK          reached the review page, fields filled, CV attached
//   QUESTIONS   gate #1 blocked it: a mandatory field has no approved answer
//   NO_CV       gate #2 blocked it: the CV could not be attached to a real slot
//   FORM_ERRORS validators still complaining on the review page
//   AUTH_WALL   needs a one-time human login (session-doctor.js reports which)
//   CAPTCHA     never submit through a challenge (safety rule 3)
//   JAIL        the page left the offer's allowed host set
//   UNREACHED   the form never rendered (unknown layout / dialog)
//   MANUAL      board is not in AUTO_BOARDS
function classify(pv) {
  if (pv.error === 'jail_violation') return 'JAIL';
  if (/captcha|recaptcha|unusual traffic|challenge/i.test(String(pv.error || '') + ' ' + (pv.formErrs || []).join(' '))) return 'CAPTCHA';
  if (pv.authWall) return 'AUTH_WALL';
  if (!pv.auto) return 'MANUAL';
  if (pv.error) return 'UNREACHED';
  if (pv.unanswered && pv.unanswered.length) return 'QUESTIONS';
  if (!pv.cvAttached) return 'NO_CV';
  if (pv.formErrs && pv.formErrs.length) return 'FORM_ERRORS';
  if (!pv.atReview) return 'UNREACHED';
  return 'OK';
}

async function main() {
  console.log('=== Bypass sweep (PREVIEW ONLY — no application is ever submitted) ===\n');

  let offers = [];
  try { offers = await api.listOffers({ limit: 1000 }); }
  catch (e) { console.error('❌ Cannot reach the API:', e.message, '\n   Is `docker compose up -d` running?'); process.exit(1); }

  const usable = offers.filter((o) => o && o.link && (o.status === 'new' || !o.status));
  console.log(`Offers: ${offers.length} total, ${usable.length} with a link and not yet applied.\n`);

  // Group by board, one host per strategy family so we learn the family, not
  // the quirks of a single tenant.
  const byBoard = new Map();
  for (const o of usable) {
    const board = driver.detectBoard(o);
    if (!board) continue;
    if (onlyBoard && board !== onlyBoard) continue;
    if (!byBoard.has(board)) byBoard.set(board, []);
    byBoard.get(board).push(o);
  }
  if (onlyOffer) {
    const one = usable.filter((o) => (o.ref || o.id) === onlyOffer);
    if (!one.length) { console.error(`❌ Offer not found: ${onlyOffer}`); process.exit(1); }
    byBoard.clear();
    byBoard.set(driver.detectBoard(one[0]) || 'unknown', one);
  }

  if (!byBoard.size) {
    console.log('⚠️  No offer matches a known board. Nothing to sweep.');
    console.log('   Known boards:', [...driver.AUTO_BOARDS].join(', '));
    return;
  }

  const { profile, missing: pMissing } = await driver.profileCheck();
  if (pMissing && pMissing.length) console.log('⚠️  Profile incomplete (will need_info on every run):', pMissing.join(', '));
  console.log('Boards to sweep:', [...byBoard.keys()].join(', '), '\n');

  const report = { startedAt: new Date().toISOString(), headed, previewOnly: true, results: [] };
  const dir = path.join(OUT_DIR, 'bypass-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });

  for (const [board, list] of byBoard) {
    // One offer per distinct host, up to --per-host.
    const seen = new Set();
    const picked = [];
    for (const o of list) { const h = hostOf(o.link); if (seen.has(h)) continue; seen.add(h); picked.push(o); if (picked.length >= perHost) break; }
    for (const offer of picked) {
      const ref = String(offer.ref || offer.id || '');
      const label = `${board} · ${(offer.title || '').slice(0, 44)}`;
      process.stdout.write(`→ ${label} … `);
      let pv = {};
      const t0 = Date.now();
      try {
        pv = await driver.preview('diag-' + ref.slice(-12), offer, profile, { cv: '', lettre: '' }, { headed, watchMs: 0, email: profile.email, awaitCodeMs: 0, standbyMs: 0 });
      } catch (e) {
        pv = { error: 'preview_threw: ' + String((e && e.message) || e).slice(0, 160) };
      }
      const verdict = classify(pv);
      console.log(`${verdict} (${Math.round((Date.now() - t0) / 1000)}s)`);
      console.log(`    host      : ${hostOf(offer.link)}  →  ${pv.board || board}`);
      console.log(`    url       : ${String(pv.url || offer.link).slice(0, 110)}`);
      console.log(`    login     : ${pv.loginMethod || '-'} · dialog: ${pv.dialogMethod || '-'} · steps: ${(pv.steps || []).length}`);
      console.log(`    filled    : ${(pv.filled || []).length} · atReview: ${pv.atReview ? 'yes' : 'no'} · applyBtn: ${pv.hasApply ? 'yes' : 'no'}`);
      console.log(`    CV        : ${pv.cvAttached ? 'attached' : 'NOT attached'}` + ((pv.attachNotes || []).length ? ` — ${pv.attachNotes.map((n) => n.kind + ':' + n.reason + (n.into ? '@' + n.into : '')).join(', ')}` : ''));
      if ((pv.unanswered || []).length) {
        console.log(`    questions : ${pv.unanswered.length}`);
        for (const q of pv.unanswered.slice(0, 5)) {
          console.log(`      - [${q.type}] ${q.label || q.field}${q.options && q.options.length ? ' → ' + q.options.slice(0, 6).join(' / ') : ''}`);
        }
      }
      if ((pv.formErrs || []).length) console.log(`    formErrs  : ${pv.formErrs.slice(0, 4).join(' | ')}`);
      if (pv.error) console.log(`    error     : ${String(pv.error).slice(0, 140)}`);
      if (pv.screenshot) console.log(`    shot      : ${pv.screenshot}`);

      report.results.push({
        board, verdict, ref, id: offer.id, title: offer.title, url: offer.link, host: hostOf(offer.link),
        resolvedBoard: pv.board || board, loginMethod: pv.loginMethod || '', dialogMethod: pv.dialogMethod || '',
        atReview: !!pv.atReview, hasApply: !!pv.hasApply, filled: (pv.filled || []).length,
        cvAttached: !!pv.cvAttached, lettreAttached: !!pv.lettreAttached,
        attachNotes: pv.attachNotes || [],
        unanswered: (pv.unanswered || []).map((q) => ({ field: q.field, label: q.label, type: q.type, required: q.required, options: (q.options || []).slice(0, 12) })),
        formErrs: pv.formErrs || [], error: pv.error || '', screenshot: pv.screenshot || '',
        fieldCount: (pv.fieldScan || []).length,
      });
    }
  }

  try { fs.writeFileSync(outFile, JSON.stringify(report, null, 1)); } catch (e) { console.error('\nCould not write report:', e.message); }

  const tally = {};
  for (const r of report.results) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
  console.log('\n=== Summary (' + report.results.length + ' boards swept) ===');
  for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(11)} ${v}`);
  console.log('\nReport:', outFile);
  console.log('Reminder: 0 submissions. Enable real applications only after the boards you');
  console.log('target read OK, or after the user logs in once for AUTH_WALL boards.');
  const blocked = report.results.filter((r) => ['CAPTCHA', 'JAIL', 'NO_CV'].includes(r.verdict));
  if (blocked.length) console.log('\n⛔ Safety: ' + blocked.length + ' run(s) hit a hard stop (captcha/jail/CV). Those boards must stay in manual mode.');
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
