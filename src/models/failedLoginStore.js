'use strict';

class FailedLoginStore {
  constructor(pool, { maxAttempts, windowMinutes, lockoutMinutes }) {
    this.pool = pool;
    this.maxAttempts = maxAttempts;
    this.windowMinutes = windowMinutes;
    this.lockoutMinutes = lockoutMinutes;
  }

  async record({ username, appId, ip, userAgent, reason }) {
    await this.pool.query(
      'INSERT INTO failed_logins (username, app_id, ip, user_agent, reason) VALUES ($1, $2, $3, $4, $5)',
      [username || null, appId || null, ip || null, userAgent || null, reason || null]
    );
  }

  /**
   * Checked BEFORE attempting a verify, keyed on (username, ip) together
   * — so a botnet spraying one username from many IPs and a single IP
   * spraying many usernames both eventually trip it, without one bad
   * actor locking out everyone who shares a NAT'd IP.
   */
  async isLocked(username, ip) {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n, max(created_at) AS last
       FROM failed_logins
       WHERE lower(username) = lower($1) AND ip = $2
         AND created_at > now() - ($3 || ' minutes')::interval
         AND reason = 'bad-credentials'`,
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
}

module.exports = { FailedLoginStore };
