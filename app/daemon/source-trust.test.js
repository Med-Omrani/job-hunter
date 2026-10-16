'use strict';
// Tests for the source trust floor. The failure mode that matters here is
// silent: a floor that demotes everything from a source, or one that fails to
// demote, quietly changes what reaches the user's feed with no error anywhere.
const test = require('node:test');
const assert = require('node:assert');
const trust = require('./source-trust.js');

// The exact titles that produced the 96.7% match rate on arbeitnow.
const NOISE = [
  { title: 'Lohnbuchhalter:in / Payroll Specialist (all genders)', score: 1 },
  { title: 'Steuerberater (all genders) bis zu 100% Remote', score: 1 },
  { title: 'Senior Campaign Analyst', score: 1 },
  { title: 'E-Commerce Manager für Shopify (m/w/d) – Vollzeit', score: 1 },
];

test('defaults floor only the source with a measured false-positive rate', () => {
  const t = trust.buildSourceMinScore();
  assert.deepEqual(t, { arbeitnow: 3 });
});

// jobijoba is a genuine jobs board, on-target for a Tunisia-first app, and its
// raw match rate is high for the same reason arbeitnow's is: aggregators
// aggregate. Flooring it would cut 2,247 matches down to 228. The raw rate is a
// proxy; it must not override what the source actually is.
test('an on-target aggregator is not floored by default', () => {
  assert.equal(trust.sourceMinScore({ id: 'jobijoba' }), 0);
});

test('an unknown source has no floor', () => {
  assert.equal(trust.sourceMinScore({ id: 'greenhouse-valeo' }), 0);
});

test('source ids are matched case-insensitively', () => {
  const t = trust.buildSourceMinScore();
  assert.equal(trust.sourceMinScore({ id: 'Arbeitnow' }, t), 3);
});

test("a source's own minScore wins over the global map", () => {
  const t = trust.buildSourceMinScore();
  assert.equal(trust.sourceMinScore({ id: 'arbeitnow', minScore: 1 }, t), 1);
  assert.equal(trust.sourceMinScore({ id: 'greenhouse-x', minScore: 4 }, t), 4);
});

test('env spec overrides the default and keeps the rest', () => {
  const t = trust.buildSourceMinScore('arbeitnow=5,jobijoba=2');
  assert.equal(t.arbeitnow, 5);
  assert.equal(t.jobijoba, 2);
});

test('malformed env entries are ignored rather than zeroing a source', () => {
  const t = trust.buildSourceMinScore('arbeitnow,,=4,jobijoba=notanumber');
  assert.equal(t.arbeitnow, 3);
  assert.equal(t.jobijoba, undefined);
});

test('floors are clamped to the 0..6 range', () => {
  const t = trust.buildSourceMinScore('arbeitnow=99,jobijoba=-5');
  assert.equal(t.arbeitnow, 6);
  assert.equal(t.jobijoba, 0);
});

test('a floor of 0 leaves every verdict untouched', () => {
  const r = trust.applyFloor({ match: true, score: 1 }, 0);
  assert.equal(r.match, true);
  assert.equal(r.demoted, false);
});

test('applyFloor demotes a match scoring below the floor', () => {
  const r = trust.applyFloor({ match: true, score: 1 }, 3);
  assert.equal(r.match, false, 'weak match must be demoted');
  assert.equal(r.demoted, true);
  assert.equal(r.score, 1, 'the true score must survive for the band accounting');
  assert.equal(r.floor, 3);
});

test('applyFloor keeps a match at or above the floor', () => {
  const r = trust.applyFloor({ match: true, score: 4 }, 3);
  assert.equal(r.match, true);
  assert.equal(r.demoted, false);
});

test('applyFloor never promotes a non-match', () => {
  const r = trust.applyFloor({ match: false, score: 0 }, 1);
  assert.equal(r.match, false);
  assert.equal(r.demoted, false, 'a rejection is not a demotion');
});

test('applyFloor does not mutate the scorer result', () => {
  const sc = { match: true, score: 1, matches: ['analyst'] };
  trust.applyFloor(sc, 3);
  assert.equal(sc.match, true, 'input must be untouched');
  assert.deepEqual(sc.matches, ['analyst']);
});

test('every measured arbeitnow weak hit is demoted at its default floor', () => {
  const floor = trust.sourceMinScore({ id: 'arbeitnow' });
  for (const n of NOISE) {
    const r = trust.applyFloor({ match: true, score: n.score }, floor);
    assert.equal(r.demoted, true, 'should demote: ' + n.title);
  }
});

test('a strong posting from a floored source still reaches the feed', () => {
  const floor = trust.sourceMinScore({ id: 'arbeitnow' });
  const r = trust.applyFloor({ match: true, score: 6 }, floor);
  assert.equal(r.match, true, 'the floor must not blanket-ban a source');
});
