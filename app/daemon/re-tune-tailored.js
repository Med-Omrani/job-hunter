'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const api = require('./api_client.js');

const GEN = path.join(__dirname, '..', '..', 'tailored', 'gen_tailored.py');

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

(async () => {
  const offers = await api.listOffers({ limit: 5000 });
  const ready = offers.filter((o) => o.tailorStatus === 'ready');
  console.log('ready offers:', ready.length);
  let ok = 0, fail = 0;
  for (const offer of ready) {
    const ref = String(offer.ref || offer.id || '');
    const label = String(offer.title || '').replace(/ H\/F.*$/i, '').trim() || 'le poste';
    const descParts = [
      offer.title, offer.agentNote,
      Array.isArray(offer.keywords) ? offer.keywords.join(', ') : '',
      Array.isArray(offer.matches) ? offer.matches.join(', ') : '',
      offer.description,
    ].filter(Boolean);
    const payload = {
      offerRef: ref,
      title: offer.title || 'le poste',
      company: offer.company || '',
      location: offer.location || '',
      contract: offer.contract || '',
      link: offer.link || '',
      description: String(descParts.join('. ')).slice(0, 4000),
    };
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobcenter-retune-'));
    try {
      await runGen(payload, outdir);
      const cv = fs.readFileSync(path.join(outdir, 'cv.pdf')).toString('base64');
      const letr = fs.readFileSync(path.join(outdir, 'lettre.pdf')).toString('base64');
      await api.createDoc({ id: 'cv-' + ref, offerRef: ref, offreTitle: payload.title, name: 'CV — ' + label + ' (' + ref + ')', type: 'cv', pdfBase64: cv });
      await api.createDoc({ id: 'lettre-' + ref, offerRef: ref, offreTitle: payload.title, name: 'Lettre — ' + label + ' (' + ref + ')', type: 'letter', pdfBase64: letr });
      await api.updateOffer(offer.id, { tailorStatus: 'ready', tailoredOfferRef: ref, updatedAt: new Date().toISOString() });
      console.log('OK ', ref, '|', label);
      ok++;
    } catch (e) {
      console.log('FAIL', ref, '|', label, '|', String((e && e.message) || e).slice(0, 200));
      fail++;
    } finally {
      try { fs.rmSync(outdir, { recursive: true, force: true }); } catch (_) {}
    }
  }
  console.log('done ok=' + ok + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL', (e && e.message) || e); process.exit(2); });