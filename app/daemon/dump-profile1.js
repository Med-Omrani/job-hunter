const { DatabaseSync } = require('node:sqlite');
const os = require('os');
const path = require('path');
const prof1 = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Profile 1', 'Login Data');
try {
  const db = new DatabaseSync(prof1, { readOnly: true });
  const row = db.prepare("SELECT username_value, password_value, signon_realm FROM logins WHERE lower(signon_realm) LIKE '%linkedin%'").get();
  if (row) {
    console.log('Profile 1 LinkedIn entry:');
    console.log('  realm: ' + (row.signon_realm||'').slice(0,60));
    console.log('  username_len: ' + String(row.username_value||'').length);
    console.log('  password_len: ' + (row.password_value?row.password_value.length:0));
  } else { console.log('no LinkedIn entry in Profile 1'); }
  // total logins
  const total = db.prepare("SELECT COUNT(*) as c FROM logins").get();
  console.log('total logins in Profile 1: ' + total.c);
  db.close();
} catch(e) { console.log('Profile 1 Login Data: ' + e.message.slice(0,80)); }
