#!/usr/bin/env node
'use strict';
// GAM admin CLI. Runs against the database directly using config.yml's
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
const { UserStore } = require('../src/models/userStore');
const { RankStore, CAPABILITIES } = require('../src/models/rankStore');
const { AppStore } = require('../src/models/appStore');
const { SessionStore } = require('../src/models/sessionStore');
const { FailedLoginStore } = require('../src/models/failedLoginStore');
const { ActivityLog } = require('../src/models/activityLog');
const { SiteSettingsStore } = require('../src/models/siteSettingsStore');
const { PasswordPolicyStore } = require('../src/models/passwordPolicyStore');
const { RULE_TYPES } = require('../src/utils/passwordPolicy');
const { EmailSettingsStore } = require('../src/models/emailSettingsStore');
const { Mailer } = require('../src/utils/mailer');
const { warnSecretOutput } = require('./lib/secretWarning');

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
GAM admin CLI — operates directly on the database, no login required.

USERS
  users list
  users show <username>
  users create <username> <role> [--password P] [--full-name N] [--description D] [--email E]
  users set-role <username> <role>   (see 'ranks list' for valid role names)
  users set-email <username> <email>
  users reset-password <username> [--password P] [--keep-must-change]
  users disable <username>
  users enable <username>
  users rename <username> <newUsername>
  users delete <username>

  Password requirements (below) and history checks are enforced only on
  self-service changes — a password set here, from the console, is exempt.

RANKS
  ranks list
  ranks create <name> <label> [--<capability> ...]   (capabilities: ${CAPABILITIES.join(', ')})
  ranks set-capability <name> <capability> <on|off>
  ranks delete <name>

APPS
  apps list
  apps create <slug> [--name N] [--auth-method gam|oauth|saml|oidc|sssd|kerberos] [--redirect-uris uri1,uri2]
  apps set-auth-method <slug> <gam|oauth|saml|oidc|sssd|kerberos>
  apps set-redirect-uris <slug> <uri1,uri2,...>   (OIDC apps only)
  apps oidc-info <slug>                            (issuer/client_id/redirect_uris for an OIDC app)
  apps regenerate-secret <slug>
  apps disable <slug>
  apps enable <slug>
  apps delete <slug>
  apps block <slug> <username>
  apps unblock <slug> <username>

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

PASSWORD POLICY
  password-policy list
  password-policy create <type> <label> [--params '{"...json..."}']   (types: ${Object.keys(RULE_TYPES).join(', ')})
  password-policy set-enabled <id> <on|off>
  password-policy delete <id>

