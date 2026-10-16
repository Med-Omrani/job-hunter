'use strict';
const { scoreOffer } = require('../app/daemon/engine.js');

const cases = [
  { t: 'Ingénieur Automatisme PLC H/F', d: 'Conception d instruments de supervision SCADA', ok: true, min: 2, why: 'automatisme titre + scada desc' },
  { t: 'Technicien Maintenance industrielle', d: 'Interventions sur lignes de production et automates', ok: true, min: 1, why: 'automatisme weak via maintenance/automate desc' },
  { t: 'Ingénieur systèmes embarqués', d: 'Développement firmware STM32 temps réel', ok: true, min: 2, why: 'embarque titre + firmware desc' },
  { t: 'Développeur Flutter / Mobile', d: 'Création d applications Android', ok: true, min: 2, why: 'logiciel' },
  { t: 'Ingénieur électronique de puissance', d: 'Convertisseurs et onduleurs pour le ferroviaire', ok: true, min: 1, why: 'electro' },
  { t: 'Administrateur réseaux et infrastructures', d: 'Firewall, VM, fibres', ok: true, min: 1, why: 'reseau' },
  { t: 'Commercial terrain', d: 'Prospection clientèle', ok: false, min: 0, why: 'commercial -> veto titre' },
  { t: 'Vendeur en magasin', d: 'Conseil client', ok: false, min: 0, why: 'vendeur -> veto' },
  { t: 'Responsable Marketing Digital', d: 'Campagnes', ok: false, min: 0, why: 'marketing -> veto' },
  { t: 'Ingénieur automatisme', d: 'Descriptif mission commerciale de l agence', ok: true, min: 1, why: 'automatisme ok malgré commercial en desc (titre-only veto)' },
  { t: 'Coordinateur logistique', d: 'Planification livraisons', ok: false, min: 0, why: 'sans raport' },
  { t: 'Data Engineer', d: 'Pipelines python cloud SQL', ok: true, min: 1, why: 'logiciel data titre' },
  { t: 'Chef de projet technique', d: 'gestion d équipe et livraisons', ok: false, min: 0, why: 'générique' },
  { t: 'Chef de projet automatisation', d: 'automates, lignes de production', ok: true, min: 1, why: 'automatisation dans le titre' },
  { t: 'Technicien télécoms fibre optique', d: 'Déploiement FTTH', ok: true, min: 1, why: 'reseau fibre' },
  { t: 'Ingénieur Sécurité Applicative / Pentest', d: 'Tests d intrusion web', ok: true, min: 1, why: 'cyber logiciel' },
  { t: 'Ingénieur assurance qualité logiciel', d: 'Tests et recettes', ok: true, min: 1, why: 'qa logiciel' },
  { t: 'Conducteur de ligne', d: 'réglage machines spéciales', ok: false, min: 0, why: 'faible uniquement - rôle opérateur, pas matche' },
  { t: 'Analyste SOC N1', d: 'supervision sécurité', ok: true, min: 1, why: 'soc -> embargo? doit matcher via cyber contexte faible' },
  { t: 'Assistant ressources humaines', d: 'recrutements', ok: false, min: 0, why: 'rh -> veto' },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const r = scoreOffer(c.t, c.d, undefined);
  const ok = r.match === c.ok && r.score >= c.min;
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS' : 'FAIL') + ' | match=' + r.match + ' score=' + r.score + (r.blocked ? ' BLOCKED' : '') + ' | ' + c.t + ' (' + c.why + ')' + (r.matches.length ? ' <- ' + r.matches.join(', ') : ''));
}

const prof = ['gestion de projet', 'scrum'];
const pr = scoreOffer('Chef de projet', 'gestion de projet scrum planning', prof);
console.log(pr.match ? 'PASS profile wired <- ' + pr.matches.join(', ') : 'FAIL profile wired');
console.log('fold test: ' + (scoreOffer('Ingénieur électronique', '').match ? 'PASS fold-accent' : 'FAIL fold-accent'));

console.log('\n' + pass + '/' + (pass + fail) + ' core cases passed' + (fail ? ' -> FIX FAILURES' : ' -> all good'));
process.exit(fail ? 1 : 0);