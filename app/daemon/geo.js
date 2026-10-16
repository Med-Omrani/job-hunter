'use strict';
// Location resolution for the relevance gate.
//
// WHY THIS EXISTS
// The profile states a hard location rule -- on-site roles are in scope for
// Tunisia and France, out of scope elsewhere, and remote roles are in scope
// worldwide. That rule was previously unenforceable: measured on the live band,
// `country` was EMPTY on 9,711 of 11,063 pending offers (88%), so the only
// signal available was a free-text `location` string like "Costa Mesa,
// California, United States" or "Remote - US". Tunisia appeared exactly ZERO
// times in the `country` column of a Tunisia-first pipeline.
//
// This module turns that free text into a country, but it is deliberately
// CONSERVATIVE, because the gate uses it to REJECT. A false "United States" on
// a Tunisian posting silently deletes a real opportunity, so anything not
// confidently recognised returns `unknown` and is left for the model to judge.
// Precision matters here; recall does not.
//
// No network, no LLM: this is a pure function so it stays instant and free, and
// so its behaviour can be asserted in tests against the exact location strings
// the crawler actually produces.

const norm = (s) => String(s || '').toLowerCase()
  // ß/æ/ø have no NFD decomposition, so they would survive to the strip step and
  // split a token in half: "Haßloch" became "ha loch" and stopped matching.
  .replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/œ/g, 'oe')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Phrases that mark a posting as remote regardless of employer country. Checked
// before countries, because "Remote - US" contains both and the remote fact is
// the one the profile cares about.
const REMOTE_WORDS = ['remote', 'teletravail', 'travail a distance', 'work from home',
  'wfh', 'anywhere', 'worldwide', 'global remote', 'distributed team', 'full remote'];

// Countries the profile accepts ON-SITE. ISO-2.
const ON_SCOPE = ['TN', 'FR'];

// Country name / demonym / spelling variants -> ISO-2. Ordered longest-first at
// match time so "united kingdom" is never shadowed by "united".
const COUNTRY_ALIASES = {
  TN: ['tunisia', 'tunisie', 'tunisian', 'tunisienne', 'republic of tunisia', 'tunis'],
  FR: ['france', 'french', 'republique francaise', 'francaise', 'francais'],
  US: ['united states', 'united states of america', 'usa', 'u s a', 'america', 'etats unis', 'states united'],
  GB: ['united kingdom', 'great britain', 'britain', 'england', 'scotland', 'wales', 'uk', 'great britain and northern ireland'],
  IE: ['ireland', 'irish', 'eire', 'republic of ireland'],
  DE: ['germany', 'german', 'deutschland', 'allemagne'],
  IN: ['india', 'indian', 'bharat'],
  SG: ['singapore'],
  KR: ['south korea', 'korea', 'republic of korea', 'korean'],
  JP: ['japan', 'japanese'],
  TH: ['thailand', 'thai', 'bangkok'],
  CA: ['canada', 'canadian'],
  CH: ['switzerland', 'swiss', 'suisse'],
  AT: ['austria', 'austrian', 'osterreich'],
  ES: ['spain', 'spanish', 'espagne', 'espana'],
  IT: ['italy', 'italian', 'italia'],
  NL: ['netherlands', 'dutch', 'holland', 'pays bas'],
  BE: ['belgium', 'belgian', 'belgique'],
  PL: ['poland', 'polish', 'polska'],
  SE: ['sweden', 'swedish', 'sverige'],
  PT: ['portugal', 'portuguese', 'porto'],
  NO: ['norway', 'norwegian'],
  DK: ['denmark', 'danish'],
  FI: ['finland', 'finnish'],
  CZ: ['czechia', 'czech republic', 'czech'],
  RO: ['romania', 'romanian'],
  GR: ['greece', 'greek'],
  MA: ['morocco', 'moroccan', 'maroc'],
  DZ: ['algeria', 'algerian', 'algerie'],
  LY: ['libya', 'libyan'],
  EG: ['egypt', 'egyptian'],
  SA: ['saudi arabia', 'saudi'],
  AE: ['united arab emirates', 'uae', 'dubai', 'abu dhabi'],
  QA: ['qatar'],
  KW: ['kuwait'],
  JO: ['jordan'],
  IL: ['israel', 'israeli'],
  TR: ['turkey', 'turkish', 'turkiye'],
  MX: ['mexico', 'mexican'],
  BR: ['brazil', 'brazilian', 'brasil'],
  AR: ['argentina', 'argentine'],
  CO: ['colombia', 'colombian'],
  ZA: ['south africa'],
  NG: ['nigeria', 'nigerian'],
  KE: ['kenya', 'kenyan'],
  AU: ['australia', 'australian'],
  NZ: ['new zealand'],
};

