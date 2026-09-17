'use strict';
const crypto = require('crypto');
const secretBox = require('../utils/secretBox');

/** GAM's own RSA signing key for OIDC ID tokens — generated lazily, once, and reused for the life of the install. */
class OidcKeyStore {
  constructor(pool, encryptionKey) {
    this.pool = pool;
    this.encryptionKey = encryptionKey;
  }

  async getSigningKey() {
    const { rows } = await this.pool.query('SELECT * FROM oidc_signing_keys ORDER BY created_at ASC LIMIT 1');
    if (rows.length) return this.decrypted(rows[0]);
    return this.createSigningKey();
  }

  /**
   * The private key never left the server, but it sat in the DB in
   * plaintext — a leaked backup or a DB-level compromise handed over
   * the ability to silently forge valid ID tokens for any user,
   * indefinitely, unlike the SMTP password and MFA secret which were
   * already encrypted. If this row predates that (its private_key isn't
   * valid ciphertext for the current key), treat the stored value as the
   * plaintext PEM it actually is and migrate it in place so every read
   * after this one is encrypted — no separate migration step needed.
   */
  decrypted(row) {
    let privateKey;
    try {
      privateKey = secretBox.decrypt(row.private_key, this.encryptionKey);
    } catch (err) {
      privateKey = row.private_key;
      this.pool
        .query('UPDATE oidc_signing_keys SET private_key = $1 WHERE kid = $2', [secretBox.encrypt(privateKey, this.encryptionKey), row.kid])
        .catch((migrateErr) => console.error('Failed to migrate OIDC signing key encryption:', migrateErr.message));
    }
    return { ...row, private_key: privateKey };
  }

  async createSigningKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = crypto.randomBytes(8).toString('hex');
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
    const { rows } = await this.pool.query(
      `INSERT INTO oidc_signing_keys (kid, private_key, public_jwk) VALUES ($1, $2, $3)
       ON CONFLICT (kid) DO NOTHING RETURNING *`,
      [kid, secretBox.encrypt(privatePem, this.encryptionKey), JSON.stringify(jwk)]
    );
    // Vanishingly unlikely (16 hex chars of randomness), but if two
    // requests raced to create the first key, defer to whichever won.
    if (rows[0]) return { ...rows[0], private_key: privatePem };
    return this.getSigningKey();
  }

  async jwks() {
    const { rows } = await this.pool.query('SELECT public_jwk FROM oidc_signing_keys ORDER BY created_at ASC');
    return { keys: rows.map((r) => r.public_jwk) };
  }
}

module.exports = { OidcKeyStore };
