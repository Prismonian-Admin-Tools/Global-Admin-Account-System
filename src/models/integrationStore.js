'use strict';
const secretBox = require('../utils/secretBox');

/**
 * RESTful API integrations (migration 016): external services Passport calls
 * on its own behalf with an API key, connected from the Apps tab. The key is
 * encrypted at rest and only ever decrypted server-side to make the calls;
 * nothing returns it — callers see `keyHint` (last 4 characters) instead.
 *
 * SERVICES is the dropdown: add an entry here (and to the CHECK constraint in
 * a migration) when Passport gains a connector for another service.
 */
const SERVICES = {
  rally: {
    label: 'Rally (WSAPI)',
    description: 'Creates, disables and deletes each Passport user\'s Rally account. Needs an API key belonging to a Rally Subscription Administrator.',
  },
};

class IntegrationStore {
  constructor(pool, { encryptionKey } = {}) {
    if (!encryptionKey) throw new Error('IntegrationStore needs { encryptionKey } (config.server.encryptionKey)');
    this.pool = pool;
    this.encryptionKey = encryptionKey;
  }

  static services() {
    return Object.entries(SERVICES).map(([id, s]) => ({ id, ...s }));
  }

  static isService(id) {
    return Object.prototype.hasOwnProperty.call(SERVICES, id);
  }

  /** Safe listing — never includes the key. */
  async list() {
    const { rows } = await this.pool.query('SELECT service, key_hint, updated_by, created_at, updated_at FROM app_integrations ORDER BY service');
    return rows.map((r) => ({
      service: r.service, label: (SERVICES[r.service] || {}).label || r.service,
      keyHint: r.key_hint, updatedBy: r.updated_by, createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  /** The decrypted key for a service, or null if it isn't connected. Server-side use only. */
  async getKey(service) {
    const { rows } = await this.pool.query('SELECT encrypted_api_key FROM app_integrations WHERE service = $1', [service]);
    if (!rows[0]) return null;
    return secretBox.decrypt(rows[0].encrypted_api_key, this.encryptionKey);
  }

  async save(service, apiKey, actor = null) {
    if (!IntegrationStore.isService(service)) throw new Error('Unknown service');
    const key = String(apiKey || '').trim();
    if (!key) throw new Error('API key is required');
    if (key.length > 500 || /\s/.test(key)) throw new Error('That doesn\'t look like an API key (no spaces, at most 500 characters)');
    await this.pool.query(
      `INSERT INTO app_integrations (service, encrypted_api_key, key_hint, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (service) DO UPDATE SET encrypted_api_key = EXCLUDED.encrypted_api_key, key_hint = EXCLUDED.key_hint,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [service, secretBox.encrypt(key, this.encryptionKey), key.slice(-4), actor]
    );
  }

  async remove(service) {
    const { rowCount } = await this.pool.query('DELETE FROM app_integrations WHERE service = $1', [service]);
    return rowCount > 0;
  }
}

module.exports = { IntegrationStore, SERVICES };
