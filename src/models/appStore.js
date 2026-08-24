'use strict';
const tokens = require('../utils/tokens');

function toSafe(row) {
  if (!row) return null;
  return {
    appId: row.app_id,
    slug: row.slug,
    name: row.name,
    disabled: row.disabled,
    createdAt: row.created_at,
  };
}

class AppStore {
  constructor(pool) {
    this.pool = pool;
  }

  async list() {
    const { rows } = await this.pool.query('SELECT * FROM apps ORDER BY name ASC');
    return rows.map(toSafe);
  }

  async findById(appId) {
    const { rows } = await this.pool.query('SELECT * FROM apps WHERE app_id = $1', [appId]);
    return rows[0] || null;
  }

  async findBySlug(slug) {
    const { rows } = await this.pool.query('SELECT * FROM apps WHERE lower(slug) = lower($1)', [slug || '']);
    return rows[0] || null;
  }

  /** Returns the plaintext secret ONCE — it's never retrievable again after this. */
  async create({ slug, name }) {
    if (!slug || !slug.trim()) throw new Error('App slug is required');
    const existing = await this.findBySlug(slug);
    if (existing) throw new Error('An app with that slug already exists');

    const secret = tokens.generate('sk');
    const { rows } = await this.pool.query(
      'INSERT INTO apps (slug, name, secret_hash) VALUES ($1, $2, $3) RETURNING *',
      [slug.trim(), name || slug.trim(), tokens.fingerprint(secret)]
    );
    return { app: toSafe(rows[0]), secret };
  }

  async regenerateSecret(appId) {
    const secret = tokens.generate('sk');
    const { rows } = await this.pool.query(
      'UPDATE apps SET secret_hash = $1 WHERE app_id = $2 RETURNING *',
      [tokens.fingerprint(secret), appId]
    );
    if (!rows[0]) throw new Error('No such app');
    return { app: toSafe(rows[0]), secret };
  }

  async setDisabled(appId, disabled) {
    const { rows } = await this.pool.query(
      'UPDATE apps SET disabled = $1 WHERE app_id = $2 RETURNING *', [!!disabled, appId]
    );
    if (!rows[0]) throw new Error('No such app');
    return toSafe(rows[0]);
  }

  async remove(appId) {
    const { rowCount } = await this.pool.query('DELETE FROM apps WHERE app_id = $1', [appId]);
    if (!rowCount) throw new Error('No such app');
  }

  /** Verifies the (appId, appSecret) pair a calling app presents on every API request. */
  async verify(appId, appSecret) {
    if (!appId || !appSecret) return null;
    const app = await this.findById(appId);
    if (!app || app.disabled) return null;
    if (tokens.fingerprint(appSecret) !== app.secret_hash) return null;
    return app;
  }
}

module.exports = { AppStore, toSafe };
