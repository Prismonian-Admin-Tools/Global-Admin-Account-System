'use strict';
const passwords = require('../utils/passwords');
const { simhash64 } = require('../utils/passwordPolicy');

// Column -> API field name mapping. This is the ONLY place that decides
// what "all their user data" means when handed to an app — never include
// password_hash or password_simhash here.
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
  };
}

function isPasswordExpired(row) {
  if (row.password_never_expires) return false;
  if (!row.password_expires_at) return false;
  return Date.now() > new Date(row.password_expires_at).getTime();
}

class UserStore {
  constructor(pool, rankStore, mailer = null) {
    this.pool = pool;
    this.rankStore = rankStore;
    this.mailer = mailer;
  }

  async findByUsername(username) {
    const { rows } = await this.pool.query(
      'SELECT * FROM users WHERE lower(username) = lower($1)', [username || '']
    );
    return rows[0] || null;
  }

  async findByUid(uid) {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE uid = $1', [uid]);
    return rows[0] || null;
  }

  async list() {
    const { rows } = await this.pool.query('SELECT * FROM users ORDER BY username ASC');
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

  /** New accounts always start forced to change their password — no flag to opt out of this. */
  async create({ username, password, role, fullName, description, email }) {
    if (!(await this.rankStore.exists(role))) throw new Error('Invalid role');
    if (!username || !username.trim()) throw new Error('Username is required');
    if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');

    const existing = await this.findByUsername(username);
    if (existing) throw new Error('A user with that username already exists');

    const { rows } = await this.pool.query(
      `INSERT INTO users (username, password_hash, password_simhash, role, full_name, description, email, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true) RETURNING *`,
      [username.trim(), passwords.hash(password), simhash64(password), role, fullName || '', description || '', email || null]
    );
    const profile = toProfile(rows[0]);
    if (this.mailer) await this.mailer.sendAccountCreated(profile);
    return profile;
  }

  async setRole(uid, role) {
    if (!(await this.rankStore.exists(role))) throw new Error('Invalid role');
    const { rows } = await this.pool.query(
      'UPDATE users SET role = $1, updated_at = now() WHERE uid = $2 RETURNING *', [role, uid]
    );
    if (!rows[0]) throw new Error('No such user');
    return toProfile(rows[0]);
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

    const { rows } = await this.pool.query(
      `UPDATE users SET password_hash = $1, password_simhash = $2, must_change_password = $3, updated_at = now()
       WHERE uid = $4 RETURNING *`,
      [passwords.hash(newPassword), simhash64(newPassword), !clearMustChange, uid]
    );
    await this.pool.query('DELETE FROM password_expiry_notices WHERE uid = $1', [uid]);

    const profile = toProfile(rows[0]);
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
    await this.pool.query('UPDATE users SET last_login = now() WHERE uid = $1', [uid]);
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

    const editable = {
      fullName: 'full_name', description: 'description', theme: 'theme', email: 'email',
      disabled: 'disabled', mustChangePassword: 'must_change_password',
      cannotChangePassword: 'cannot_change_password',
      passwordNeverExpires: 'password_never_expires',
      passwordExpiresAt: 'password_expires_at', avatarExt: 'avatar_ext',
    };
    const sets = [];
    const values = [];
    let i = 1;
    for (const [key, column] of Object.entries(editable)) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        sets.push(`${column} = $${i++}`);
        values.push(patch[key]);
      }
    }
    if (!sets.length) return this.getProfile(uid);

    const before = await this.findByUid(uid);
    if (!before) throw new Error('No such user');

    values.push(uid);
    const { rows } = await this.pool.query(
      `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE uid = $${i} RETURNING *`, values
    );
    if (!rows[0]) throw new Error('No such user');
    const profile = toProfile(rows[0]);

    // Only an explicit flip to "must change" fires the email, not every
    // profile save — and a reset that also flips this flag has already
    // gone through resetPassword() above, which leaves nothing to flip
    // here, so this never double-fires alongside "password changed".
    if (this.mailer && !before.must_change_password && rows[0].must_change_password) {
      await this.mailer.sendPasswordChangeRequired(profile);
    }
    return profile;
  }

  async rename(uid, newUsername) {
    if (!newUsername || !newUsername.trim()) throw new Error('New username cannot be empty');
    const existing = await this.findByUsername(newUsername);
    if (existing && existing.uid !== uid) throw new Error('That username is already taken');
    const { rows } = await this.pool.query(
      'UPDATE users SET username = $1, updated_at = now() WHERE uid = $2 RETURNING *',
      [newUsername.trim(), uid]
    );
    if (!rows[0]) throw new Error('No such user');
    return toProfile(rows[0]);
  }

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
    const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM users WHERE role = 'systemAdministrator' AND disabled = false");
    return rows[0].n;
  }

  /** Enabled accounts with an actual expiry date set, for the hourly expiry sweep in server.js. */
  async listWithPasswordExpiry() {
    const { rows } = await this.pool.query(
      `SELECT * FROM users WHERE disabled = false AND password_never_expires = false AND password_expires_at IS NOT NULL`
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
