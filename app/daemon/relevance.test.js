'use strict';
// Tests for the pure parts of the classifier: prompt assembly and, above all,
// verdict validation. A misaligned verdict does not crash -- it quietly stamps a
// wrong score onto a real posting, which is the failure mode that matters.
const test = require('node:test');
const assert = require('node:assert');
const { buildBatchPrompt, validate, normalize, clip } = require('./relevance.js');
const { parseJsonLoose } = require('./llm-client.js');

const OFFERS = [
  { id: 'a1', title: 'Technicien Maintenance (H/F)', company: 'Valeo', location: 'Tunisie', description: 'Maintenance industriel.' },
  { id: 'a2', title: 'Assistant Professor of Civil Engineering', company: 'Texas A&M', description: 'Tenure-track teaching.' },
];

test('batch prompt carries one indexed entry per offer', () => {
  const p = buildBatchPrompt(OFFERS);
  assert.match(p, /\[0\] id=a1/);
  assert.match(p, /\[1\] id=a2/);
  assert.match(p, /Screen these 2 postings/);
});

test('batch prompt says "none provided" rather than omitting a missing body', () => {
  const p = buildBatchPrompt([{ id: 'z', title: 'T', company: 'C' }]);
  assert.match(p, /description: \(none provided\)/);
});

test('prompt truncates a huge body so one posting cannot eat the context', () => {
  const big = 'x'.repeat(9000);
  const p = buildBatchPrompt([{ id: 'b', title: 'T', company: 'C', description: big }]);
  assert.ok(p.length < 2200, 'prompt should stay bounded, got ' + p.length);
});

test('clip collapses whitespace and adds an ellipsis when cutting', () => {
  assert.equal(clip('a\n\n  b   c', 50), 'a b c');
  const c = clip('abcdefghij', 5);
  assert.equal(c.length, 5);
  assert.match(c, /\u2026$/);
});

test('validate accepts a well-formed reply', () => {
  const v = validate({ verdicts: [{ id: 'a1', match: true, score: 5, reason: 'ok' }, { id: 'a2', match: false, score: 0, reason: 'faculty' }] }, OFFERS);
  assert.equal(v.ok, true);
  assert.equal(v.byId.get('a1').match, true);
});

test('validate accepts a bare array as well as {verdicts:[...]}', () => {
  const v = validate([{ id: 'a1', match: true, score: 4 }, { id: 'a2', match: false, score: 0 }], OFFERS);
  assert.equal(v.ok, true);
});

test('validate REJECTS a missing id instead of shifting verdicts', () => {
  const v = validate({ verdicts: [{ id: 'a1', match: true, score: 5 }] }, OFFERS);
  assert.equal(v.ok, false);
  assert.equal(v.error, 'missing_ids');
  assert.deepEqual(v.missing, ['a2']);
});

test('validate REJECTS a duplicated id', () => {
  const v = validate({ verdicts: [{ id: 'a1', match: true, score: 5 }, { id: 'a1', match: false, score: 0 }, { id: 'a2', match: false, score: 0 }] }, OFFERS);
  assert.equal(v.ok, false);
  assert.equal(v.error, 'duplicate_id');
});

test('validate REJECTS an invented id', () => {
  // All real ids present PLUS a fabricated one, so this exercises unknown_ids
  // rather than tripping the missing-id check first.
  const v = validate({
    verdicts: [
      { id: 'a1', match: true, score: 5 },
      { id: 'a2', match: false, score: 0 },
      { id: 'hallucinated-99', match: true, score: 6 },
    ],
  }, OFFERS);
  assert.equal(v.ok, false);
  assert.equal(v.error, 'unknown_ids');
  assert.deepEqual(v.extra, ['hallucinated-99']);
});

test('validate REJECTS prose with no verdicts array', () => {
  const v = validate({ note: 'I think these are fine' }, OFFERS);
  assert.equal(v.ok, false);
  assert.equal(v.error, 'no_verdicts_array');
});

test('validate coerces numeric ids, since models quote them', () => {
  const offers = [{ id: '123' }, { id: '456' }];
  const v = validate({ verdicts: [{ id: '123', match: true, score: 3 }, { id: '456', match: false, score: 1 }] }, offers);
  assert.equal(v.ok, true);
});

test('normalize clamps score into 0..6 and rounds', () => {
  assert.equal(normalize({ score: 99 }).score, 6);
  assert.equal(normalize({ score: -4 }).score, 0);
  assert.equal(normalize({ score: 3.6 }).score, 4);
  assert.equal(normalize({ score: 'nonsense' }).score, 0);
});

test('normalize only accepts a real boolean for match', () => {
  assert.equal(normalize({ match: true }).match, true);
  assert.equal(normalize({ match: 'true' }).match, true);
  assert.equal(normalize({ match: 'yes' }).match, false);
  assert.equal(normalize({}).match, false);
});

test('parseJsonLoose recovers JSON from a fenced block', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
});

test('parseJsonLoose recovers JSON wrapped in prose', () => {
  assert.deepEqual(parseJsonLoose('Here you go:\n{"a":[1,2]}\nHope that helps!'), { a: [1, 2] });
});

test('parseJsonLoose keeps nested objects intact when trimming to the outer brace', () => {
  assert.deepEqual(parseJsonLoose('noise {"a":{"b":2}} trailing'), { a: { b: 2 } });
});

test('parseJsonLoose throws rather than returning a string', () => {
  assert.throws(() => parseJsonLoose('no json here'), /llm_bad_json/);
  assert.throws(() => parseJsonLoose(''), /llm_bad_json/);
});