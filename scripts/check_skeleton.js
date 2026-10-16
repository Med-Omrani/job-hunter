const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(__dirname, 'skeleton_manifest.json');

const FILES = {
  cv: path.join(ROOT, 'CV', 'cv.tex'),
  cv_pro: path.join(ROOT, 'CV', 'cv_pro.tex'),
  lettre: path.join(ROOT, 'Cover_Letter', 'lettre_alten.tex'),
  lettre_en: path.join(ROOT, 'Cover_Letter', 'letter_en.tex'),
  lettre_de: path.join(ROOT, 'Cover_Letter', 'letter_de.tex'),
};

const MARK_RE = /%%%TXR-[A-Z0-9]+%%%[\s\S]*?%%%TXR-[A-Z0-9]+-END%%%/g;

function frozenFingerprint(file) {
  const src = fs.readFileSync(file, 'utf8');
  const frozen = src.replace(MARK_RE, '<MARK>').replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(frozen).digest('hex').slice(0, 16);
}

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (_) { return {}; }
}

if (process.argv.includes('--init')) {
  const manifest = {};
  for (const [k, f] of Object.entries(FILES)) manifest[k] = frozenFingerprint(f);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log('Manifest written:', manifest);
  process.exit(0);
}

const expected = loadManifest();
let ok = true;
for (const [k, f] of Object.entries(FILES)) {
  const got = frozenFingerprint(f);
  const want = expected[k];
  const match = want && want === got;
  console.log(`${k}: ${got} ${match ? 'OK' : `MISMATCH (expected ${want})`}`);
  ok = ok && match;
}
if (!ok) { console.error('SKELETON VIOLATION: frozen regions changed. Revert or update manifest.'); process.exit(1); }
console.log('check_skeleton: PASS');