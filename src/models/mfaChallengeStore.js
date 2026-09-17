'use strict';
const tokens = require('../utils/tokens');

// 5 minutes — long enough to find a phone and type a 6-digit code, short
// enough that a leaked ticket (it proves nothing by itself, but still)
// doesn't sit around usable for long.
const CHALLENGE_TTL_SECONDS = 5 * 60;
const MAX_ATTEMPTS = 5;

/**
 * Short-lived, single-use tickets bridging a verified username/password to
 * the second-factor step — both /api/v1/login and GAM's own frontend
 * /session/login issue one instead of granting access outright when the
 * account has MFA enabled. app_id is NULL for GAM's own frontend, or the
 * calling app's id otherwise — a ticket issued for one is never valid for
 * the other. Deliberately its own table rather than reusing sessionStore
 * or oidcCodeStore: this ticket alone never authenticates anyone, only the
 * right to attempt one code.
 */
class MfaChallengeStore {
  constructor(pool) {
    this.pool = pool;
  }

  async issue(uid, appId) {
    const ticket = tokens.generate('mfa');
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000);
    await this.pool.query(
      'INSERT INTO mfa_challenges (ticket_hash, uid, app_id, expires_at) VALUES ($1, $2, $3, $4)',
      [tokens.fingerprint(ticket), uid, appId, expiresAt]
    );
    return ticket;
  }

  /**
   * Looks up a challenge and counts this call as one attempt, atomically —
   * the increment and the attempts < MAX_ATTEMPTS check happen in the same
   * UPDATE, so two concurrent guesses against the same ticket can't both
   * slip in under the limit. Returns null for a ticket that's missing,
   * expired, or has already used up its attempts; the caller still needs
   * to verify the submitted code against whatever this returns.
   */
  async takeAttempt(ticket) {
    if (!ticket) return null;
    const hash = tokens.fingerprint(ticket);
    const { rows } = await this.pool.query(
      `UPDATE mfa_challenges SET attempts = attempts + 1
       WHERE ticket_hash = $1 AND expires_at > now() AND attempts < $2
       RETURNING *`,
      [hash, MAX_ATTEMPTS]
    );
    return rows[0] || null;
  }

  /** Called once a code is accepted (or the caller gives up) — makes the ticket unusable for anything further. */
  async consume(ticket) {
    if (!ticket) return;
    await this.pool.query('DELETE FROM mfa_challenges WHERE ticket_hash = $1', [tokens.fingerprint(ticket)]);
  }

  /** Best-effort cleanup, same as oidcCodeStore.deleteExpired — nothing depends on this running promptly. */
  async deleteExpired() {
    await this.pool.query('DELETE FROM mfa_challenges WHERE expires_at < now()');
  }
}

module.exports = { MfaChallengeStore };
