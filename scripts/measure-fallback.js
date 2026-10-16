'use strict';
// Measures app/daemon/fallback-classifier.js against the LLM verdicts the band
// already produced, so the local fallback's precision is a measured number rather
// than an assumption.
//
// Usage: node scripts/measure-fallback.js <groundtruth.jsonl> [--samples N]
const fs = require('fs');
const readline = require('readline');
const { classifyLocal } = require('../app/daemon/fallback-classifier.js');

const file = process.argv[2];
const sampleArg = process.argv.indexOf('--samples');
const SAMPLES = sampleArg > -1 ? Number(process.argv[sampleArg + 1]) : 12;
if (!file) {
  console.error('usage: node scripts/measure-fallback.js <groundtruth.jsonl> [--samples N]');
  process.exit(2);
}

// ---- ground-truth extraction ------------------------------------------------
// The exported row carries the LLM's own decision. Accept either shape so the
// harness survives a schema change: bandVerdict.match is the decision the model
// made, and the row-level `band` is where it landed afterwards.
function truthOf(row) {
  const v = row.verdict;
  if (v && typeof v === 'object' && typeof v.match === 'boolean') {
    return { label: v.match ? 'promote' : 'reject', model: v.model || null, reason: v.reason || '' };
  }
  if (v === 'promoted' || v === 'promote') return { label: 'promote', model: null, reason: '' };
  if (v === 'rejected' || v === 'reject') return { label: 'reject', model: null, reason: '' };
  if (row.band === 'promoted') return { label: 'promote', model: null, reason: '' };
  if (row.band === 'rejected') return { label: 'reject', model: null, reason: '' };
  return null;
}

function rate(n, d) { return d ? (100 * n / d).toFixed(1) + '%' : '-'; }

(async () => {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const confusion = { promote: { promote: 0, reject: 0, unsure: 0 }, reject: { promote: 0, reject: 0, unsure: 0 } };
  const byModel = new Map();
  const falsePromote = [];   // local promote, LLM reject  <- the dangerous cell
  const missPromote = [];    // local reject, LLM promote  <- lost good offers
  let skipped = 0, unreadable = 0;

  for await (const line of rl) {
    if (!line || !line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { unreadable++; continue; }
    const t = truthOf(row);
    if (!t) { skipped++; continue; }

    const out = classifyLocal({ title: row.title, description: row.desc });
    confusion[t.label][out.verdict]++;
    byModel.set(t.model || 'unknown', (byModel.get(t.model || 'unknown') || 0) + 1);

    if (out.verdict === 'promote' && t.label === 'reject') {
      falsePromote.push({ title: row.title, loc: row.location || row.country || '', local: out, llm: t.reason });
    } else if (out.verdict === 'reject' && t.label === 'promote') {
      missPromote.push({ title: row.title, loc: row.location || row.country || '', local: out, llm: t.reason });
    }
  }

  // ---- report --------------------------------------------------------------
  const tp = confusion.promote.promote, fp = confusion.reject.promote;
  const tn = confusion.reject.reject, fn = confusion.promote.reject;
  const localPromoted = tp + fp + confusion.promote.unsure * 0;
  const decided = tp + fp + tn + fn + confusion.promote.unsure + confusion.reject.unsure;

  console.log('ground-truth rows: ' + (decided + skipped) + '  (no decision: ' + skipped + ', unreadable: ' + unreadable + ')');
  console.log('ground truth mix: promote ' + (tp + fn) + '  reject ' + (fp + tn));
  console.log('models: ' + [...byModel.entries()].map(([m, n]) => m + '=' + n).join(', '));
  console.log('');
  console.log('confusion (rows = LLM truth, cols = local-v1)');
  console.log('                 promote   reject   unsure');
  console.log('  LLM promote  ' + String(confusion.promote.promote).padStart(8) + String(confusion.promote.reject).padStart(8) + String(confusion.promote.unsure).padStart(8));
  console.log('  LLM reject   ' + String(confusion.reject.promote).padStart(8) + String(confusion.reject.reject).padStart(8) + String(confusion.reject.unsure).padStart(8));
  console.log('');
  console.log('local promote precision : ' + rate(tp, tp + fp) + '  (' + tp + '/' + (tp + fp) + ')');
  console.log('local reject  precision : ' + rate(tn, tn + fn) + '  (' + tn + '/' + (tn + fn) + ')');
  console.log('false-promote rate (of all LLM rejects): ' + rate(fp, fp + tn + confusion.reject.unsure));
  console.log('abstention (unsure)    : ' + (confusion.promote.unsure + confusion.reject.unsure) + ' / ' + decided + ' = ' + rate(confusion.promote.unsure + confusion.reject.unsure, decided));
  console.log('');

  falsePromote.sort((a, b) => b.local.tokens.length - a.local.tokens.length);
  console.log('=== FALSE PROMOTES (local says promote, LLM says reject) top ' + SAMPLES + ' ===');
  for (const f of falsePromote.slice(0, SAMPLES)) {
    console.log('- ' + f.title + '  [' + f.loc + ']');
    console.log('    local: ' + f.local.reasons.join(' | '));
    console.log('    llm  : ' + f.llm);
  }
  console.log('');
  console.log('=== MISSED PROMOTES (local says reject, LLM says promote) top ' + SAMPLES + ' ===');
  for (const f of missPromote.slice(0, SAMPLES)) {
    console.log('- ' + f.title + '  [' + f.loc + ']');
    console.log('    local: ' + f.local.reasons.join(' | '));
    console.log('    llm  : ' + f.llm);
  }
  if (missPromote.length === 0) console.log('(none)');
  void localPromoted;
})().catch((e) => { console.error(e); process.exit(1); });
