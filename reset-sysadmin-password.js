'use strict';
// Emergency password reset — for when you're locked out and there's no
// other sysadmin account to reset it for you through the UI.
//
// Usage, from inside the gus/ folder:
//   node reset-sysadmin-password.js --username adrian
//   (prompts for the new password, input hidden)
//
// --password "temp-pw-123" also works for scripted use, but a CLI flag
// lands in shell history and is visible to any other user on the box via
// `ps aux` for as long as the process runs — the interactive prompt
// avoids that. No more editing real credentials into this file: it's
// tracked in git, and hand-editing it invites committing them by mistake.
//
// Sets must_change_password back to true, so you'll be forced to pick a
// real password (not this temporary one) the moment you log in.
const { loadConfig } = require('./src/config');
const { initPool } = require('./src/db');
const bcrypt = require('bcryptjs');
const { promptPassword } = require('./scripts/lib/passwordInput');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

(async () => {
  const username = arg('username');
  if (!username) {
    console.error('Usage: node reset-sysadmin-password.js --username <name> [--password <pw>]');
    process.exit(1);
  }

  let newPassword = arg('password') || process.env.GUS_RESET_PASSWORD || null;
  if (!newPassword) {
    newPassword = await promptPassword('New temporary password: ');
  }
  if (!newPassword || newPassword.length < 8) {
    console.error('The new password must be at least 8 characters.');
    process.exit(1);
  }

  const config = loadConfig();
  const pool = initPool(config.database);
  const hash = bcrypt.hashSync(newPassword, 12);

  // Usernames, passwords, and everything else live in separate tables —
  // see migration 005 — so this has to look up the uid first.
  const { rows } = await pool.query('SELECT uid FROM usernames WHERE lower(username) = lower($1)', [username]);
  if (!rows.length) {
    console.error(`No user named "${username}" found.`);
  } else {
    await pool.query(
      'UPDATE passwords SET password_hash = $1, must_change_password = true WHERE uid = $2',
      [hash, rows[0].uid]
    );
    console.log(`Password reset for "${username}". You'll be forced to change it again on next login.`);
  }
  await pool.end();
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
