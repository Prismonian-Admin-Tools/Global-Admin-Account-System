#!/usr/bin/env node
'use strict';
// GUS admin CLI. Runs against the database directly using config.yml's
// credentials — no HTTP, no login, no session. If you can read
// config.yml on this box, you already have the database password, so
// this doesn't grant anything you didn't already have; it just gives you
// a faster way to use it than hand-writing SQL.
//
// Usage: node scripts/gus-cli.js <command> [args] [--flags]
//    or: npm run cli -- <command> [args] [--flags]

const crypto = require('crypto');
const { loadConfig } = require('../src/config');
const { initPool } = require('../src/db');
const { UserStore, VALID_ROLES } = require('../src/models/userStore');
const { AppStore } = require('../src/models/appStore');
const { SessionStore } = require('../src/models/sessionStore');
const { FailedLoginStore } = require('../src/models/failedLoginStore');
const { ActivityLog } = require('../src/models/activityLog');
const { SiteSettingsStore } = require('../src/models/siteSettingsStore');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function genPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#%';
  let out = '';
  for (let i = 0; i < 16; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}

function table(rows, columns) {
  if (!rows.length) { console.log('(none)'); return; }
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r) ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(columns.map((c) => c.label)));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  rows.forEach((r) => console.log(line(columns.map((c) => c.get(r) ?? ''))));
}

function usage() {
  console.log(`
GUS admin CLI — operates directly on the database, no login required.

USERS
  users list
  users show <username>
  users create <username> <role> [--password P] [--full-name N] [--description D]
  users set-role <username> <owner|admin|moderator>
  users reset-password <username> [--password P] [--keep-must-change]
  users disable <username>
  users enable <username>
  users rename <username> <newUsername>
  users delete <username>

APPS
  apps list
  apps create <slug> [--name N]
  apps regenerate-secret <slug>
  apps disable <slug>
  apps enable <slug>
  apps delete <slug>

SESSIONS
  sessions list <username>
  sessions revoke-all <username>

ACTIVITY
  activity list [--category C] [--actor A] [--from ISO] [--to ISO] [--limit N]
  activity export <file.csv> [--category C] [--actor A] [--from ISO] [--to ISO]

BRANDING
  branding show
  branding set-name <name>
  branding remove-logo

LOGIN ATTEMPTS
  reset-attempts <username>     Clear a lockout for one username
  reset-attempts --all          Clear every recorded attempt for everyone

Passwords omitted from create/reset-password are auto-generated and
printed once. Every new/reset account is forced to change it on next
login — same rule as the web UI, no exceptions.
`.trim());
}

