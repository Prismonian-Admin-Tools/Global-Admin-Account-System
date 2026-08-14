'use strict';
const passwords = require('../utils/passwords');

const VALID_ROLES = ['owner', 'admin', 'moderator'];

// Column -> API field name mapping. This is the ONLY place that decides
// what "all their user data" means when handed to an app — never include
// password_hash here.
function toProfile(row) {
  if (!row) return null;
  return {
    uid: row.uid,
    username: row.username,
    role: row.role,
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
  constructor(pool) {
    this.pool = pool;
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
  async create({ username, password, role, fullName, description }) {
    if (!VALID_ROLES.includes(role)) throw new Error('Invalid role');
    if (!username || !username.trim()) throw new Error('Username is required');
    if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');

    const existing = await this.findByUsername(username);
    if (existing) throw new Error('A user with that username already exists');

    const { rows } = await this.pool.query(
      `INSERT INTO users (username, password_hash, role, full_name, description, must_change_password)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING *`,
      [username.trim(), passwords.hash(password), role, fullName || '', description || '']
    );
    return toProfile(rows[0]);
  }

  async setRole(uid, role) {
    if (!VALID_ROLES.includes(role)) throw new Error('Invalid role');
    const { rows } = await this.pool.query(
      'UPDATE users SET role = $1, updated_at = now() WHERE uid = $2 RETURNING *', [role, uid]
    );
    if (!rows[0]) throw new Error('No such user');
    return toProfile(rows[0]);
  }

  async resetPassword(uid, newPassword, { clearMustChange = true } = {}) {
    if (!newPassword || newPassword.length < 8) throw new Error('Password must be at least 8 characters');
    const { rows } = await this.pool.query(
      `UPDATE users SET password_hash = $1, must_change_password = $2, updated_at = now()
       WHERE uid = $3 RETURNING *`,
      [passwords.hash(newPassword), !clearMustChange, uid]
    );
    if (!rows[0]) throw new Error('No such user');
    return toProfile(rows[0]);
  }

  async touchLogin(uid) {
    await this.pool.query('UPDATE users SET last_login = now() WHERE uid = $1', [uid]);
  }

  async update(uid, updates) {
    const editable = {
      fullName: 'full_name', description: 'description', theme: 'theme',
      disabled: 'disabled', mustChangePassword: 'must_change_password',
      cannotChangePassword: 'cannot_change_password',
      passwordNeverExpires: 'password_never_expires',
      passwordExpiresAt: 'password_expires_at', avatarExt: 'avatar_ext',
    };
    const sets = [];
    const values = [];
    let i = 1;
    for (const [key, column] of Object.entries(editable)) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        sets.push(`${column} = $${i++}`);
        values.push(updates[key]);
      }
    }
    if (!sets.length) return this.getProfile(uid);

    // mustChangePassword / cannotChangePassword are mutually exclusive,
    // same rule as the old panel — enforce server-side.
    if (updates.mustChangePassword === true) { sets.push(`cannot_change_password = false`); }
    if (updates.cannotChangePassword === true) { sets.push(`must_change_password = false`); }

    values.push(uid);
    const { rows } = await this.pool.query(
      `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE uid = $${i} RETURNING *`, values
    );
    if (!rows[0]) throw new Error('No such user');
    return toProfile(rows[0]);
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

  async countOwners() {
    const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM users WHERE role = 'owner' AND disabled = false");
    return rows[0].n;
  }
}

module.exports = { UserStore, VALID_ROLES, toProfile, isPasswordExpired };
