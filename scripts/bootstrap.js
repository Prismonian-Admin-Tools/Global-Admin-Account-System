'use strict';
// Usage:
//   npm run bootstrap -- --username adrian [--app console]
//   (prompts for the temporary password, input hidden)
//
// --password "temporary-pw-123" still works for scripted/CI use, but a
// CLI flag lands in shell history and is visible to any other user on the
// box via `ps aux` for as long as the process runs — the interactive
// prompt (or the GUS_BOOTSTRAP_PASSWORD env var) avoids that. Creates the
// first account under the Provider rank (trustedInstaller — full
// capabilities, same as systemAdministrator, see rankStore.js), forced to
// change password on first login like every account, and, optionally,
// registers a first client app, printing its secret ONCE.
const { loadConfig } = require('../src/config');
const { initPool } = require('../src/db');
const { UserStore } = require('../src/models/userStore');
const { RankStore } = require('../src/models/rankStore');
const { AppStore } = require('../src/models/appStore');
const { promptPassword } = require('./lib/passwordInput');
const { warnSecretOutput } = require('./lib/secretWarning');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  const username = arg('username');
  const appSlug = arg('app');

  if (!username) {
    console.error('Usage: npm run bootstrap -- --username <name> [--password <pw>] [--app <slug>]');
    process.exit(1);
  }

  let password = arg('password') || process.env.GUS_BOOTSTRAP_PASSWORD || null;
  if (!password) {
    password = await promptPassword('Temporary password for the Provider account: ');
  }
  if (!password) {
    console.error('A password is required.');
    process.exit(1);
  }

  const config = loadConfig();
  const pool = initPool(config.database);
  const rankStore = new RankStore(pool);
  const userStore = new UserStore(pool, rankStore);
  const appStore = new AppStore(pool);

  // forcePasswordChange:true — a Provider account skips the forced
  // change by default (see userStore.create()), but this password was
  // just typed/prompted for, exactly like any other temporary bootstrap
  // password, so it still gets the classic forced-change treatment.
  const profile = await userStore.create({
    username, password, role: 'trustedInstaller', fullName: '', description: 'Bootstrap Provider account', forcePasswordChange: true,
  });
  console.log(`\nCreated Provider account "${profile.username}" (uid ${profile.uid}).`);
  console.log('mustChangePassword is set — they will be forced to pick a new password on first login.\n');

  if (appSlug) {
    const { app, secret } = await appStore.create({ slug: appSlug, name: appSlug });
    console.log(`Registered app "${app.slug}" (appId ${app.appId}).`);
    warnSecretOutput();
    console.log(`Secret (SAVE THIS NOW — it cannot be shown again): ${secret}\n`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
