'use strict';

function toSafe(row) {
  if (!row) return { siteName: 'GAM', logoExt: null };
  return { siteName: row.site_name, logoExt: row.logo_ext };
}

class SiteSettingsStore {
  constructor(pool) {
    this.pool = pool;
  }

  async get() {
    const { rows } = await this.pool.query('SELECT * FROM site_settings WHERE id = 1');
    return toSafe(rows[0]);
  }

  async update({ siteName, logoExt }) {
    const sets = [];
    const values = [];
    let i = 1;
    if (siteName !== undefined) { sets.push(`site_name = $${i++}`); values.push(String(siteName).slice(0, 60) || 'GAM'); }
    if (logoExt !== undefined) { sets.push(`logo_ext = $${i++}`); values.push(logoExt); }
    if (!sets.length) return this.get();
    await this.pool.query(`UPDATE site_settings SET ${sets.join(', ')}, updated_at = now() WHERE id = 1`, values);
    return this.get();
  }
}

module.exports = { SiteSettingsStore };
