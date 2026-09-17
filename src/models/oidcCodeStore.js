'use strict';
const tokens = require('../utils/tokens');

const CODE_TTL_SECONDS = 60;

/** Authorization codes from the OIDC authorization_code flow — short-lived, single-use, PKCE-bound. */
class OidcCodeStore {
  constructor(pool) {
    this.pool = pool;
  }

  async issue({ uid, appId, redirectUri, scope, nonce, codeChallenge }) {
    const code = tokens.generate('oidc_ac');
    const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000);
    await this.pool.query(
      `INSERT INTO oidc_auth_codes (code_hash, uid, app_id, redirect_uri, scope, nonce, code_challenge, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tokens.fingerprint(code), uid, appId, redirectUri, scope, nonce || null, codeChallenge, expiresAt]
    );
    return code;
  }

  /**
   * Marks the code used and returns its record, all in one statement, so
   * two simultaneous redemption attempts can't both succeed (the second
   * one's UPDATE simply matches zero rows, since `used = false` is part
   * of the WHERE clause).
   */
  async consume(code) {
    if (!code) return null;
    const { rows } = await this.pool.query(
      `UPDATE oidc_auth_codes SET used = true
       WHERE code_hash = $1 AND used = false AND expires_at > now()
       RETURNING *`,
      [tokens.fingerprint(code)]
    );
    return rows[0] || null;
  }

  /** Best-effort cleanup — nothing depends on this running promptly; expired/used rows are just never matched by consume(). */
  async deleteExpired() {
    await this.pool.query('DELETE FROM oidc_auth_codes WHERE expires_at < now()');
  }
}

module.exports = { OidcCodeStore };
