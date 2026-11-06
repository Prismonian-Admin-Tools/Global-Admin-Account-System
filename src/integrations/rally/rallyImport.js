'use strict';
const crypto = require('crypto');
const fs = require('fs');

/**
 * Importing existing Rally users into Passport (CLI: `rally import-list`
 * and `rally import`).
 *
 * planImport() decides, for every Rally user, what importing it would do:
 *   create — new Passport account (username = the part of the Rally
 *            UserName before the @, rank from the Rally permission), linked
 *            to that Rally user
 *   link   — a Passport account already matches (same email, or same
 *            username with no conflicting email); only the link is
 *            recorded, the Passport account itself is left unchanged
 *   skip   — with the reason (already linked, username clash, ...)
 * importUsers() re-plans against current state and applies the chosen rows.
 *
 * Rally never exposes passwords, so every created account gets a random
 * temporary password (forced change on first login), written only to a
 * new owner-read-only file — never printed.
 */

const DEFAULT_ROLE_MAP = {
  subscriptionAdmin: 'systemAdministrator',
  workspaceAdmin: 'elevatedStaff',
  default: 'staff',
};

function rallyPermission(user) {
  if (user.SubscriptionAdmin === true) return 'Subscription Admin';
  return user.SubscriptionPermission || 'None';
}

function roleFor(user, roleMap) {
  const perm = rallyPermission(user);
  if (perm === 'Subscription Admin') return roleMap.subscriptionAdmin;
  if (perm === 'Workspace Admin') return roleMap.workspaceAdmin;
  return roleMap.default;
}

function localPart(value) {
  const v = String(value || '').trim();
  const at = v.indexOf('@');
  return at > 0 ? v.slice(0, at) : v;
}

function fullNameOf(user) {
  const parts = [user.FirstName, user.LastName].map((x) => (x || '').trim()).filter(Boolean);
  return parts.length ? parts.join(' ') : (user.DisplayName || '').trim();
}

const lc = (v) => String(v || '').trim().toLowerCase();

function genPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#%';
  let out = '';
  for (let i = 0; i < 16; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}

class RallyImporter {
  constructor({ client, rallySync, userStore, rankStore, roleMap = {} }) {
    this.client = client;
    this.rallySync = rallySync;
    this.userStore = userStore;
    this.rankStore = rankStore;
    this.roleMap = { ...DEFAULT_ROLE_MAP, ...roleMap };
  }

  async checkRoleMap() {
    for (const [key, rank] of Object.entries(this.roleMap)) {
      if (!(await this.rankStore.exists(rank))) {
        throw new Error(`rally.import.roleMap.${key} is "${rank}", which isn't a Passport rank (see 'ranks list')`);
      }
    }
  }

