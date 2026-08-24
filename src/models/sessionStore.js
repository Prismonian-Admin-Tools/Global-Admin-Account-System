'use strict';
const tokens = require('../utils/tokens');

class SessionStore {
  constructor(pool, { idleTimeoutMinutes, absoluteTtlDays }) {
    this.pool = pool;
    this.idleTimeoutMinutes = idleTimeoutMinutes;
    this.absoluteTtlDays = absoluteTtlDays;
  }

  /** Issues a new token scoped to (uid, appId). Token is only ever returned here, in plaintext, once. */
  async issue(uid, appId) {
    const token = tokens.generate('tok');
    const expiresAt = new Date(Date.now() + this.idleTimeoutMinutes * 60 * 1000);
    await this.pool.query(
      'INSERT INTO sessions (token_hash, uid, app_id, expires_at) VALUES ($1, $2, $3, $4)',
      [tokens.fingerprint(token), uid, appId, expiresAt]
    );
    return token;
  }

  /**
   * Validates a token FOR a specific appId — a token issued to App A will
   * never validate for App B, even with the correct string, because the
   * lookup is scoped by app_id. Slides the idle window forward and
   * enforces the absolute TTL from creation.
   */
  async validate(token, appId) {
    if (!token) return null;
    const hash = tokens.fingerprint(token);
    const { rows } = await this.pool.query(
      `SELECT * FROM sessions WHERE token_hash = $1 AND app_id = $2`, [hash, appId]
    );
    const session = rows[0];
    if (!session) return null;

    const now = Date.now();
    if (now > new Date(session.expires_at).getTime()) {
      await this.revoke(token, appId);
      return null;
    }
    const absoluteCutoff = new Date(session.created_at).getTime() + this.absoluteTtlDays * 24 * 60 * 60 * 1000;
    if (now > absoluteCutoff) {
      await this.revoke(token, appId);
      return null;
    }

    const newExpiry = new Date(now + this.idleTimeoutMinutes * 60 * 1000);
    await this.pool.query(
      'UPDATE sessions SET last_seen_at = now(), expires_at = $1 WHERE token_hash = $2',
      [newExpiry, hash]
    );
    return session.uid;
  }

  async revoke(token, appId) {
    const hash = tokens.fingerprint(token);
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1 AND app_id = $2', [hash, appId]);
  }

  /**
   * Lists every active session for a user across ALL apps — this is what
   * "Active Sessions" shows. token_hash itself is safe to hand back to
   * the client: knowing the hash doesn't let anyone authenticate (the API
   * needs the raw token, not its hash), it's just used as this session's
   * id for the revoke call below.
   */
  async listForUser(uid) {
    const { rows } = await this.pool.query(
      `SELECT s.token_hash, s.app_id, a.name AS app_name, a.slug AS app_slug,
              s.created_at, s.last_seen_at, s.expires_at
       FROM sessions s JOIN apps a ON a.app_id = s.app_id
       WHERE s.uid = $1 ORDER BY s.last_seen_at DESC`,
      [uid]
    );
    return rows;
  }

  /** Revokes one specific session by its token_hash — scoped to a uid so a user can only ever kill their own sessions (unless the caller is an owner acting on someone else's, enforced at the route layer). */
  async revokeByHash(tokenHash, uid) {
    const { rowCount } = await this.pool.query(
      'DELETE FROM sessions WHERE token_hash = $1 AND uid = $2', [tokenHash, uid]
    );
    return rowCount > 0;
  }

  /** Used when an account is disabled/deleted/password-reset by an owner — kills every active session everywhere. */
  async revokeAllForUser(uid) {
    await this.pool.query('DELETE FROM sessions WHERE uid = $1', [uid]);
  }
}

module.exports = { SessionStore };
