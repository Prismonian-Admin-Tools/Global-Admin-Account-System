'use strict';
const crypto = require('crypto');
const totp = require('../utils/totp');
const secretBox = require('../utils/secretBox');
const passwords = require('../utils/passwords');

const BACKUP_CODE_COUNT = 8;

// Dormant by design: this store lets a user enroll in TOTP and get real
// backup codes, and src/models/userStore.js exposes mfaEnabled on every
// profile so admins can see who's enrolled — but nothing in the login
// flow (apiV1's /login, session/login) calls verifyToken() yet. See
// README's MFA section for what "dormant" means here and what enforcing
// it later would still need to decide.
class MfaStore {
  constructor(pool, sessionSecret) {
    this.pool = pool;
    this.sessionSecret = sessionSecret;
  }

  async status(uid) {
    const { rows } = await this.pool.query('SELECT mfa_enabled, mfa_secret IS NOT NULL AS has_pending FROM passwords WHERE uid = $1', [uid]);
    if (!rows.length) throw new Error('No such user');
    return { enabled: rows[0].mfa_enabled, pending: !rows[0].mfa_enabled && rows[0].has_pending };
  }

  /** Step 1: generate a new secret and store it, unconfirmed. Calling this again before confirming just replaces the pending secret. */
  async beginSetup(uid, { issuer, accountName }) {
    const secret = totp.generateSecret();
    const { rowCount } = await this.pool.query(
      'UPDATE passwords SET mfa_secret = $1, mfa_enabled = false, updated_at = now() WHERE uid = $2',
      [secretBox.encrypt(secret, this.sessionSecret), uid]
    );
    if (!rowCount) throw new Error('No such user');
    return { secret, otpauthUrl: totp.otpauthUrl(secret, { issuer, accountName }) };
  }

  /** Step 2: prove the app is actually set up correctly before turning enforcement-readiness on. Issues backup codes ONCE, like an app secret. */
  async confirmSetup(uid, token) {
    const { rows } = await this.pool.query('SELECT mfa_secret FROM passwords WHERE uid = $1', [uid]);
    if (!rows.length || !rows[0].mfa_secret) throw new Error('No MFA setup in progress — start setup first');
    const secret = secretBox.decrypt(rows[0].mfa_secret, this.sessionSecret);
    if (!totp.verifyToken(secret, token)) throw new Error('That code didn’t match — check the time on your device and try again');

    await this.pool.query('UPDATE passwords SET mfa_enabled = true, updated_at = now() WHERE uid = $1', [uid]);
    await this.pool.query('DELETE FROM mfa_backup_codes WHERE uid = $1', [uid]);

    const codes = [];
    for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
      const code = crypto.randomBytes(5).toString('hex').toUpperCase().match(/.{1,5}/g).join('-');
      codes.push(code);
      await this.pool.query('INSERT INTO mfa_backup_codes (uid, code_hash) VALUES ($1, $2)', [uid, passwords.hash(code)]);
    }
    return codes;
  }

  async disable(uid) {
    await this.pool.query('UPDATE passwords SET mfa_secret = NULL, mfa_enabled = false, updated_at = now() WHERE uid = $1', [uid]);
    await this.pool.query('DELETE FROM mfa_backup_codes WHERE uid = $1', [uid]);
  }

  /** Not called anywhere yet — here for whichever future phase wires up login enforcement, so it doesn't have to reinvent backup-code bookkeeping. */
  async verifyBackupCode(uid, code) {
    const { rows } = await this.pool.query('SELECT id, code_hash FROM mfa_backup_codes WHERE uid = $1 AND used_at IS NULL', [uid]);
    for (const row of rows) {
      if (passwords.verify(code, row.code_hash)) {
        await this.pool.query('UPDATE mfa_backup_codes SET used_at = now() WHERE id = $1', [row.id]);
        return true;
      }
    }
    return false;
  }
}

module.exports = { MfaStore };
