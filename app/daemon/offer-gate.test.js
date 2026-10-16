'use strict';
// Tests for the tier-0 gate. Every rejection case here was an offer the LLM
// actually rejected, and every escape case was one it actually promoted, so the
// suite encodes measured behaviour rather than intent.
const test = require('node:test');
const assert = require('node:assert');
const { tierZero } = require('./offer-gate.js');

const rej = (offer) => tierZero(offer).verdict === 'reject';
const passes = (offer) => tierZero(offer).verdict === 'pass';

test('rejects on-location: the markets that dominate the band', () => {
  for (const location of ['Costa Mesa, California, United States', 'San Francisco, CA',
    'Bangalore, India', 'Berlin, Germany', 'Toronto, Ontario, Canada', 'London',
    'Singapore, Singapore', 'Seoul, South Korea', 'Tokyo, Japan', 'Dublin, Ireland']) {
    assert.ok(rej({ title: 'Automation Engineer', location }), location);
  }
});

test('never rejects Tunisia or France', () => {
  for (const location of ['Tunis, Tunisia', 'Ben Arous', 'France, Paris', 'Lyon',
    'Sfax', 'Gammarth', 'Sousse, Tunisia']) {
    assert.ok(passes({ title: 'Technicien Automatisme', location }),
      'must not reject: ' + location);
  }
});

test('never rejects remote work anywhere', () => {
  // Isolates geography from seniority: remote exempts an offer from the LOCATION
  // rule, not from the seniority rule. A senior remote job is still too senior.
  for (const location of ['Remote', 'Remote - US', 'Remote - United States',
    'Remote worldwide', 'Anywhere']) {
    assert.ok(passes({ title: 'Backend Engineer', location }),
      'must not reject: ' + location);
  }
  assert.ok(rej({ title: 'Senior Backend Engineer', location: 'Remote' }),
    'remote must not exempt seniority');
});

test('rejects off-target job families', () => {
  for (const title of ['Mid-Market Account Executive', 'Senior Product Marketing Manager',
    'Head of Performance Marketing', 'Customer Success Manager', 'Senior SEO Manager',
    'Steuerberater (m/w/d)', 'Registered Nurse', 'Comptable']) {
    assert.ok(rej({ title }), title);
  }
});

test('rejects seniority, except in the industrial-maintenance track', () => {
  assert.ok(rej({ title: 'Senior Security Engineer' }));
  assert.ok(rej({ title: 'Director of Engineering, Operations Planning' }));
  assert.ok(rej({ title: 'Head of Platform Engineering' }));

  // The two offers the un-carved-out rule deleted by mistake.
  assert.ok(passes({ title: 'Maintenance Engineer / Sr Engineer - M/F/D' }),
    'industrial maintenance must survive a "Sr" in the title');
  assert.ok(passes({ title: 'Calibration/Metrology Engineer/Sr. Engineer (M/F/D)' }));
  assert.ok(passes({ title: 'Sr Ingenieur Maintenance Industrielle' }));
  assert.ok(passes({ title: 'Technicien Qualite UAP' }));
});

test('never rejects an offer the LLM promoted', () => {
  // These are the real promoted titles from the corpus. The gate is allowed to
  // abstain on them; it is not allowed to delete them.
  for (const title of ['Field Technician', 'Technicien Maintenance (H/F)',
    'Assembly Controls Engineer', 'R&D DSIS Operations Engineer (m/f/d)',
    'Advanced Technician HHI/Bluffton, SC', 'Maintenance Engineer / Sr Engineer - M/F/D',
    'Calibration/Metrology Engineer/Sr. Engineer (M/F/D)']) {
    assert.ok(passes({ title, location: '' }), title);
  }
});

test('an unreadable location is never a rejection', () => {
  // 89% of the live band had no country at all. Treating absence as rejection
  // would delete the entire backlog.
  for (const location of ['', 'Hybrid', 'On-site', 'Multiple locations', undefined]) {
    assert.ok(passes({ title: 'Backend Engineer', location }), JSON.stringify(location));
  }
});

test('an ambiguous city is never a rejection', () => {
  assert.ok(passes({ title: 'Backend Engineer', location: 'San Jose' }));
  assert.ok(passes({ title: 'Backend Engineer', location: 'Valencia' }));
});

test('reports every rule that fired, not just the first', () => {
  const r = tierZero({ title: 'Senior Account Executive', location: 'Bangalore, India' });
  assert.equal(r.verdict, 'reject');
  assert.deepEqual(r.rules.sort(), ['family', 'geo', 'senior']);
  assert.ok(r.reason.includes('India'));
});

test('the gate abstains rather than promoting', () => {
  // A plausible offer must come out 'pass' -- never 'promote'. There is no
  // promote verdict in this module at all, by design.
  const r = tierZero({
    title: 'Ingénieur Automatisme',
    location: 'Tunis, Tunisia',
    description: 'automate programmable, supervision, scada,regulation, capteurs',
  });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.rules.length, 0);
});

test('a throwing offer cannot crash the gate into a false pass', () => {
  const r = tierZero({ title: null, location: {}, get description() { throw new Error('boom'); } });
  assert.equal(r.verdict, 'pass');
});
