const { DatabaseSync } = require('node:sqlite');
const os = require('os');
const path = require('path');
const wd = new DatabaseSync(path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Web Data'), { readOnly: true });
// Autofill table stores saved form data
try {
  const rows = wd.prepare("SELECT name, value FROM autofill WHERE lower(name) LIKE '%email%' OR lower(value) LIKE '%@%' OR lower(value) LIKE '%linkedin%' OR lower(name) LIKE '%linkedin%' ORDER BY rowid DESC LIMIT 20").all();
  console.log('autofill entries: ' + rows.length);
  rows.forEach(r => console.log(`  name="${(r.name||'').slice(0,40)}" value="${(r.value||'').slice(0,50)}"`));
} catch(e) { console.log('autofill query failed: ' + e.message.slice(0,60)); }
// Also check password-specific table if exists
const tables = wd.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%password%' OR name LIKE '%autofill%'").all();
console.log('relevant tables: ' + tables.map(t => t.name).join(', '));
wd.close();
