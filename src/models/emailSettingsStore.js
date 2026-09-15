'use strict';
const secretBox = require('../utils/secretBox');

class EmailSettingsStore {
  constructor(pool, sessionSecret) {
    this.pool = pool;
    this.sessionSecret = sessionSecret;
  }

  /** Public shape — never includes the password itself, only whether one is on file. */
  toSafe(row) {
    if (!row) return null;
    return {
      enabled: row.enabled,
      host: row.host,
      port: row.port,
      secure: row.secure,
      username: row.username,
      hasPassword: !!row.encrypted_password,
      fromAddress: row.from_address,
      fromName: row.from_name,
      updatedAt: row.updated_at,
    };
  }

  async get() {
    const { rows } = await this.pool.query('SELECT * FROM email_settings WHERE id = 1');
    return this.toSafe(rows[0]);
  }

  /** Internal use only (the mailer) — decrypts the password to actually authenticate with the SMTP server. */
  async getForSending() {
    const { rows } = await this.pool.query('SELECT * FROM email_settings WHERE id = 1');
    const row = rows[0];
    if (!row) return null;
    return {
      enabled: row.enabled,
      host: row.host,
      port: row.port,
      secure: row.secure,
      username: row.username,
      password: row.encrypted_password ? secretBox.decrypt(row.encrypted_password, this.sessionSecret) : null,
      fromAddress: row.from_address,
      fromName: row.from_name,
    };
  }

  async update({ enabled, host, port, secure, username, password, fromAddress, fromName }) {
    const sets = [];
    const values = [];
    let i = 1;
    if (enabled !== undefined) { sets.push(`enabled = $${i++}`); values.push(!!enabled); }
    if (host !== undefined) { sets.push(`host = $${i++}`); values.push(host || null); }
    if (port !== undefined) { sets.push(`port = $${i++}`); values.push(parseInt(port, 10) || 587); }
    if (secure !== undefined) { sets.push(`secure = $${i++}`); values.push(!!secure); }
    if (username !== undefined) { sets.push(`username = $${i++}`); values.push(username || null); }
    if (password) { sets.push(`encrypted_password = $${i++}`); values.push(secretBox.encrypt(password, this.sessionSecret)); }
    if (fromAddress !== undefined) { sets.push(`from_address = $${i++}`); values.push(fromAddress || null); }
    if (fromName !== undefined) { sets.push(`from_name = $${i++}`); values.push(String(fromName || 'GAM').slice(0, 60)); }
    if (!sets.length) return this.get();
    await this.pool.query(`UPDATE email_settings SET ${sets.join(', ')}, updated_at = now() WHERE id = 1`, values);
    return this.get();
  }
}

module.exports = { EmailSettingsStore };
