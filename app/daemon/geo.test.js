'use strict';
// Tests for location resolution.
//
// Every string below is one the crawler actually produced in the live `location`
// field, taken from the pending band, because that is the only input that
// matters. The asymmetry under test: a WRONG country here rejects a real offer,
// so "unknown" is the correct answer far more often than a confident guess, and
// the Tunisia/France cases are the ones that must never be lost.
const test = require('node:test');
const assert = require('node:assert');
const { resolveGeo, locationScope, norm } = require('./geo.js');

const countryOf = (loc, country) => resolveGeo({ location: loc, country: country || '' }).country;
const scopeOf = (loc) => locationScope(resolveGeo({ location: loc }), ['TN', 'FR']);

test('reads the two on-scope markets', () => {
  for (const l of ['France, Paris', 'Paris', 'Lyon', 'Marseille', 'Toulouse', 'Bordeaux',
    'Nantes', 'Lille', 'Grenoble', 'Courbevoie', 'Guyancourt', 'Clichy']) {
    assert.equal(countryOf(l), 'FR', l);
  }
  for (const l of ['Tunisia', 'Tunis', 'Ben Arous', 'Tunis, Tunisia', 'Ariana',
    'Sfax', 'Sousse', 'Gammarth', 'Manouba', 'Sidi Bou Said', 'Les Berges du Lac']) {
    assert.equal(countryOf(l), 'TN', l);
  }
});

test('never misreads a US address as France or Tunisia', () => {
  // The regression that motivated the fragment rules: "Saint" must not key France.
  for (const l of ['Costa Mesa, California, United States', 'Ashville, Ohio, United States',
    'San Francisco, CA', 'Santa Ana, California', 'San Mateo, California',
    'Washington, DC', 'New York, NY', 'San Francisco', 'Austin, TX',
    'Springfield, Illinois', 'Mobile, Alabama']) {
    const c = countryOf(l);
    assert.ok(c === 'US' || c === null, l + ' resolved to ' + c + ' (must be US or unknown)');
  }
});

test('reads the junk markets that dominate the band', () => {
  const expect = {
    'Bangalore, India': 'IN', 'Pune, India; Chennai, India': 'IN',
    'Singapore, Singapore': 'SG', 'Seoul, South Korea': 'KR', 'Tokyo, Japan': 'JP',
    'Berlin, Berlin, Germany': 'DE', 'Munich': 'DE', 'Frankfurt': 'DE',
    'London': 'GB', 'London, United Kingdom': 'GB', 'Dublin, Ireland': 'IE',
    'Toronto, Ontario, Canada': 'CA', 'Bangkok, Thailand': 'TH',
    'Amsterdam, Netherlands': 'NL', 'Madrid, Spain': 'ES', 'Milan, Italy': 'IT',
    'Wasserburg am Inn': 'DE', 'Haßloch': 'DE', 'Hannover': 'DE',
    'Cologne': 'DE', 'Munich': 'DE', 'Berlin': 'DE',
  };
  for (const [loc, iso] of Object.entries(expect)) {
    assert.equal(countryOf(loc), iso, loc);
  }
});

test('remote wins over any country', () => {
  // "Remote - US" and "Remote - United States" are IN SCOPE: the profile accepts
  // remote worldwide. Getting this wrong would drop legitimate remote work.
  for (const l of ['Remote', 'Remote - US', 'Remote - United States', 'Remote / Düsseldorf',
    'Fully Remote', 'remote worldwide', 'anywhere']) {
    assert.equal(scopeOf(l), 'in', l);
  }
});

test('on-site scope follows the profile rule', () => {
  assert.equal(scopeOf('Tunis, Tunisia'), 'in');
  assert.equal(scopeOf('France, Paris'), 'in');
  assert.equal(scopeOf('Costa Mesa, California, United States'), 'out');
  assert.equal(scopeOf('Bangalore, India'), 'out');
  assert.equal(scopeOf('Berlin, Germany'), 'out');
});

test('missing or unreadable location is unknown, never out', () => {
  // This is the important safety property: absence of data must not become a
  // rejection. 89% of the live band had an empty country field, so a gate that
  // treated "unknown" as "out" would delete the entire backlog.
  for (const l of ['', 'Hybrid', 'On-site', 'Multiple locations', 'Home office']) {
    assert.equal(scopeOf(l), 'unknown', JSON.stringify(l));
  }
  assert.equal(scopeOf(''), 'unknown');
});

test('an ambiguous city does not become a confident country', () => {
  // San Jose is California to a US recruiter and Costa Rica to everyone else, so
  // a wrong guess here rejects a real offer. Unknown is the honest answer.
  const g = resolveGeo({ location: 'San Jose' });
  assert.equal(g.country, null);
  assert.equal(locationScope(g), 'unknown');
});

test('an explicit country field outranks a same-named US city', () => {
  // Paris, Texas. The city table says FR; the country field says US. The field
  // is authoritative, so this must not read as France.
  assert.equal(resolveGeo({ location: 'Paris', country: 'United States' }).country, 'US');
  assert.equal(locationScope(resolveGeo({ location: 'Paris', country: 'United States' })), 'out');
});

test('a bare state abbreviation is never trusted', () => {
  // "CA" alone is California or Canada depending on the poster, so it is not
  // enough evidence to discard an offer. The comma/ZIP forms are recognised,
  // but a code-level match is still marked weak so it cannot reject on its own.
  assert.equal(resolveGeo({ location: 'CA' }).country, null);
  assert.equal(locationScope(resolveGeo({ location: 'CA' })), 'unknown');
  // "Tunis, in" resolves through the city alias to Tunisia, not through the
  // 'in' token to Indiana.
  assert.equal(resolveGeo({ location: 'Tunis, in' }).country, 'TN');

  // A real US address is still resolved, via the strong city signal.
  assert.equal(resolveGeo({ location: 'San Francisco, CA' }).country, 'US');
  assert.equal(locationScope(resolveGeo({ location: 'San Francisco, CA' })), 'out');
  assert.equal(resolveGeo({ location: 'Springfield, IL 62704' }).country, 'US');
});

test('accents and punctuation do not defeat matching', () => {
  assert.equal(norm('São Paulo, SP'), 'sao paulo sp');
  assert.equal(norm('Haßloch'), 'hassloch');
  assert.equal(countryOf('München, Germany'), 'DE');
  assert.equal(countryOf('Haßloch'), 'DE');
  assert.equal(countryOf('Bruxelles, Belgique'), 'BE'); // "Belgique" is Belgium
  assert.equal(countryOf('Hannover, Niedersachsen'), 'DE');
});

test('does not match country names inside unrelated words', () => {
  // "in" must not read as India (or, before the comma/ZIP rule, as Indiana), and
  // "industry" must not match "india".
  assert.equal(countryOf('Job in Berlin'), 'DE');
  assert.equal(countryOf('industry leader'), null);
  assert.equal(countryOf('in'), null);
  assert.equal(countryOf('us'), null);
  assert.equal(countryOf('usa and canada'), 'US'); // names the US outright
});