// Cities that identify a country on their own. Deliberately NOT exhaustive --
// only cities that are (a) common in scraped postings and (b) not shared with a
// more likely market. A city missing from this table returns `unknown`, which is
// the safe outcome: the offer stays in the band for the model.
const CITY_COUNTRY = {
  // Tunisia -- the primary market, and the one that must never be misread.
  tunis: 'TN', 'ben arous': 'TN', manouba: 'TN', ariana: 'TN', gammarth: 'TN',
  'lac 2': 'TN', 'les berges du lac': 'TN', 'sidi bou said': 'TN', sfax: 'TN',
  sousse: 'TN', kairouan: 'TN', bizerte: 'TN', gabes: 'TN', nabeul: 'TN',
  monastir: 'TN', hammamet: 'TN', djerba: 'TN', zarzis: 'TN', korba: 'TN',
  mahdia: 'TN', tozeur: 'TN', medenine: 'TN', tataouine: 'TN', beja: 'TN',
  // France
  paris: 'FR', lyon: 'FR', marseille: 'FR', toulouse: 'FR', bordeaux: 'FR',
  nantes: 'FR', lille: 'FR', grenoble: 'FR', strasbourg: 'FR', rennes: 'FR',
  nice: 'FR', montpellier: 'FR', reims: 'FR', toulon: 'FR', avignon: 'FR',
  clichy: 'FR', courbevoie: 'FR', guyancourt: 'FR', versailles: 'FR', orleans: 'FR',
  // United States -- unambiguous names only (see AMBIGUOUS below)
  'san francisco': 'US', seattle: 'US', boston: 'US', 'kansas city': 'US',
  'salt lake city': 'US', 'los angeles': 'US', 'san diego': 'US',
  'san mateo': 'US', 'santa clara': 'US', sunnyvale: 'US',
  austin: 'US', dallas: 'US', houston: 'US', chicago: 'US', atlanta: 'US',
  denver: 'US', phoenix: 'US', portland: 'US', 'palo alto': 'US',
  'santa clara valley': 'US', woodside: 'US', menlo: 'US', burlingame: 'US',
  redwood: 'US', fremont: 'US', hayward: 'US', berkeley: 'US', oakland: 'US',
  irvine: 'US', carlsbad: 'US', 'colorado springs': 'US',raleigh: 'US',
  durham: 'US', sacramento: 'US', minneapolis: 'US', detroit: 'US',
  baltimore: 'US', philadelphia: 'US', pittsburgh: 'US', tampa: 'US',
  orlando: 'US', miami: 'US', atlanta: 'US', charlotte: 'US', nashville: 'US',
  bakersfield: 'US', anaheim: 'US', modesto: 'US', ventura: 'US', oxnard: 'US',
  reno: 'US', boise: 'US', omaha: 'US', tucson: 'US', albany: 'US',
  // Elsewhere
  bengaluru: 'IN', bangalore: 'IN', pune: 'IN', chennai: 'IN', hyderabad: 'IN',
  mumbai: 'IN', delhi: 'IN', 'new delhi': 'IN', gurugram: 'IN', noida: 'IN',
  kochi: 'IN', mysore: 'IN', mysuru: 'IN', coimbatore: 'IN', jaipur: 'IN',
  'coeur dalene': 'US', boise: 'US', singapore: 'SG', jurong: 'SG',
  seoul: 'KR', busan: 'KR', incheon: 'KR', tokyo: 'JP', osaka: 'JP',
  yokohama: 'JP', nagoya: 'JP', bangkok: 'TH', pattaya: 'TH', phuket: 'TH',
  toronto: 'CA', montreal: 'CA', vancouver: 'CA', ottawa: 'CA', calgary: 'CA',
  edmonton: 'CA', berlin: 'DE', munich: 'DE', münchen: 'DE', hamburg: 'DE',
  frankfurt: 'DE', 'cologne': 'DE', koln: 'DE', stuttgart: 'DE', dusseldorf: 'DE',
  dortmund: 'DE', essen: 'DE', leipzig: 'DE', dresden: 'DE', nuremberg: 'DE',
  heidelberg: 'DE', bremen: 'DE', hannover: 'DE', duisburg: 'DE',
  bochum: 'DE', welzow: 'DE', wasserburg: 'DE', 'bad saulgau': 'DE', hassloch: 'DE',
  'london': 'GB', manchester: 'GB', birmingham: 'GB', leeds: 'GB',
  bristol: 'GB', glasgow: 'GB', edinburgh: 'GB', liverpool: 'GB',
  bradford: 'GB', reading: 'GB', cambridge: 'GB', oxford: 'GB', ipswich: 'GB',
  dublin: 'IE', cork: 'IE', galway: 'IE', zurich: 'CH', geneva: 'CH',
  basel: 'CH', bern: 'CH', vienna: 'AT', salzburg: 'AT', madrid: 'ES',
  barcelona: 'ES', valencia: 'ES', seville: 'ES', bilbao: 'ES', malaga: 'ES',
  milan: 'IT', rome: 'IT', turin: 'IT', naples: 'IT', bologna: 'IT',
  florence: 'IT', amsterdam: 'NL', rotterdam: 'NL', utrecht: 'NL',
  eindhoven: 'NL', brussels: 'BE', antwerp: 'BE', ghent: 'BE', warsaw: 'PL',
  krakow: 'PL', kraków: 'PL', wroclaw: 'PL', poznan: 'PL', stockholm: 'SE',
  gothenburg: 'SE', malmo: 'SE', lisbon: 'PT', oporto: 'PT', porto: 'PT',
  oslo: 'NO', copenhagen: 'DK', helsinki: 'FI', prague: 'CZ', brno: 'CZ',
  brno: 'CZ', bucharest: 'RO', cluj: 'RO', athens: 'GR', thessaloniki: 'GR',
  casablanca: 'MA', rabat: 'MA', marrakesh: 'MA', tangier: 'MA',
  algiers: 'DZ', oran: 'DZ', tripoli: 'LY', benghazi: 'LY', cairo: 'EG',
  alexandria: 'EG', riyadh: 'SA', jeddah: 'SA', 'tel aviv': 'IL',
  istanbul: 'TR', ankara: 'TR', izmir: 'TR', 'mexico city': 'MX',
  guadalajara: 'MX', monterrey: 'MX', 'sao paulo': 'BR', 'são paulo': 'BR',
  rio: 'BR', campinas: 'BR', curitiba: 'BR', buenos: 'AR', aires: 'AR',
  bogota: 'CO', bogotá: 'CO', 'cape town': 'ZA', johannesburg: 'ZA',
  lagos: 'NG', abuja: 'NG', nairobi: 'KE', sydney: 'AU', melbourne: 'AU',
  brisbane: 'AU', perth: 'AU', adelaide: 'AU', canberra: 'AU',
  'auckland': 'NZ', wellington: 'NZ',
};

