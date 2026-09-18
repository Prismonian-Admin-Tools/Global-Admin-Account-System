'use strict';

class FailedLoginStore {
  constructor(pool, { maxAttempts, windowMinutes, lockoutMinutes }) {
    this.pool = pool;
    this.maxAttempts = maxAttempts;
    this.windowMinutes = windowMinutes;
    this.lockoutMinutes = lockoutMinutes;
  }

  /**
   * Both /session/login and /api/v1/login reach this on every bad attempt
   * with NO authentication at all — username and userAgent are entirely
   * attacker-controlled free text with no length limit otherwise. Capped
   * here so one request can't write an unreasonably large row.
   */
  async record({ username, appId, ip, userAgent, reason }) {
    await this.pool.query(
      'INSERT INTO failed_logins (username, app_id, ip, user_agent, reason) VALUES ($1, $2, $3, $4, $5)',
      [
        username ? String(username).slice(0, 200) : null,
        appId || null,
        ip ? String(ip).slice(0, 100) : null,
        userAgent ? String(userAgent).slice(0, 500) : null,
        reason || null,
      ]
    );
  }

  /**
   * Checked BEFORE attempting a verify, keyed on (username, ip) together
   * — so a botnet spraying one username from many IPs and a single IP
   * spraying many usernames both eventually trip it, without one bad
   * actor locking out everyone who shares a NAT'd IP. Also counts
   * bad-mfa-code: someone who has the real password but not the second
   * factor is still a login attacker, and without this a stolen password
   * alone would let them retry TOTP guesses forever, unbounded by the
   * per-ticket attempt cap in mfaChallengeStore (just request a new
   * ticket via /login each time it runs out).
   */
  async isLocked(username, ip) {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n, max(created_at) AS last
       FROM failed_logins
       WHERE lower(username) = lower($1) AND ip = $2
         AND created_at > now() - ($3 || ' minutes')::interval
         AND reason IN ('bad-credentials', 'bad-mfa-code')`,
      [username || '', ip || '', String(this.windowMinutes)]
    );
    const n = rows[0].n;
    if (n < this.maxAttempts) return { locked: false };
    const lockedUntil = new Date(new Date(rows[0].last).getTime() + this.lockoutMinutes * 60 * 1000);
    if (Date.now() > lockedUntil.getTime()) return { locked: false };
    return { locked: true, retryAfterSeconds: Math.ceil((lockedUntil.getTime() - Date.now()) / 1000) };
  }

  async list(limit = 50) {
    const { rows } = await this.pool.query(
      'SELECT * FROM failed_logins ORDER BY created_at DESC LIMIT $1', [limit]
    );
    return rows;
  }

  /** Clears the recorded attempts for one username — immediately lifts any active lockout on it. Returns how many rows were removed. */
  async clear(username) {
    const { rowCount } = await this.pool.query(
      'DELETE FROM failed_logins WHERE lower(username) = lower($1)', [username]
    );
    return rowCount;
  }

  /** Clears every recorded attempt for every username — also wipes the Activity tab's "Failed sign-ins" history, not just active lockouts. */
  async clearAll() {
    const { rowCount } = await this.pool.query('DELETE FROM failed_logins');
    return rowCount;
  }

  /**
   * Bounds long-term table growth. isLocked() only ever looks back
   * windowMinutes, so nothing functional depends on a row older than
   * that — but with no retention policy at all, an anonymous caller who
   * never gets close to a real account (spraying garbage usernames, each
   * good for maxAttempts rows before it locks out on its own) can still
   * grow this table without bound over time. Run periodically, not
   * inline with every request.
   */
  async deleteOlderThan(days) {
    const { rowCount } = await this.pool.query(
      `DELETE FROM failed_logins WHERE created_at < now() - ($1 || ' days')::interval`, [String(days)]
    );
    return rowCount;
  }
}

module.exports = { FailedLoginStore };
