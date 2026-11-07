'use strict';
const crypto = require('crypto');

/**
 * Single-use, expiring links emailed to a user (migration 015):
 *   reset       — the "Reset password" button in password-expiry and
 *                 change-required emails
 *   compromised — the "Wasn't you?" button in new-sign-in and password-
 *                 changed emails: signs out every session, then lets the
 *                 user set a new password
 *
 * Both let the holder set a new password WITHOUT the old one — so the link
 * itself is the credential: 256 random bits, only its SHA-256 stored, and
 * consumed atomically. Any password change on the account (from anywhere)
 * cancels every outstanding link — see userStore.resetPassword().
 *
 * The token travels in the URL fragment (/reset-password#<token>), which
 * browsers never send to the server, so it stays out of access logs,
 * proxies and Referer headers, and email link-scanners that pre-fetch URLs
 * can't trigger anything: every action is a POST made by the page.
 */
const DEFAULT_TTL_HOURS = 72;

function hash(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

class ResetLinkStore {
  constructor(pool, { ttlHours = DEFAULT_TTL_HOURS } = {}) {
    this.pool = pool;
    this.ttlHours = Number(ttlHours) > 0 ? Number(ttlHours) : DEFAULT_TTL_HOURS;
  }

  /** Returns the raw token (shown to nobody but the email). */
  async issue(uid, purpose) {
    if (!['reset', 'compromised'].includes(purpose)) throw new Error(`Unknown reset link purpose ${purpose}`);
    const token = crypto.randomBytes(32).toString('base64url');
    await this.pool.query(
      `INSERT INTO password_reset_links (token_hash, uid, purpose, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
      [hash(token), uid, purpose, this.ttlHours]
    );
    return token;
  }

  /** The link's row if it's still usable (not used, not expired), else null. */
  async find(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const { rows } = await this.pool.query(
      `SELECT * FROM password_reset_links WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [hash(token)]
    );
    return rows[0] || null;
  }

  async markSignedOut(token) {
    await this.pool.query(
      `UPDATE password_reset_links SET signed_out_at = COALESCE(signed_out_at, now())
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [hash(token)]
    );
  }

  /** Atomically uses the link up. Returns its row, or null if it was already used/expired (e.g. a double submit). */
  async consume(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const { rows } = await this.pool.query(
      `UPDATE password_reset_links SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING *`,
      [hash(token)]
    );
    return rows[0] || null;
  }

  /** Cancels every outstanding link for an account — called on any password change. */
  async revokeAllForUser(uid, client = this.pool) {
    await client.query('DELETE FROM password_reset_links WHERE uid = $1 AND used_at IS NULL', [uid]);
  }

  async deleteExpired() {
    await this.pool.query(`DELETE FROM password_reset_links WHERE expires_at < now() - interval '7 days'`);
  }
}

module.exports = { ResetLinkStore, hashResetToken: hash };
