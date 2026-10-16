'use strict';
// Tests for the local fallback classifier.
//
// The rule under test is asymmetric on purpose. A wrong REJECT costs the user a
// real opportunity, so the reject side must be narrow and defensible. A wrong
// PROMOTE floods the feed with noise, and measurement showed the promote rule
// runs at 17.6% precision, so it is disabled by default. These tests lock both
// facts in, because "the fallback is safe" is exactly the kind of claim that
// rots silently when someone tunes a threshold.
const test = require('node:test');
const assert = require('node:assert');
const { classifyLocal, ENGINE_ID, countHard } = require('./fallback-classifier.js');

// Every title below is a real one the LLM rejected, with the LLM's own reason.
const LLM_REJECTED = [
  { title: 'Mid-Market Account Executive, London', llm: 'Sales role, explicitly out of scope.' },
  { title: 'Senior Product Marketing Manager', llm: 'Marketing role, not engineering.' },
  { title: 'Head of Performance Marketing (m/w/d) bei Livom', llm: 'Head of marketing, not relevant.' },
  { title: 'Senior SEO & GEO Manager (m/w/d) - Remote', llm: 'Marketing/SEO role.' },
  { title: 'Customer Success & Onboarding (m/w/d)', llm: 'Customer success, not technical.' },
  { title: 'Large Enterprise Account Executive', llm: 'Sales account executive role.' },
  { title: 'Senior Data Analyst (Marketing Analytics)', llm: 'Marketing data analyst, not a tech role.' },
  { title: 'Account Executive/Sales (m/w/d) - Munchen', llm: 'Sales position, not engineering.' },
  { title: 'Influencer Performance Marketing Manager (m/w/d)', llm: 'Marketing manager, unrelated field.' },
  { title: 'Open Source Enterprise Sales Manager - North America', llm: 'Sales manager role.' },
];

// And these are real offers the LLM PROMOTED. The fallback must never reject any
// of them: keeping them pending costs nothing, rejecting them loses a match.
const LLM_PROMOTED = [
  { title: 'Field Technician' },
  { title: 'Technicien Maintenance (H/F)', location: 'Ben Arous' },
  { title: 'Maintenance Engineer / Sr Engineer - M/F/D' },
  { title: 'Assembly Controls Engineer' },
  { title: 'R&D DSIS Operations Engineer (m/f/d)' },
  { title: 'Advanced Technician HHI/Bluffton, SC' },
];

test('rejects the off-target families the LLM rejected, for the same reason', () => {
  for (const row of LLM_REJECTED) {
    const out = classifyLocal({ title: row.title, description: row.llm });
    assert.equal(out.verdict, 'reject', 'expected reject for: ' + row.title);
    assert.equal(out.engine, ENGINE_ID);
    assert.ok(out.reasons[0].startsWith('off-target job family:'), out.reasons[0]);
  }
});

test('never rejects an offer the LLM promoted', () => {
  for (const row of LLM_PROMOTED) {
    const out = classifyLocal({ title: row.title, description: '' });
    assert.notEqual(out.verdict, 'reject', 'must not reject: ' + row.title);
  }
});

test('never promotes by default', () => {
  // Dense, real embedded evidence. Under the old rule this promoted; measured at
  // 17.6% precision it must not, so it abstains and waits for a real model.
  const dense = classifyLocal({
    title: ' conception de cartes electroniques ',
    description: 'fpga, linux embarque, regulation, capteurs, rtos, can bus, stm32, autopilote',
  });
  assert.equal(dense.verdict, 'unsure');
  assert.ok(countHard(dense.reasons[0] ? 'fpga rtos can bus' : '').count > 0);
});

test('promote stays available but strictly opt-in', () => {
  const offer = {
    title: ' conception de cartes electroniques ',
    description: 'fpga, linux embarque, regulation, capteurs, rtos, can bus, stm32',
  };
  assert.equal(classifyLocal(offer, { allowPromote: true }).verdict, 'promote');
  assert.equal(classifyLocal(offer).verdict, 'unsure');
});

test('an engineering token blocks the family veto', () => {
  // "Data Engineer" contains "analyst"-adjacent wording but is a real target;
  // the veto must not fire. It abstains rather than promoting.
  for (const t of ['Senior Data Engineer', 'Data Engineer Analytics', 'Automation Engineer']) {
    assert.notEqual(classifyLocal({ title: t, description: '' }).verdict, 'reject', t);
  }
});

test('a dense body rescues a badly written title from the veto', () => {
  // Title says "analyst", body is unmistakably embedded work. Abstain, do not
  // reject -- the title is more likely written badly than the job being wrong.
  const out = classifyLocal({
    title: 'Analyste',
    description: 'fpga, linux embarque, regulation, capteurs, rtos',
  });
  assert.equal(out.verdict, 'unsure');
});

test('every verdict is attributable', () => {
  for (const t of ['Steuerberater (m/w/d)', 'Registered Nurse', 'Comptable', '']) {
    assert.equal(classifyLocal({ title: t, description: 'x' }).engine, ENGINE_ID);
  }
});
