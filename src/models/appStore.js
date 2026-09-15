'use strict';
const tokens = require('../utils/tokens');

const AUTH_METHODS = ['gam', 'oauth', 'saml', 'oidc', 'sssd', 'kerberos'];

// 'gam' (apiV1's /login contract) and 'oidc' (routes/oidc.js) are the
// only two that actually authenticate anyone today. A bare 'oauth'
// (without OIDC on top) and 'saml' are unimplemented; 'sssd' and
// 'kerberos' are a deliberate dark release for eventual domain-logon
// support. Every non-gam value still short-circuits /api/v1/login to a
// generic failure regardless — see apiV1.js.
const DARK_AUTH_METHODS = ['oauth', 'saml', 'sssd', 'kerberos'];

function toSafe(row) {
  if (!row) return null;
  return {
    appId: row.app_id,
    slug: row.slug,
    name: row.name,
    disabled: row.disabled,
    authMethod: row.auth_method,
    redirectUris: row.redirect_uris || [],
    createdAt: row.created_at,
  };
}

function validRedirectUris(redirectUris) {
  if (!Array.isArray(redirectUris)) return false;
  return redirectUris.every((uri) => {
    try { const u = new URL(uri); return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1'; }
    catch (e) { return false; }
  });
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
  async create({ slug, name, authMethod = 'gam', redirectUris = [] }) {
    if (!slug || !slug.trim()) throw new Error('App slug is required');
    if (!AUTH_METHODS.includes(authMethod)) throw new Error('Invalid auth method');
    if (authMethod === 'oidc') {
      if (!redirectUris.length) throw new Error('An OIDC app needs at least one redirect URI');
      if (!validRedirectUris(redirectUris)) throw new Error('Redirect URIs must be https:// (or http://localhost for local testing)');
    }
    const existing = await this.findBySlug(slug);
    if (existing) throw new Error('An app with that slug already exists');

    const secret = tokens.generate('sk');
    const { rows } = await this.pool.query(
      'INSERT INTO apps (slug, name, secret_hash, auth_method, redirect_uris) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [slug.trim(), name || slug.trim(), tokens.fingerprint(secret), authMethod, redirectUris]
    );
    return { app: toSafe(rows[0]), secret };
  }

  async setAuthMethod(appId, authMethod) {
    if (!AUTH_METHODS.includes(authMethod)) throw new Error('Invalid auth method');
    const { rows } = await this.pool.query(
      'UPDATE apps SET auth_method = $1 WHERE app_id = $2 RETURNING *', [authMethod, appId]
    );
    if (!rows[0]) throw new Error('No such app');
    return toSafe(rows[0]);
  }

  async setRedirectUris(appId, redirectUris) {
    if (!validRedirectUris(redirectUris)) throw new Error('Redirect URIs must be https:// (or http://localhost for local testing)');
    const { rows } = await this.pool.query(
      'UPDATE apps SET redirect_uris = $1 WHERE app_id = $2 RETURNING *', [redirectUris, appId]
    );
    if (!rows[0]) throw new Error('No such app');
    return toSafe(rows[0]);
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

  /** A sysadmin revoking one specific user's access to one specific app, without disabling either. */
  async blockUser(appId, uid) {
    await this.pool.query(
      `INSERT INTO app_access (app_id, uid, blocked) VALUES ($1, $2, true)
       ON CONFLICT (app_id, uid) DO UPDATE SET blocked = true, updated_at = now()`,
      [appId, uid]
    );
  }

  async unblockUser(appId, uid) {
    await this.pool.query('DELETE FROM app_access WHERE app_id = $1 AND uid = $2', [appId, uid]);
  }

  async isBlocked(appId, uid) {
    const { rows } = await this.pool.query(
      'SELECT 1 FROM app_access WHERE app_id = $1 AND uid = $2 AND blocked = true', [appId, uid]
    );
    return rows.length > 0;
  }

  async listBlockedUids(appId) {
    const { rows } = await this.pool.query(
      'SELECT uid FROM app_access WHERE app_id = $1 AND blocked = true', [appId]
    );
    return rows.map((r) => r.uid);
  }
}

module.exports = { AppStore, toSafe, AUTH_METHODS, DARK_AUTH_METHODS };
