'use strict';
// Emergency password reset — for when you're locked out and there's no
// other sysadmin account to reset it for you through the UI.
//
// Usage: edit USERNAME and NEW_PASSWORD below, then from inside the gus/
// folder run:  node reset-sysadmin-password.js
//
// Sets must_change_password back to true, so you'll be forced to pick a
// real password (not this temporary one) the moment you log in.
const { loadConfig } = require('./src/config');
const { initPool } = require('./src/db');
const bcrypt = require('bcryptjs');

const USERNAME = 'CHANGE_ME';
const NEW_PASSWORD = 'CHANGE_ME_TEMP_PASSWORD_1';

(async () => {
  if (USERNAME === 'CHANGE_ME' || NEW_PASSWORD === 'CHANGE_ME_TEMP_PASSWORD_1') {
    console.error('Edit USERNAME and NEW_PASSWORD at the top of this file first.');
    process.exit(1);
  }
  if (NEW_PASSWORD.length < 8) {
    console.error('NEW_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }

  const config = loadConfig();
  const pool = initPool(config.database);
  const hash = bcrypt.hashSync(NEW_PASSWORD, 12);

  // Usernames, passwords, and everything else live in separate tables —
  // see migration 005 — so this has to look up the uid first.
  const { rows } = await pool.query('SELECT uid FROM usernames WHERE lower(username) = lower($1)', [USERNAME]);
  if (!rows.length) {
    console.error(`No user named "${USERNAME}" found.`);
  } else {
    await pool.query(
      'UPDATE passwords SET password_hash = $1, must_change_password = true WHERE uid = $2',
      [hash, rows[0].uid]
    );
    console.log(`Password reset for "${USERNAME}". You'll be forced to change it again on next login.`);
  }
  await pool.end();
})();
