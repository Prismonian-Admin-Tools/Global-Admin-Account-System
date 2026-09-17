'use strict';
const crypto = require('crypto');

/** GAM's own RSA signing key for OIDC ID tokens — generated lazily, once, and reused for the life of the install. */
class OidcKeyStore {
  constructor(pool) {
    this.pool = pool;
  }

  async getSigningKey() {
    const { rows } = await this.pool.query('SELECT * FROM oidc_signing_keys ORDER BY created_at ASC LIMIT 1');
    if (rows.length) return rows[0];
    return this.createSigningKey();
  }

  async createSigningKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = crypto.randomBytes(8).toString('hex');
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
    const { rows } = await this.pool.query(
      `INSERT INTO oidc_signing_keys (kid, private_key, public_jwk) VALUES ($1, $2, $3)
       ON CONFLICT (kid) DO NOTHING RETURNING *`,
      [kid, privatePem, JSON.stringify(jwk)]
    );
    // Vanishingly unlikely (16 hex chars of randomness), but if two
    // requests raced to create the first key, defer to whichever won.
    if (rows[0]) return rows[0];
    return this.getSigningKey();
  }

  async jwks() {
    const { rows } = await this.pool.query('SELECT public_jwk FROM oidc_signing_keys ORDER BY created_at ASC');
    return { keys: rows.map((r) => r.public_jwk) };
  }
}

module.exports = { OidcKeyStore };
