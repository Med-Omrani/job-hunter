'use strict';
// Effective profile — API profile first (user edits in the app always win),
// missing contact fields fall back to tailored/linkedin_kb.json
// (the frozen source of truth for identity/contact).
// Read-only: never writes the KB file, never prints secrets to logs.
const fs = require('fs');
const path = require('path');
const api = require('./api_client.js');

const KB_PATH = path.join(__dirname, '..', '..', 'tailored', 'linkedin_kb.json');

let kbCache = null; // null = not loaded yet
function getKbContact() {
  if (kbCache) return kbCache;
  kbCache = {};
  try {
    const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
    const c = (kb && kb.contact) || {};
    const email = String(c.email_primary || c.email_secondary || kb.email || '').trim();
    const phone = String(c.phone || '').trim();
    const name = String(kb.name || '').trim();
    if (email) kbCache.email = email;
    if (phone) kbCache.phone = phone;
    if (name) kbCache.name = name;
    const location = String(kb.location || '').trim();
    if (location) kbCache.location = location;
  } catch (_) {}
  return kbCache;
}

async function getEffectiveProfile() {
  let p = {};
  try { p = await api.getProfile(); } catch (_) {}
  const kb = getKbContact();
  const name = String(p.name || kb.name || '').trim();
  let email = String(p.email || '').trim();
  let phone = String(p.phone || '').trim();
  const location = String(p.location || kb.location || '').trim();
  const locParts = location.split(',').map((s) => s.trim()).filter(Boolean);
  const city = locParts.length > 1 ? locParts[0] : (locParts[0] || '');
  const country = locParts.length > 1 ? locParts[locParts.length - 1] : (locParts[0] || '');
  const fromKb = [];
  if (!email && kb.email) { email = kb.email; fromKb.push('email'); }
  if (!phone && kb.phone) { phone = kb.phone; fromKb.push('phone'); }
  const apiEmpty = !String(p.name || '').trim() && !String(p.email || '').trim() && !String(p.phone || '').trim();
  const source = fromKb.length === 0 ? 'api' : (apiEmpty ? 'kb' : 'mixed:' + fromKb.join(','));
  return { profile: { name, email, phone, location, city, country }, source };
}

module.exports = { getEffectiveProfile, getKbContact };
