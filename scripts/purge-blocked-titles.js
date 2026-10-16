'use strict';
// One-shot purge: drop every offer whose title is a business / marketing /
// sales role, so the feed matches the user's 2026-10-07 instruction
// ("remove all business and marketing offers") and the engine BLOCKLIST.
//
//   HARD words -> always deleted (business, marketing, sales family)
//   SOFT words -> deleted only when the title carries no engineering role
//                 (so "Applied AI Software Engineer, GTM Growth Engineering"
//                 survives while "AEO/SEO Content Specialist" does not)
//
// Reads titles straight from postgres (UTF-8, no PowerShell redirection),
// writes _delete_blocked.sql. --dry-run only prints counts.
const fs = require('fs');
const { execFileSync } = require('child_process');

const HARD = ['business', 'marketing', 'sales', 'selling', 'vente', 'ventes',
  'commercial', 'commerciale', 'commerciaux', 'account executive',
  'business development', 'account manager', 'b2b', 'key account',
  'growth manager', 'sales director', 'head of sales', 'team leader commercial',
  'attache commercial', 'charge de clientele'];

const SOFT = ['growth', 'seo', 'sem', 'brand', 'influencer', 'influenceur',
  'community manager', 'traffic manager', 'crm', 'campaign', 'content manager',
  'social media'];

const ENG = ['engineer', 'ingenieur', 'developpeur', 'developer', 'software',
  'embedded', 'embarque', 'technicien', 'architect', 'scientist', 'data',
  'java', 'python', 'devops', 'electronique', 'network', 'systeme', 'robotique',
  'automation', 'maintenanc', 'qualite', 'programmateur'];

function fold(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function rx(words) {
  return new RegExp('(^|[^a-z0-9])(' + words.map((w) =>
    fold(w).split(/\s+/).join('\\s+')).join('|') + ')([^a-z0-9]|$)');
}
const HARD_RE = rx(HARD);
const SOFT_RE = rx(SOFT);
const ENG_RE = rx(ENG);

const SQL = "select id || chr(9) || replace(replace(coalesce(data->>'title',''), chr(9), ' '), chr(10), ' ') from offers";
const out = execFileSync('docker',
  ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'jobcenter', '-d', 'jobcenter', '-A', '-t', '-c', SQL],
  { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const ids = [];
const softSamples = [];
let hard = 0, soft = 0, rows = 0;
for (const line of out.split('\n')) {
  if (!line) continue;
  const i = line.indexOf('\t');
  if (i < 0) continue;
  rows++;
  const id = line.slice(0, i);
  const title = line.slice(i + 1);
  const f = fold(title);
  const isHard = HARD_RE.test(f);
  const isSoft = !isHard && SOFT_RE.test(f);
  const eng = ENG_RE.test(f);
  if (isHard || (isSoft && !eng)) {
    ids.push(id);
    if (isHard) hard++; else { soft++; if (softSamples.length < 30) softSamples.push(title); }
  }
}
if (!process.argv.includes('--dry-run') && ids.length) {
  const sql = 'DELETE FROM offers WHERE id IN (\n' +
    ids.map((id) => "  '" + id.replace(/'/g, "''") + "'").join(',\n') + '\n);\n';
  fs.writeFileSync('_delete_blocked.sql', sql, 'utf8');
}
console.log('rows:', rows, 'hard:', hard, 'soft:', soft, 'total:', ids.length);
if (softSamples.length) console.log('soft samples:\n - ' + softSamples.join('\n - '));
