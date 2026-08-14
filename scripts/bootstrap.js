'use strict';
// Usage:
//   npm run bootstrap -- --username adrian --password "temporary-pw-123" [--app console]
//
// Creates the first owner account (forced to change password on first
// login, like every account) and, optionally, registers a first client
// app, printing its secret ONCE.
const { loadConfig } = require('../src/config');
const { initPool } = require('../src/db');
const { UserStore } = require('../src/models/userStore');
const { AppStore } = require('../src/models/appStore');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  const username = arg('username');
  const password = arg('password');
  const appSlug = arg('app');

  if (!username || !password) {
    console.error('Usage: npm run bootstrap -- --username <name> --password <pw> [--app <slug>]');
    process.exit(1);
  }

  const config = loadConfig();
  const pool = initPool(config.database);
  const userStore = new UserStore(pool);
  const appStore = new AppStore(pool);

  const profile = await userStore.create({ username, password, role: 'owner', fullName: '', description: 'Bootstrap owner account' });
  console.log(`\nCreated owner "${profile.username}" (uid ${profile.uid}).`);
  console.log('mustChangePassword is set — they will be forced to pick a new password on first login.\n');

  if (appSlug) {
    const { app, secret } = await appStore.create({ slug: appSlug, name: appSlug });
    console.log(`Registered app "${app.slug}" (appId ${app.appId}).`);
    console.log(`Secret (SAVE THIS NOW — it cannot be shown again): ${secret}\n`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
