'use strict';
const passwords = require('../utils/passwords');
const { simhash64 } = require('../utils/passwordPolicy');

// Column -> API field name mapping. This is the ONLY place that decides
// what "all their user data" means when handed to an app — never include
// password_hash or password_simhash here. Rows passed in here always
// come from the joined SELECT below, never a raw single-table row, so
// the field names are the same regardless of which of the three tables
// (usernames / passwords / userdata) a given column actually lives in.
function toProfile(row) {
  if (!row) return null;
  return {
    uid: row.uid,
    username: row.username,
    role: row.role,
    email: row.email,
    fullName: row.full_name,
    description: row.description,
    disabled: row.disabled,
    mustChangePassword: row.must_change_password,
    cannotChangePassword: row.cannot_change_password,
    passwordNeverExpires: row.password_never_expires,
    passwordExpiresAt: row.password_expires_at,
    passwordExpired: isPasswordExpired(row),
    theme: row.theme,
    avatarExt: row.avatar_ext,
    lastLogin: row.last_login,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Dormant — see src/models/mfaStore.js. Exposed so admins can see
    // who's enrolled; nothing at login checks this yet.
    mfaEnabled: row.mfa_enabled,
  };
}

function isPasswordExpired(row) {
  if (row.password_never_expires) return false;
  if (!row.password_expires_at) return false;
  return Date.now() > new Date(row.password_expires_at).getTime();
}

// An account is really four tables — users (the stable uid anchor every
// other table's FK points to), usernames, passwords, and userdata — but
// every reader in this file wants the same flattened shape toProfile()
// expects, so every read query goes through this one join. created_at
// is the immutable "account created" date, off the anchor table;
// updated_at is userdata's, since that's where most edits land.
const JOINED_SELECT = `
  SELECT u.uid, u.created_at,
         un.username,
         p.password_hash, p.password_simhash, p.must_change_password, p.cannot_change_password,
         p.password_never_expires, p.password_expires_at, p.mfa_enabled,
         d.role, d.full_name, d.description, d.email, d.disabled, d.theme, d.avatar_ext, d.last_login,
         d.updated_at
  FROM users u
  JOIN usernames un ON un.uid = u.uid
  JOIN passwords p ON p.uid = u.uid
  JOIN userdata d ON d.uid = u.uid
`;

class UserStore {
  constructor(pool, rankStore, mailer = null) {
    this.pool = pool;
    this.rankStore = rankStore;
    this.mailer = mailer;
  }

  async findByUsername(username) {
    const { rows } = await this.pool.query(
      `${JOINED_SELECT} WHERE lower(un.username) = lower($1)`, [username || '']
    );
    return rows[0] || null;
  }

  async findByUid(uid) {
    const { rows } = await this.pool.query(`${JOINED_SELECT} WHERE u.uid = $1`, [uid]);
    return rows[0] || null;
  }

  async list() {
    const { rows } = await this.pool.query(`${JOINED_SELECT} ORDER BY un.username ASC`);
    return rows.map(toProfile);
  }

  async getProfile(uid) {
    return toProfile(await this.findByUid(uid));
  }

  /**
   * Checks a username/password pair. Returns one of the four contracted
   * statuses — callers never see anything else for a well-formed request.
   * Unknown username and wrong password both report 'bad', never
   * revealing which part was wrong.
   */
  async verify(username, password) {
    const user = await this.findByUsername(username);
    if (!user) return { status: 'bad' };
    if (!passwords.verify(password, user.password_hash)) return { status: 'bad' };
    if (user.disabled) return { status: 'disabled' };
    const status = (user.must_change_password || isPasswordExpired(user)) ? 'good_change_pw' : 'good';
    return { status, user };
  }