  /**
   * Returns { rows, hiddenNoEmail }. Rally users without an email address
   * are left out (counted in hiddenNoEmail) unless includeNoEmail.
   */
  async planImport({ includeNoEmail = false } = {}) {
    await this.checkRoleMap();
    const [rallyUsers, accounts, links] = await Promise.all([
      this.client.listUsers(),
      this.userStore.listIdentities(),
      this.rallySync.activeLinks(),
    ]);

    const linkByObjectId = new Map(links.map((l) => [String(l.rally_object_id), l]));
    const linkByUid = new Map(links.map((l) => [l.uid, l]));
    const accountsByEmail = new Map();
    const accountByUsername = new Map();
    for (const a of accounts) {
      if (a.email) {
        const key = lc(a.email);
        accountsByEmail.set(key, [...(accountsByEmail.get(key) || []), a]);
      }
      accountByUsername.set(lc(a.username), a);
    }

    let hiddenNoEmail = 0;
    const rows = [];
    for (const u of rallyUsers) {
      const email = (u.EmailAddress || '').trim();
      if (!email && !includeNoEmail) { hiddenNoEmail++; continue; }
      const row = {
        rallyObjectId: String(u.ObjectID),
        rallyUserName: u.UserName || '',
        email,
        fullName: fullNameOf(u),
        rallyPermission: rallyPermission(u),
        rallyDisabled: Boolean(u.Disabled),
        lastLogin: u.LastLoginDate || null,
        passportUsername: localPart(u.UserName || email),
        passportRank: roleFor(u, this.roleMap),
        action: 'create',
        linkTo: null,
        note: '',
        rallyUser: u,
      };
      rows.push(row);

      const existingLink = linkByObjectId.get(row.rallyObjectId);
      if (existingLink) {
        Object.assign(row, { action: 'skip', note: `already linked to Passport account "${existingLink.username}"` });
        continue;
      }
      if (!row.passportUsername) {
        Object.assign(row, { action: 'skip', note: 'Rally user has no UserName or email to derive a username from' });
        continue;
      }

      const byEmail = email ? (accountsByEmail.get(lc(email)) || []) : [];
      let match = null;
      let how = '';
      if (byEmail.length > 1) {
        Object.assign(row, { action: 'skip', note: `${byEmail.length} Passport accounts share this email — link manually` });
        continue;
      } else if (byEmail.length === 1) {
        match = byEmail[0]; how = 'same email';
      } else {
        const byName = accountByUsername.get(lc(row.passportUsername));
        if (byName) {
          if (byName.email && lc(byName.email) !== lc(email)) {
            Object.assign(row, { action: 'skip', note: `username "${byName.username}" is taken by a Passport account with a different email (${byName.email})` });
            continue;
          }
          match = byName; how = 'same username';
        }
      }

      if (match) {
        const otherLink = linkByUid.get(match.uid);
        if (otherLink) {
          Object.assign(row, { action: 'skip', note: `Passport account "${match.username}" is already linked to Rally user ObjectID ${otherLink.rally_object_id}` });
          continue;
        }
        const notes = [`matched by ${how}; Passport account unchanged`];
        if (match.disabled !== row.rallyDisabled) {
          notes.push(match.disabled ? 'Rally user will be DISABLED to match Passport' : 'Rally user will be RE-ENABLED to match Passport');
        }
        Object.assign(row, { action: 'link', linkTo: match.username, passportUsername: match.username, passportRank: '', note: notes.join('; ') });
        continue;
      }

      if (row.rallyDisabled) row.note = 'disabled in Rally — Passport account will be created disabled';
    }

    // Two Rally users that would get the same new Passport username (e.g.
    // ada@a.com and ada@b.com): creating either would be a guess, so both
    // are skipped for an admin to sort out.
    const creates = new Map();
    for (const r of rows.filter((x) => x.action === 'create')) {
      const k = lc(r.passportUsername);
      creates.set(k, [...(creates.get(k) || []), r]);
    }
    for (const group of creates.values()) {
      if (group.length < 2) continue;
      for (const r of group) {
        Object.assign(r, { action: 'skip', note: `username "${r.passportUsername}" would be shared by ${group.length} Rally users (${group.map((g) => g.rallyUserName || g.email).join(', ')})` });
      }
    }

    return { rows, hiddenNoEmail };
  }