// Cities that name more than one plausible market, so a country cannot be
// inferred from them alone:
//   San Jose      -> California, or San Jose, Costa Rica
//   Valencia      -> Spain, and Valencia, Venezuela
//   Cordoba       -> Spain, and Argentina
//   Victoria      -> Canada, Australia, and the Seychelles
//   Santiago      -> Chile, and the Dominican Republic
// "Washington" and "New York" are NOT listed: they are US states in US_STATES,
// which is checked first, so a global posting naming "UK" or "Canada" is still
// resolved correctly by the earlier country-alias pass.
// Fragments of multi-word city names are deliberately absent too: "Buenos Aires",
// "Rio de Janeiro", "Le Mans", "Palo Alto" and "Saint Paul" must not be keyed on
// their first word, or a US address like "Saint Paul, Minnesota" reads as France.
const AMBIGUOUS_CITIES = new Set(['san jose', 'valencia', 'cordoba', 'córdoba',
  'victoria', 'santiago', 'springfield', 'mobile', 'franklin', 'arlington',
  'richmond', 'asheville']);

// US states and DC, plus their abbreviations. "CA" is handled as a whole token so
// it cannot fire inside "case" or "location".
const US_STATES = ['alabama', 'alaska', 'arizona', 'arkansas', 'california',
  'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii',
  'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana',
  'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
  'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
  'new hampshire', 'new jersey', 'new mexico', 'north carolina',
  'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania',
  'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas',
  'utah', 'vermont', 'virginia', 'washington', 'wisconsin', 'wyoming',
  'district of columbia', 'washington dc', 'new york state', 'puerto rico'];
