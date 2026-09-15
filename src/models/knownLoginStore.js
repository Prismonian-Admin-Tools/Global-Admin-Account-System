'use strict';

/** Tracks which IPs have ever successfully logged into each account, to power the "Unknown logon point" email. */
class KnownLoginStore {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Records this (uid, ip) as seen and reports whether it's new AND the
   * user already had at least one other known IP — i.e. whether this
   * should trigger an alert. A brand-new account's very first login has
   * nothing to compare against, so it's never flagged.
   */
  async recordAndCheckUnknown(uid, ip) {
    if (!ip) return false;
    const { rows: existingRows } = await this.pool.query(
      'SELECT 1 FROM known_logins WHERE uid = $1 AND ip = $2', [uid, ip]
    );
    if (existingRows.length) {
      await this.pool.query('UPDATE known_logins SET last_seen = now() WHERE uid = $1 AND ip = $2', [uid, ip]);
      return false;
    }
    const { rows: priorCount } = await this.pool.query(
      'SELECT count(*)::int AS n FROM known_logins WHERE uid = $1', [uid]
    );
    await this.pool.query(
      'INSERT INTO known_logins (uid, ip) VALUES ($1, $2) ON CONFLICT (uid, ip) DO UPDATE SET last_seen = now()',
      [uid, ip]
    );
    return priorCount[0].n > 0;
  }
}

module.exports = { KnownLoginStore };