  /**
   * Applies the selected rows. select is { all: true } or { identifiers:
   * [...] } — Rally ObjectID, UserName or email, case-insensitive. Unknown
   * identifiers abort before anything is changed. Returns a per-row result
   * list; one row failing doesn't stop the rest.
   */
  async importUsers({ select, includeNoEmail = false, dryRun = false, passwordsFile }) {
    const { rows } = await this.planImport({ includeNoEmail: includeNoEmail || Boolean(select.identifiers) });

    let chosen;
    if (select.all) {
      chosen = rows.filter((r) => r.action !== 'skip');
    } else {
      const index = new Map();
      for (const r of rows) for (const k of [r.rallyObjectId, r.rallyUserName, r.email]) if (k) index.set(lc(k), r);
      const missing = select.identifiers.filter((id) => !index.has(lc(id)));
      if (missing.length) throw new Error(`Not found in Rally: ${missing.join(', ')}`);
      chosen = [...new Set(select.identifiers.map((id) => index.get(lc(id))))];
    }

    const results = [];
    if (dryRun) {
      for (const r of chosen) results.push({ row: r, outcome: r.action === 'skip' ? 'skipped' : `would ${r.action}`, detail: r.note });
      return { results, passwordsFile: null };
    }

    let pwFd = null;
    const needsPasswords = chosen.some((r) => r.action === 'create');
    if (needsPasswords) {
      if (!passwordsFile) throw new Error('A passwords file path is required to create accounts');
      // 'wx' refuses to overwrite an existing file; 0600 keeps the
      // temporary passwords readable by the operator only.
      pwFd = fs.openSync(passwordsFile, 'wx', 0o600);
      fs.writeSync(pwFd, 'passport_username,email,passport_rank,temporary_password\n');
    }

    try {
      for (const r of chosen) {
        if (r.action === 'skip') { results.push({ row: r, outcome: 'skipped', detail: r.note }); continue; }
        try {
          if (r.action === 'link') {
            const account = await this.userStore.findByUsername(r.linkTo);
            const linked = account && await this.rallySync.link(await this.userStore.getProfile(account.uid), r.rallyUser);
            if (!linked) throw new Error('link refused — the account or Rally user was linked by someone else meanwhile');
            results.push({ row: r, outcome: 'linked', detail: r.note });
          } else {
            const password = genPassword();
            const profile = await this.userStore.create({
              username: r.passportUsername, password, role: r.passportRank,
              fullName: r.fullName, email: r.email || null, description: 'Imported from Rally', skipAccountSync: true,
            });
            // Written (and flushed) before anything else can fail, so a
            // created account's password is never lost.
            fs.writeSync(pwFd, `${[profile.username, profile.email || '', profile.role, password].map(csvCell).join(',')}\n`);
            fs.fsyncSync(pwFd);
            if (r.rallyDisabled) await this.userStore.update(profile.uid, { disabled: true });
            const linked = await this.rallySync.link(await this.userStore.getProfile(profile.uid), r.rallyUser);
            if (!linked) throw new Error(`account "${profile.username}" was created but linking it to Rally was refused — run 'rally import' for it again`);
            results.push({ row: r, outcome: 'created', detail: r.note });
          }
        } catch (err) {
          results.push({ row: r, outcome: 'failed', detail: err.message });
        }
      }
    } finally {
      if (pwFd !== null) fs.closeSync(pwFd);
    }
    return { results, passwordsFile: needsPasswords ? passwordsFile : null };
  }
}

/* ---------------- CSV / JSON helpers for the CLI ---------------- */

const CSV_COLUMNS = [
  ['rally_object_id', (r) => r.rallyObjectId],
  ['rally_username', (r) => r.rallyUserName],
  ['email', (r) => r.email],
  ['full_name', (r) => r.fullName],
  ['rally_permission', (r) => r.rallyPermission],
  ['rally_disabled', (r) => (r.rallyDisabled ? 'yes' : 'no')],
  ['last_login', (r) => r.lastLogin || ''],
  ['passport_username', (r) => r.passportUsername],
  ['passport_rank', (r) => r.passportRank],
  ['action', (r) => r.action],
  ['note', (r) => r.note],
];

// Quotes as needed, and defuses spreadsheet formula injection: a Rally
// name like "=HYPERLINK(...)" must open in Excel as text, not run.
function csvCell(value) {
  let v = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function rowsToCsv(rows) {
  const lines = [CSV_COLUMNS.map(([h]) => h).join(',')];
  for (const r of rows) lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(r))).join(','));
  return `${lines.join('\n')}\n`;
}

function rowsToJson(rows) {
  return rows.map((r) => Object.fromEntries(CSV_COLUMNS.map(([h, get]) => [h, h === 'rally_disabled' ? r.rallyDisabled : get(r)])));
}

/** Minimal RFC 4180 parser — enough to read back a CSV this module wrote (and a spreadsheet re-saved). */
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** The rally_object_id column of an import-list CSV (BOM- and order-tolerant). */
function objectIdsFromCsv(text) {
  const [header, ...body] = parseCsv(text.replace(/^﻿/, ''));
  const col = (header || []).map((h) => h.trim().toLowerCase()).indexOf('rally_object_id');
  if (col === -1) throw new Error('CSV has no rally_object_id column — use a file produced by `rally import-list --csv`');
  return body.map((r) => (r[col] || '').trim().replace(/^'/, '')).filter(Boolean);
}

module.exports = { RallyImporter, DEFAULT_ROLE_MAP, rowsToCsv, rowsToJson, objectIdsFromCsv, parseCsv, csvCell };