async function main() {
  const [, , cmd, sub, ...rest] = process.argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return usage();

  const config = loadConfig();
  const pool = initPool(config.database);
  const userStore = new UserStore(pool);
  const appStore = new AppStore(pool);
  const sessionStore = new SessionStore(pool, config.session);
  const failedLoginStore = new FailedLoginStore(pool, config.rateLimit.login);
  const activityLog = new ActivityLog(pool);
  const siteSettingsStore = new SiteSettingsStore(pool);

  async function requireUser(username) {
    const user = await userStore.findByUsername(username);
    if (!user) { console.error(`No such user "${username}".`); process.exit(1); }
    return user;
  }
  async function requireApp(slug) {
    const app = await appStore.findBySlug(slug);
    if (!app) { console.error(`No such app "${slug}".`); process.exit(1); }
    return app;
  }

  // ---- top-level shortcut ----
  if (cmd === 'reset-attempts') {
    const { positional, flags } = parseArgs([sub, ...rest].filter(Boolean));
    if (flags.all) {
      const n = await failedLoginStore.clearAll();
      console.log(`Cleared ${n} recorded attempt(s) across all users.`);
    } else if (positional[0]) {
      const n = await failedLoginStore.clear(positional[0]);
      console.log(`Cleared ${n} recorded attempt(s) for "${positional[0]}". Any active lockout is lifted immediately.`);
    } else {
      console.error('Usage: reset-attempts <username>  OR  reset-attempts --all');
      process.exit(1);
    }
    return pool.end();
  }

  if (cmd === 'users') {
    const { positional, flags } = parseArgs(rest);
    if (sub === 'list') {
      table(await userStore.list(), [
        { label: 'USERNAME', get: (u) => u.username },
        { label: 'ROLE', get: (u) => u.role },
        { label: 'STATUS', get: (u) => u.disabled ? 'disabled' : (u.mustChangePassword ? 'must-change-pw' : 'active') },
        { label: 'UID', get: (u) => u.uid },
      ]);
    } else if (sub === 'show') {
      const user = await requireUser(positional[0]);
      console.log(JSON.stringify(await userStore.getProfile(user.uid), null, 2));
    } else if (sub === 'create') {
      const [username, role] = positional;
      if (!username || !role) { console.error('Usage: users create <username> <role> [--password P] [--full-name N] [--description D]'); process.exit(1); }
      if (!VALID_ROLES.includes(role)) { console.error(`Role must be one of: ${VALID_ROLES.join(', ')}`); process.exit(1); }
      const password = flags.password || genPassword();
      const profile = await userStore.create({ username, password, role, fullName: flags['full-name'] || '', description: flags.description || '' });
      console.log(`Created "${profile.username}" (${profile.role}).`);
      if (!flags.password) console.log(`Temporary password: ${password}`);
      console.log('Forced to change password on first login.');
    } else if (sub === 'set-role') {
      const [username, role] = positional;
      const user = await requireUser(username);
      if (!VALID_ROLES.includes(role)) { console.error(`Role must be one of: ${VALID_ROLES.join(', ')}`); process.exit(1); }
      await userStore.setRole(user.uid, role);
      console.log(`"${username}" is now ${role}.`);
    } else if (sub === 'reset-password') {
      const user = await requireUser(positional[0]);
      const password = flags.password || genPassword();
      await userStore.resetPassword(user.uid, password, { clearMustChange: !flags['keep-must-change'] });
      await sessionStore.revokeAllForUser(user.uid);
      console.log(`Password reset for "${user.username}". All their active sessions were revoked.`);
      if (!flags.password) console.log(`Temporary password: ${password}`);
    } else if (sub === 'disable') {
      const user = await requireUser(positional[0]);
      await userStore.update(user.uid, { disabled: true });
      await sessionStore.revokeAllForUser(user.uid);
      console.log(`"${user.username}" disabled and signed out everywhere.`);
    } else if (sub === 'enable') {
      const user = await requireUser(positional[0]);
      await userStore.update(user.uid, { disabled: false });
      console.log(`"${user.username}" enabled.`);
    } else if (sub === 'rename') {
      const [username, newUsername] = positional;
      const user = await requireUser(username);
      const renamed = await userStore.rename(user.uid, newUsername);
      console.log(`Renamed to "${renamed.username}".`);
    } else if (sub === 'delete') {
      const user = await requireUser(positional[0]);
      if (user.role === 'owner' && (await userStore.countOwners()) <= 1) {
        console.error('Cannot delete the last remaining owner account.'); process.exit(1);
      }
      await userStore.remove(user.uid);
      await sessionStore.revokeAllForUser(user.uid);
      console.log(`Deleted "${user.username}".`);
    } else {
      console.error('Unknown users subcommand. See --help.'); process.exit(1);
    }
    return pool.end();
  }

  if (cmd === 'apps') {
    const { positional, flags } = parseArgs(rest);
    if (sub === 'list') {
      table(await appStore.list(), [
        { label: 'SLUG', get: (a) => a.slug },
        { label: 'NAME', get: (a) => a.name },
        { label: 'STATUS', get: (a) => a.disabled ? 'disabled' : 'active' },
        { label: 'APP ID', get: (a) => a.appId },
      ]);
    } else if (sub === 'create') {
      const [slug] = positional;
      if (!slug) { console.error('Usage: apps create <slug> [--name N]'); process.exit(1); }
      const { app, secret } = await appStore.create({ slug, name: flags.name || slug });
      console.log(`Registered "${app.slug}".`);
      console.log(`App ID: ${app.appId}`);
      console.log(`Secret (save this now — it will not be shown again): ${secret}`);
    } else if (sub === 'regenerate-secret') {
      const app = await requireApp(positional[0]);
      const result = await appStore.regenerateSecret(app.app_id);
      console.log(`New secret for "${app.slug}" (the old one stops working immediately):`);
      console.log(result.secret);
    } else if (sub === 'disable') {
      const app = await requireApp(positional[0]);
      await appStore.setDisabled(app.app_id, true);
      console.log(`"${app.slug}" disabled.`);
    } else if (sub === 'enable') {
      const app = await requireApp(positional[0]);
      await appStore.setDisabled(app.app_id, false);
      console.log(`"${app.slug}" enabled.`);
    } else if (sub === 'delete') {
      const app = await requireApp(positional[0]);
      await appStore.remove(app.app_id);
      console.log(`Deleted "${app.slug}".`);
    } else {
      console.error('Unknown apps subcommand. See --help.'); process.exit(1);
    }
    return pool.end();
  }

  if (cmd === 'sessions') {
    const { positional } = parseArgs(rest);
    const user = await requireUser(positional[0]);
    if (sub === 'list') {
      table(await sessionStore.listForUser(user.uid), [
        { label: 'APP', get: (s) => s.app_name },
        { label: 'LAST ACTIVE', get: (s) => new Date(s.last_seen_at).toLocaleString() },
        { label: 'EXPIRES', get: (s) => new Date(s.expires_at).toLocaleString() },
      ]);
    } else if (sub === 'revoke-all') {
      await sessionStore.revokeAllForUser(user.uid);
      console.log(`Signed "${user.username}" out everywhere.`);
    } else {
      console.error('Unknown sessions subcommand. See --help.'); process.exit(1);
    }
    return pool.end();
  }

  if (cmd === 'activity') {
    const { positional, flags } = parseArgs(rest);
    const filters = { category: flags.category || null, actor: flags.actor || null, from: flags.from || null, to: flags.to || null, limit: flags.limit || 50 };
    if (sub === 'list') {
      table(await activityLog.list(filters), [
        { label: 'WHEN', get: (a) => new Date(a.created_at).toLocaleString() },
        { label: 'CATEGORY', get: (a) => a.category },
        { label: 'ACTOR', get: (a) => a.actor_username || '—' },
        { label: 'MESSAGE', get: (a) => a.message },
      ]);
    } else if (sub === 'export') {
      const file = positional[0];
      if (!file) { console.error('Usage: activity export <file.csv> [--category C] [--actor A] [--from ISO] [--to ISO]'); process.exit(1); }
      const rows = await activityLog.list({ ...filters, limit: 5000 });
      const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const csv = ['created_at,category,actor_username,message', ...rows.map((r) => [r.created_at, r.category, r.actor_username, r.message].map(esc).join(','))].join('\n');
      require('fs').writeFileSync(file, csv);
      console.log(`Wrote ${rows.length} row(s) to ${file}.`);
    } else {
      console.error('Unknown activity subcommand. See --help.'); process.exit(1);
    }
    return pool.end();
  }

  if (cmd === 'branding') {
    const { positional } = parseArgs(rest);
    if (sub === 'show') {
      console.log(JSON.stringify(await siteSettingsStore.get(), null, 2));
    } else if (sub === 'set-name') {
      if (!positional[0]) { console.error('Usage: branding set-name <name>'); process.exit(1); }
      const settings = await siteSettingsStore.update({ siteName: positional[0] });
      console.log(`Site name set to "${settings.siteName}".`);
    } else if (sub === 'remove-logo') {
      const settings = await siteSettingsStore.update({ logoExt: null });
      console.log('Logo cleared (falls back to the default GUS mark). Note: this only clears the database field — delete the file under data/branding/ yourself if you want it fully gone.');
    } else {
      console.error('Unknown branding subcommand. See --help.'); process.exit(1);
    }
    return pool.end();
  }

  console.error(`Unknown command "${cmd}". Run with --help to see everything available.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