EMAIL (SMTP)
  email show
  email set-smtp [--host H] [--port P] [--secure true|false] [--username U] [--password P] [--from-address A] [--from-name N]
  email enable | disable
  email send-test <address>

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
  const rankStore = new RankStore(pool);
  const emailSettingsStore = new EmailSettingsStore(pool, config.server.sessionSecret);
  const mailer = new Mailer(emailSettingsStore);
  const userStore = new UserStore(pool, rankStore, mailer);
  const appStore = new AppStore(pool);
  const sessionStore = new SessionStore(pool, config.session);
  const failedLoginStore = new FailedLoginStore(pool, config.rateLimit.login);
  const activityLog = new ActivityLog(pool);
  const siteSettingsStore = new SiteSettingsStore(pool);
  const passwordPolicyStore = new PasswordPolicyStore(pool);

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
  function printOidcInfo(app, secret) {
    const issuer = config.server.publicUrl.replace(/\/$/, '');
    console.log(`\nOIDC connection info for "${app.slug}":`);
    console.log(`  Issuer / discovery: ${issuer}/.well-known/openid-configuration`);
    console.log(`  client_id:          ${app.appId}`);
    if (secret) console.log(`  client_secret:      ${secret}`);
    console.log(`  redirect_uris:      ${app.redirectUris.join(', ') || '(none registered yet)'}`);
    console.log('  PKCE (S256) is required on every authorization request.');
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
      if (!username || !role) { console.error('Usage: users create <username> <role> [--password P] [--full-name N] [--description D] [--email E]'); process.exit(1); }
      if (!(await rankStore.exists(role))) { console.error(`No such rank "${role}". Run "ranks list" to see valid roles.`); process.exit(1); }
      const password = flags.password || genPassword();
      // Password requirements are enforced only on self-service changes
      // (see src/utils/enforcePasswordPolicy.js) — a temp password set
      // here, from the console, is exempt by design.
      const profile = await userStore.create({ username, password, role, fullName: flags['full-name'] || '', description: flags.description || '', email: flags.email || '' });
      console.log(`Created "${profile.username}" (${profile.role}).`);
      if (!flags.password) { warnSecretOutput(); console.log(`Temporary password: ${password}`); }
      console.log('Forced to change password on first login.');
    } else if (sub === 'set-email') {
      const [username, email] = positional;
      const user = await requireUser(username);
      const profile = await userStore.update(user.uid, { email: email || null });
      console.log(`"${profile.username}"'s email is now ${profile.email || '(cleared)'}.`);
    } else if (sub === 'set-role') {
      const [username, role] = positional;
      const user = await requireUser(username);
      if (!(await rankStore.exists(role))) { console.error(`No such rank "${role}". Run "ranks list" to see valid roles.`); process.exit(1); }
      await userStore.setRole(user.uid, role);
      console.log(`"${username}" is now ${role}.`);
    } else if (sub === 'reset-password') {
      const user = await requireUser(positional[0]);
      const password = flags.password || genPassword();
      // Forces a change by default, same as `users create` — pass
      // --keep-must-change to hand over a permanent password instead.
      await userStore.resetPassword(user.uid, password, { clearMustChange: Boolean(flags['keep-must-change']) });
      await sessionStore.revokeAllForUser(user.uid);
      console.log(`Password reset for "${user.username}". All their active sessions were revoked.`);
      if (!flags.password) { warnSecretOutput(); console.log(`Temporary password: ${password}`); }
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
      if (user.role === 'systemAdministrator' && (await userStore.countSysadmins()) <= 1) {
        console.error('Cannot delete the last remaining sysadmin account.'); process.exit(1);
      }
      await userStore.remove(user.uid);
      await sessionStore.revokeAllForUser(user.uid);
      console.log(`Deleted "${user.username}".`);
    } else {
      console.error('Unknown users subcommand. See --help.'); process.exit(1);
    }
    return pool.end();
  }

  if (cmd === 'ranks') {
    const { positional, flags } = parseArgs(rest);
    if (sub === 'list') {
      table(await rankStore.list(), [
        { label: 'NAME', get: (r) => r.name },
        { label: 'LABEL', get: (r) => r.label },
        { label: 'BUILTIN', get: (r) => r.isBuiltin ? 'yes' : 'no' },
        { label: 'CAPABILITIES', get: (r) => CAPABILITIES.filter((c) => r.capabilities[c]).join(', ') || '(none)' },
      ]);
    } else if (sub === 'create') {
      const [name, label] = positional;
      if (!name || !label) { console.error(`Usage: ranks create <name> <label> [--<capability> ...]  (capabilities: ${CAPABILITIES.join(', ')})`); process.exit(1); }
      const capabilities = {};
      for (const cap of CAPABILITIES) if (flags[cap]) capabilities[cap] = true;
      const rank = await rankStore.create({ name, label, capabilities });
      console.log(`Created rank "${rank.label}" (${rank.name}).`);
    } else if (sub === 'set-capability') {
      const [name, capability, onOff] = positional;
      if (!name || !CAPABILITIES.includes(capability) || !['on', 'off'].includes(onOff)) {
        console.error(`Usage: ranks set-capability <name> <capability> <on|off>  (capabilities: ${CAPABILITIES.join(', ')})`); process.exit(1);
      }
      const rank = await rankStore.update(name, { capabilities: { [capability]: onOff === 'on' } });
      console.log(`"${rank.label}" ${capability} is now ${onOff}.`);
    } else if (sub === 'delete') {
      await rankStore.remove(positional[0]);
      console.log(`Deleted rank "${positional[0]}".`);
    } else {
      console.error('Unknown ranks subcommand. See --help.'); process.exit(1);
    }
    return pool.end();
  }

  if (cmd === 'apps') {
    const { positional, flags } = parseArgs(rest);
    if (sub === 'list') {
      table(await appStore.list(), [
        { label: 'SLUG', get: (a) => a.slug },
        { label: 'NAME', get: (a) => a.name },
        { label: 'AUTH METHOD', get: (a) => a.authMethod },
        { label: 'STATUS', get: (a) => a.disabled ? 'disabled' : 'active' },
        { label: 'APP ID', get: (a) => a.appId },
      ]);
    } else if (sub === 'create') {
      const [slug] = positional;
      if (!slug) { console.error('Usage: apps create <slug> [--name N] [--auth-method gam|oauth|saml|oidc|sssd|kerberos] [--redirect-uris uri1,uri2]'); process.exit(1); }
      const redirectUris = flags['redirect-uris'] ? flags['redirect-uris'].split(',').map((s) => s.trim()).filter(Boolean) : [];
      const { app, secret } = await appStore.create({ slug, name: flags.name || slug, authMethod: flags['auth-method'] || 'gam', redirectUris });
      console.log(`Registered "${app.slug}" (auth method: ${app.authMethod}).`);
      console.log(`App ID: ${app.appId}`);
      warnSecretOutput();
      console.log(`Secret (save this now — it will not be shown again): ${secret}`);
      if (app.authMethod === 'oidc') printOidcInfo(app, secret);
    } else if (sub === 'set-auth-method') {
      const [slug, authMethod] = positional;
      const app = await requireApp(slug);
      if (!authMethod) { console.error('Usage: apps set-auth-method <slug> <gam|oauth|saml|oidc|sssd|kerberos>'); process.exit(1); }
      const updated = await appStore.setAuthMethod(app.app_id, authMethod);
      console.log(`"${updated.slug}" auth method is now ${updated.authMethod}.`);
    } else if (sub === 'set-redirect-uris') {
      const [slug, uriList] = positional;
      const app = await requireApp(slug);
      if (!uriList) { console.error('Usage: apps set-redirect-uris <slug> <uri1,uri2,...>'); process.exit(1); }
      const redirectUris = uriList.split(',').map((s) => s.trim()).filter(Boolean);
      const updated = await appStore.setRedirectUris(app.app_id, redirectUris);
      console.log(`"${updated.slug}" redirect URIs: ${updated.redirectUris.join(', ') || '(none)'}`);
    } else if (sub === 'oidc-info') {
      const app = await requireApp(positional[0]);
      if (app.auth_method !== 'oidc') { console.error(`"${app.slug}" is not an OIDC app.`); process.exit(1); }
      printOidcInfo({ appId: app.app_id, slug: app.slug, redirectUris: app.redirect_uris || [] }, null);
    } else if (sub === 'regenerate-secret') {
      const app = await requireApp(positional[0]);
      const result = await appStore.regenerateSecret(app.app_id);
      console.log(`New secret for "${app.slug}" (the old one stops working immediately):`);
      warnSecretOutput();
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
    } else if (sub === 'block') {
      const [slug, username] = positional;
      const app = await requireApp(slug);
      const user = await requireUser(username);
      await appStore.blockUser(app.app_id, user.uid);
      console.log(`"${user.username}" is now blocked from "${app.slug}".`);
    } else if (sub === 'unblock') {
      const [slug, username] = positional;
      const app = await requireApp(slug);
      const user = await requireUser(username);
      await appStore.unblockUser(app.app_id, user.uid);
      console.log(`"${user.username}"'s access to "${app.slug}" was restored.`);
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
      const esc = (v) => {
        let s = String(v ?? '');
        if (/^[=+\-@]/.test(s)) s = `'${s}`; // prevent formula injection when this CSV is opened in Excel/Sheets
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
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
      console.log('Logo cleared (falls back to the default GAM mark). Note: this only clears the database field — delete the file under data/branding/ yourself if you want it fully gone.');
    } else {
      console.error('Unknown branding subcommand. See --help.'); process.exit(1);
    }
    return pool.end();
  }

  if (cmd === 'password-policy') {
    const { positional, flags } = parseArgs(rest);
    if (sub === 'list') {
      table(await passwordPolicyStore.list(), [
        { label: 'ID', get: (r) => r.id },
        { label: 'TYPE', get: (r) => r.type },
        { label: 'LABEL', get: (r) => r.label },
        { label: 'ENABLED', get: (r) => r.enabled ? 'yes' : 'no' },
        { label: 'PARAMS', get: (r) => JSON.stringify(r.params) },
      ]);
    } else if (sub === 'create') {
      const [type, label] = positional;
      if (!type || !label) { console.error(`Usage: password-policy create <type> <label> [--params '{"...json..."}']  (types: ${Object.keys(RULE_TYPES).join(', ')})`); process.exit(1); }
      let params = {};
      if (flags.params) { try { params = JSON.parse(flags.params); } catch (e) { console.error('--params must be valid JSON.'); process.exit(1); } }
      const rule = await passwordPolicyStore.create({ type, label, params });
      console.log(`Created rule "${rule.label}" (${rule.id}).`);
    } else if (sub === 'set-enabled') {
      const [id, onOff] = positional;
      if (!id || !['on', 'off'].includes(onOff)) { console.error('Usage: password-policy set-enabled <id> <on|off>'); process.exit(1); }
      const rule = await passwordPolicyStore.update(id, { enabled: onOff === 'on' });
      console.log(`"${rule.label}" is now ${onOff}.`);
    } else if (sub === 'delete') {
      await passwordPolicyStore.remove(positional[0]);
      console.log('Rule deleted.');
    } else {
      console.error('Unknown password-policy subcommand. See --help.'); process.exit(1);
    }
    return pool.end();
  }

  if (cmd === 'email') {
    const { positional, flags } = parseArgs(rest);
    if (sub === 'show') {
      console.log(JSON.stringify(await emailSettingsStore.get(), null, 2));
    } else if (sub === 'set-smtp') {
      const settings = await emailSettingsStore.update({
        host: flags.host, port: flags.port, secure: flags.secure !== undefined ? flags.secure !== 'false' : undefined,
        username: flags.username, password: flags.password, fromAddress: flags['from-address'], fromName: flags['from-name'],
      });
      console.log('SMTP settings updated:', JSON.stringify(settings, null, 2));
    } else if (sub === 'enable') {
      await emailSettingsStore.update({ enabled: true });
      console.log('Email sending enabled.');
    } else if (sub === 'disable') {
      await emailSettingsStore.update({ enabled: false });
      console.log('Email sending disabled.');
    } else if (sub === 'send-test') {
      const to = positional[0];
      if (!to) { console.error('Usage: email send-test <address>'); process.exit(1); }
      const result = await mailer.sendMail({ to, subject: 'GAM test email', html: '<p>This is a test email from the GAM CLI.</p>' });
      console.log(result.sent ? `Sent to ${to}.` : `Not sent: ${result.reason}`);
    } else {
      console.error('Unknown email subcommand. See --help.'); process.exit(1);
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
