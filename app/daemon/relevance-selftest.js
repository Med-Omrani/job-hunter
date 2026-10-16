'use strict';
// Control set for the classifier.
//
// Every case here is drawn from a posting the live fleet actually produced, not
// invented. Three of them (the Valeo roles) were REJECTED by the keyword engine
// despite being genuine local engineering jobs -- they are the misses this whole
// system exists to recover. The rest are the noise the blocklist and geography
// rules must keep out.
//
// Re-run this after ANY prompt change (RELEVANCE_SELFTEST=1) to detect drift:
// the point is that the same 10 postings must keep producing the same verdicts.
// A flipped answer is not automatically a bug -- but it must be a decision, not
// a surprise.
const { classifyBatch } = require('./relevance.js');

// expect: true = should be promoted, false = should stay out.
const CONTROL = [
  {
    id: 'valeo-superviseur', expect: true,
    title: 'Superviseur de Production', company: 'Valeo', location: 'Tunisie',
    description: "Superviseur de production pour site industriel en Tunisie. Encadrement d'une equipe d'operateurs, pilotage des lignes de production, management et amelioration continue. Formation ingenieur ou BTS technique.",
  },
  {
    id: 'valeo-technicien-maint', expect: true,
    title: 'Technicien Maintenance (H/F)', company: 'Valeo', location: 'Tunis, Tunisie',
    description: 'Technicien de maintenance industrielle sur site de production. Maintenance curative et preventive des machines, diagnostic de pannes, hydraulique et pneumatique. Profil BTS maintenance.',
  },
  {
    id: 'valeo-qualite-uap', expect: true,
    title: 'Technicien qualite UAP', company: 'Valeo', location: 'Tunisie',
    description: "Technicien qualite Unitaires de Production. Application et animation de l'autocontrole, analyse des non conformites, plans qualite. Profil BTS ou diplome en genie industriel.",
  },
  {
    id: 'st-embedded', expect: true,
    title: 'Firmware Engineer (Embedded)', company: 'STMicroelectronics', location: 'Tunis, Tunisie',
    description: 'Developpement de firmware embarque pour microcontroleurs STM32 en C. Mise au point avec debugger, travail sur RTOS, bus CAN. Profil: solide experience C et systemes embarques.',
  },
  {
    id: 'remote-python', expect: true,
    title: 'Backend Engineer (Python)', company: 'Toptal', location: 'Remote - Worldwide',
    description: 'Build and scale Python/FastAPI services with PostgreSQL. Work with a small team on a large codebase. Fully remote, contract or permanent.',
  },
  {
    id: 'tamus-civil', expect: false,
    title: 'Assistant Professor of Civil Engineering (Structural Engineering)', company: 'Texas A&M University',
    description: 'Tenure-track faculty position in structural engineering. Teach undergraduate and graduate courses, maintain an active research program, supervise PhD students. PhD required.',
  },
  {
    id: 'psu-adjunct', expect: false,
    title: 'Adjunct Lecturer', company: 'Penn State University',
    description: 'Teach one or more undergraduate courses in the undergraduate statistics program. Masters degree required. This is a part-time teaching appointment.',
  },
  {
    id: 'memorial-ma', expect: false,
    title: 'Medical Assistant - Neurology - FT - Days', company: 'Memorial Healthcare System',
    description: 'Provide clinical assistance to physician. Room to room patient care, vital signs, phlebotomy. Certification as Medical Assistant required. No engineering component.',
  },
  {
    id: 'acme-sales', expect: false,
    title: 'Enterprise Account Manager', company: 'Global Software Vendor',
    description: 'Own the enterprise territory, drive new logo revenue, run quarterly business reviews with CIOs, and partner with marketing on demand generation. 5+ years closing quota-carrying roles.',
  },
  {
    id: 'onsite-civil-uk', expect: false,
    title: 'Civil Structural Engineer (Site Delivery)', company: 'UK Regional Contractor',
    description: 'Site-based structural delivery role in Manchester. Requires chartered engineer status and 8 years of construction site experience. Right to work in the UK required; on-site 5 days per week.',
  },
];

async function main() {
  const t0 = Date.now();
  const out = await classifyBatch(CONTROL);
  if (!out.ok) {
    console.error('CONTROL RUN FAILED:', out.error, out.detail ? JSON.stringify(out.detail).slice(0, 300) : '');
    process.exitCode = 1;
    return;
  }
  console.log(`model=${out.model} attempts=${out.attempts} ms=${out.ms} wall=${Date.now() - t0}`);
  const byId = new Map(out.results.map((r) => [r.id, r]));
  let right = 0;
  for (const c of CONTROL) {
    const r = byId.get(c.id);
    const ok = !!r && r.match === c.expect;
    if (ok) right++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  expect=${String(c.expect).padEnd(5)} got=${String(r && r.match).padEnd(5)} score=${r && r.score}  ${c.id.padEnd(22)} ${r ? r.reason : '(no verdict)'}`,
    );
  }
  console.log(`\n${right}/${CONTROL.length} control cases correct`);
  if (right < CONTROL.length) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { CONTROL };