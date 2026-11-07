'use strict';

// Public shape — what the signed-out login screen gets from GET /api/branding.
function toSafe(row) {
  if (!row) return { siteName: 'GAM', logoExt: null };
  return { siteName: row.site_name, logoExt: row.logo_ext };
}

// Everything, including the organization details used in emails. Admin
// (manageBranding) and server-side use only — see routes/branding.js.
function toFull(row) {
  return { ...toSafe(row), orgName: (row && row.org_name) || '', supportEmail: (row && row.support_email) || '' };
}

const EMAIL_RE = /^[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[^\s@<>"'(),;:]+$/;

class SiteSettingsStore {
  constructor(pool) {
    this.pool = pool;
  }

  async get() {
    const { rows } = await this.pool.query('SELECT * FROM site_settings WHERE id = 1');
    return toSafe(rows[0]);
  }

  async getFull() {
    const { rows } = await this.pool.query('SELECT * FROM site_settings WHERE id = 1');
    return toFull(rows[0]);
  }

  /** Returns the public shape, like get(). */
  async update({ siteName, logoExt, orgName, supportEmail }) {
    const sets = [];
    const values = [];
    let i = 1;
    if (siteName !== undefined) { sets.push(`site_name = $${i++}`); values.push(String(siteName).slice(0, 60) || 'GAM'); }
    if (logoExt !== undefined) { sets.push(`logo_ext = $${i++}`); values.push(logoExt); }
    if (orgName !== undefined) { sets.push(`org_name = $${i++}`); values.push(String(orgName || '').trim().slice(0, 100)); }
    if (supportEmail !== undefined) {
      const email = String(supportEmail || '').trim();
      if (email && (email.length > 254 || !EMAIL_RE.test(email))) throw new Error('Support email address is not a valid email address');
      sets.push(`support_email = $${i++}`); values.push(email);
    }
    if (sets.length) {
      await this.pool.query(`UPDATE site_settings SET ${sets.join(', ')}, updated_at = now() WHERE id = 1`, values);
    }
    return this.get();
  }
}

module.exports = { SiteSettingsStore };