  /** New accounts always start forced to change their password — no flag to opt out of this. Writes span three tables, so it's one transaction. */
  async create({ username, password, role, fullName, description, email }) {
    if (!(await this.rankStore.exists(role))) throw new Error('Invalid role');
    if (!username || !username.trim()) throw new Error('Username is required');
    if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');

    const existing = await this.findByUsername(username);
    if (existing) throw new Error('A user with that username already exists');

    const client = await this.pool.connect();
    let uid;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('INSERT INTO users DEFAULT VALUES RETURNING uid');
      uid = rows[0].uid;
      await client.query('INSERT INTO usernames (uid, username) VALUES ($1, $2)', [uid, username.trim()]);
      await client.query(
        'INSERT INTO passwords (uid, password_hash, password_simhash, must_change_password) VALUES ($1, $2, $3, true)',
        [uid, passwords.hash(password), simhash64(password)]
      );
      await client.query(
        'INSERT INTO userdata (uid, role, full_name, description, email) VALUES ($1, $2, $3, $4, $5)',
        [uid, role, fullName || '', description || '', email || null]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const profile = await this.getProfile(uid);
    if (this.mailer) await this.mailer.sendAccountCreated(profile);
    return profile;
  }

  async setRole(uid, role) {
    if (!(await this.rankStore.exists(role))) throw new Error('Invalid role');
    const { rowCount } = await this.pool.query(
      'UPDATE userdata SET role = $1, updated_at = now() WHERE uid = $2', [role, uid]
    );
    if (!rowCount) throw new Error('No such user');
    return this.getProfile(uid);
  }

  /**
   * The single place a password actually gets overwritten, for BOTH
   * self-service changes and admin/CLI resets — policy and history-
   * similarity REJECTION happen earlier, at the route layer, precisely so
   * that admin/CLI callers (which never call that check) bypass it while
   * still landing here for the bookkeeping every password change needs:
   * retiring the old password into history and resetting the expiry-notice
   * flags so a freshly-changed password gets its own expiry warnings.
   */
  async resetPassword(uid, newPassword, { clearMustChange = true } = {}) {
    if (!newPassword || newPassword.length < 8) throw new Error('Password must be at least 8 characters');
    const before = await this.findByUid(uid);
    if (!before) throw new Error('No such user');

    if (before.password_hash) {
      await this.pool.query(
        'INSERT INTO password_history (uid, password_hash, password_simhash) VALUES ($1, $2, $3)',
        [uid, before.password_hash, before.password_simhash || '']
      );
      await this.pool.query(
        `DELETE FROM password_history WHERE uid = $1 AND id NOT IN (
           SELECT id FROM password_history WHERE uid = $1 ORDER BY created_at DESC LIMIT 2
         )`,
        [uid]
      );
    }

    await this.pool.query(
      `UPDATE passwords SET password_hash = $1, password_simhash = $2, must_change_password = $3, updated_at = now()
       WHERE uid = $4`,
      [passwords.hash(newPassword), simhash64(newPassword), !clearMustChange, uid]
    );
    await this.pool.query('DELETE FROM password_expiry_notices WHERE uid = $1', [uid]);

    const profile = await this.getProfile(uid);
    if (this.mailer) await this.mailer.sendPasswordChanged(profile);
    return profile;
  }

  /**
   * Fingerprints to compare a CANDIDATE password against — the user's
   * current password plus their up-to-2 retired ones. Used only by the
   * self-service change-password routes; admin/CLI resets never call this,
   * which is what makes "bypassed when changing someone's password from
   * console" true.
   */
  async getPasswordFingerprints(uid) {
    const user = await this.findByUid(uid);
    if (!user) return [];
    const fingerprints = [];
    if (user.password_simhash) fingerprints.push(user.password_simhash);
    const { rows } = await this.pool.query(
      'SELECT password_simhash FROM password_history WHERE uid = $1 ORDER BY created_at DESC LIMIT 2', [uid]
    );
    for (const row of rows) if (row.password_simhash) fingerprints.push(row.password_simhash);
    return fingerprints;
  }

  async touchLogin(uid) {
    await this.pool.query('UPDATE userdata SET last_login = now() WHERE uid = $1', [uid]);
  }

  async update(uid, updates) {
    // mustChangePassword / cannotChangePassword are mutually exclusive.
    // Normalize BEFORE building the query, not by appending an extra SQL
    // fragment afterward — appending was wrong whenever the caller also
    // explicitly sent the other field in the same request (which the
    // Manage User form always does), since that assigns the same column
    // twice in one UPDATE and Postgres rejects it outright.
    const patch = { ...updates };
    if (patch.mustChangePassword === true) patch.cannotChangePassword = false;
    if (patch.cannotChangePassword === true) patch.mustChangePassword = false;

    // Split across the two tables these fields actually live in now.
    const userdataEditable = {
      fullName: 'full_name', description: 'description', theme: 'theme',
      email: 'email', disabled: 'disabled', avatarExt: 'avatar_ext',
    };
    const passwordEditable = {
      mustChangePassword: 'must_change_password', cannotChangePassword: 'cannot_change_password',
      passwordNeverExpires: 'password_never_expires', passwordExpiresAt: 'password_expires_at',
    };

    const userdataSets = []; const userdataValues = []; let ui = 1;
    for (const [key, column] of Object.entries(userdataEditable)) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) { userdataSets.push(`${column} = $${ui++}`); userdataValues.push(patch[key]); }
    }
    const passwordSets = []; const passwordValues = []; let pi = 1;
    for (const [key, column] of Object.entries(passwordEditable)) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) { passwordSets.push(`${column} = $${pi++}`); passwordValues.push(patch[key]); }
    }
    if (!userdataSets.length && !passwordSets.length) return this.getProfile(uid);

    const before = await this.findByUid(uid);
    if (!before) throw new Error('No such user');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (userdataSets.length) {
        userdataValues.push(uid);
        await client.query(`UPDATE userdata SET ${userdataSets.join(', ')}, updated_at = now() WHERE uid = $${ui}`, userdataValues);
      }
      if (passwordSets.length) {
        passwordValues.push(uid);
        await client.query(`UPDATE passwords SET ${passwordSets.join(', ')}, updated_at = now() WHERE uid = $${pi}`, passwordValues);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const profile = await this.getProfile(uid);

    // Only an explicit flip to "must change" fires the email, not every
    // profile save — and a reset that also flips this flag has already
    // gone through resetPassword() above, which leaves nothing to flip
    // here, so this never double-fires alongside "password changed".
    if (this.mailer && !before.must_change_password && profile.mustChangePassword) {
      await this.mailer.sendPasswordChangeRequired(profile);
    }
    return profile;
  }

  async rename(uid, newUsername) {
    if (!newUsername || !newUsername.trim()) throw new Error('New username cannot be empty');
    const existing = await this.findByUsername(newUsername);
    if (existing && existing.uid !== uid) throw new Error('That username is already taken');
    const { rowCount } = await this.pool.query(
      'UPDATE usernames SET username = $1, updated_at = now() WHERE uid = $2',
      [newUsername.trim(), uid]
    );
    if (!rowCount) throw new Error('No such user');
    return this.getProfile(uid);
  }

  /** Cascades to usernames/passwords/userdata (and sessions, password_history, etc.) via their FKs to users(uid). */
  async remove(uid) {
    const { rowCount } = await this.pool.query('DELETE FROM users WHERE uid = $1', [uid]);
    if (!rowCount) throw new Error('No such user');
  }

  async isEmpty() {
    const { rows } = await this.pool.query('SELECT 1 FROM users LIMIT 1');
    return rows.length === 0;
  }

  /** Guards against locking everyone out — there must always be at least one enabled sysadmin. */
  async countSysadmins() {
    const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM userdata WHERE role = 'systemAdministrator' AND disabled = false");
    return rows[0].n;
  }

  /** Enabled accounts with an actual expiry date set, for the hourly expiry sweep in server.js. */
  async listWithPasswordExpiry() {
    const { rows } = await this.pool.query(
      `${JOINED_SELECT} WHERE d.disabled = false AND p.password_never_expires = false AND p.password_expires_at IS NOT NULL`
    );
    return rows;
  }

  async getExpiryNotice(uid) {
    const { rows } = await this.pool.query('SELECT * FROM password_expiry_notices WHERE uid = $1', [uid]);
    return rows[0] || null;
  }

  async markExpirySoonNotified(uid) {
    await this.pool.query(
      `INSERT INTO password_expiry_notices (uid, expiry_soon_sent_at) VALUES ($1, now())
       ON CONFLICT (uid) DO UPDATE SET expiry_soon_sent_at = now()`, [uid]
    );
  }

  async markExpiredNotified(uid) {
    await this.pool.query(
      `INSERT INTO password_expiry_notices (uid, expired_sent_at) VALUES ($1, now())
       ON CONFLICT (uid) DO UPDATE SET expired_sent_at = now()`, [uid]
    );
  }
}

module.exports = { UserStore, toProfile, isPasswordExpired };