const US_ABBR = ['al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga',
  'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi',
  'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd',
  'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va',
  'wa', 'wv', 'wi', 'wy', 'dc'];

function hasPhrase(tokens, phrase) {
  const p = phrase.split(' ');
  for (let i = 0; i + p.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < p.length; j++) if (tokens[i + j] !== p[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

function isRemote(loc) {
  return REMOTE_WORDS.some((w) => hasPhrase(String(loc || '').split(' '), w));
}

// A bare two-letter state code is only trusted in the two unambiguous shapes a
// real address uses: the "City, ST" comma form, or "ST 12345" with a ZIP.
//
// Matching abbreviations as free-floating tokens is unsafe, and testing caught
// the proof: "Jobs in Berlin" normalised to ['job','in','berlin'], and 'in' is
// Indiana -- so a Berlin posting came back as United States, which the gate
// would have rejected. The other collisions in the code list are English words:
// 'or', 'ok', 'hi', 'ma', 'me', 'de', 'la'.
function usAbbrHit(rawLoc) {
  const s = String(rawLoc || '');
  let m = s.match(/[,\s](al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)\b\s*[,]?\s*\d{5}\b/i);
  if (m) return m[1].toLowerCase();
  m = s.match(/,\s*(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)\b/gi);
  if (m) return String(m[1]).toLowerCase();
  return null;
}

function fromCountryField(raw) {
  const v = norm(raw);
  if (!v) return null;
  for (const [iso, names] of Object.entries(COUNTRY_ALIASES)) {
    for (const n of names) if (hasPhrase(v.split(' '), n)) return { country: iso, matched: n };
  }
  return null;
}

function fromLocation(locText, rawLoc) {
  const toks = locText.split(' ').filter(Boolean);

  // Country alias first -- an explicit country outranks a city lookup, because
  // "Paris, TX, United States" names a country and must not read as France.
  for (const [iso, names] of Object.entries(COUNTRY_ALIASES)) {
    for (const n of names) if (hasPhrase(toks, n)) return { country: iso, matched: n };
  }

  // United States inference, strongest signal first. Order matters: an
  // unambiguous US city is better evidence than a state abbreviation, because
  // "San Francisco, CA" is caught by the city and would otherwise be stuck at
  // the weaker code-level match.
  for (const s of US_STATES) if (hasPhrase(toks, s)) return { country: 'US', matched: s };
  for (const [city, iso] of Object.entries(CITY_COUNTRY)) {
    if (iso === 'US' && !AMBIGUOUS_CITIES.has(city) && hasPhrase(toks, city)) {
      return { country: 'US', matched: city };
    }
  }
  const ab = usAbbrHit(rawLoc);
  if (ab) return { country: 'US', matched: ab };

  // Non-US cities.
  for (const [city, iso] of Object.entries(CITY_COUNTRY)) {
    if (iso !== 'US' && !AMBIGUOUS_CITIES.has(city) && hasPhrase(toks, city)) {
      return { country: iso, matched: city };
    }
  }
  return null;
}

/**
 * Resolve an offer's location.
 * Returns { remote, country|null, matched|null, confidence, raw }.
 * `country` is null whenever the location could not be read confidently.
 */
function resolveGeo(offer) {
  const o = offer || {};
  const rawLoc = String(o.location || '');
  const rawCountry = String(o.country || '');
  const loc = norm(rawLoc);

  const remote = isRemote(loc);

  // The structured country field, when populated, is authoritative.
  const fromField = fromCountryField(rawCountry);
  if (fromField) {
    return { remote, country: fromField.country, matched: fromField.matched,
      confidence: 'field', raw: rawLoc };
  }

  if (!loc) {
    return { remote: false, country: null, matched: null, confidence: null, raw: rawLoc };
  }

  const hit = fromLocation(loc, rawLoc);
  if (!hit) {
    return { remote, country: null, matched: null, confidence: null, raw: rawLoc };
  }
  // A country read out of free text is weaker evidence than a populated field.
  const confidence = hit.country === 'US' && hit.matched && US_ABBR.includes(hit.matched)
    ? 'text-weak'   // a bare "CA" could be Canada in a global posting
    : 'text';
  return { remote, country: hit.country, matched: hit.matched, confidence, raw: rawLoc };
}

/**
 * Apply the profile's location rule to a resolved location.
 * Returns 'in' | 'out' | 'unknown'.
 *   - remote                -> 'in'   (worldwide remote is in scope)
 *   - Tunisia or France     -> 'in'
 *   - any other known country -> 'out'
 *   - unreadable location   -> 'unknown' (never reject on absence of data)
 */
function locationScope(geo, onScope) {
  const allow = new Set(onScope || ON_SCOPE);
  if (!geo) return 'unknown';
  if (geo.remote) return 'in';
  if (!geo.country) return 'unknown';
  // A country inferred from a bare two-letter token is not strong enough to
  // reject a posting on.
  if (geo.confidence === 'text-weak') return 'unknown';
  return allow.has(geo.country) ? 'in' : 'out';
}

// Readable country names for the stored rejection reason. The gate's reason
// string is shown to the user, so "on-site in IN" is not acceptable output when
// "on-site in India" is available.
const COUNTRY_NAMES = {
  TN: 'Tunisia', FR: 'France', US: 'United States', GB: 'United Kingdom',
  IE: 'Ireland', DE: 'Germany', IN: 'India', SG: 'Singapore', KR: 'South Korea',
  JP: 'Japan', TH: 'Thailand', CA: 'Canada', CH: 'Switzerland', AT: 'Austria',
  ES: 'Spain', IT: 'Italy', NL: 'Netherlands', BE: 'Belgium', PL: 'Poland',
  SE: 'Sweden', PT: 'Portugal', NO: 'Norway', DK: 'Denmark', FI: 'Finland',
  CZ: 'Czechia', RO: 'Romania', GR: 'Greece', MA: 'Morocco', DZ: 'Algeria',
  LY: 'Libya', EG: 'Egypt', SA: 'Saudi Arabia', AE: 'United Arab Emirates',
  QA: 'Qatar', KW: 'Kuwait', JO: 'Jordan', IL: 'Israel', TR: 'Turkey',
  MX: 'Mexico', BR: 'Brazil', AR: 'Argentina', CO: 'Colombia', ZA: 'South Africa',
  NG: 'Nigeria', KE: 'Kenya', AU: 'Australia', NZ: 'New Zealand',
};

function countryName(iso) {
  return COUNTRY_NAMES[String(iso || '').toUpperCase()] || String(iso || '').toUpperCase() || 'unknown';
}

module.exports = {
  resolveGeo, locationScope, norm, isRemote, countryName, COUNTRY_NAMES,
  ON_SCOPE, REMOTE_WORDS, COUNTRY_ALIASES, CITY_COUNTRY, AMBIGUOUS_CITIES, US_STATES, US_ABBR,
};
