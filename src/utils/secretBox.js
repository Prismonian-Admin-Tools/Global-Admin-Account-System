'use strict';
const crypto = require('crypto');

// Encrypts values GAM must be able to read back later (an SMTP password it
// needs to actually authenticate with, the OIDC signing key) — unlike a
// user password or an app secret, these can't be one-way hashes. Callers
// pass their own key material (config.server.encryptionKey) rather than
// this module picking one, so there's a single place — the config — that
// decides what secret actually protects data at rest.
function deriveKey(keyMaterial) {
  return crypto.createHash('sha256').update(String(keyMaterial), 'utf8').digest();
}

function encrypt(plaintext, keyMaterial) {
  const key = deriveKey(keyMaterial);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decrypt(payload, keyMaterial) {
  const key = deriveKey(keyMaterial);
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Tries the primary key, then each legacy key in order, returning the
 * first successful decryption. Exists for the one-time migration off a
 * shared key (values encrypted back when this module derived its key from
 * sessionSecret) so already-stored values keep working without a manual
 * re-entry step — every new write still goes out under the primary key
 * via encrypt() above, so this is self-migrating: once every legacy-
 * encrypted value has been re-saved, the legacy key can be dropped.
 */
function decryptWithFallback(payload, primaryKey, legacyKeys = []) {
  const keys = [primaryKey, ...legacyKeys.filter(Boolean)];
  let lastErr;
  for (const key of keys) {
    try {
      return decrypt(payload, key);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('decryptWithFallback: no keys provided');
}

module.exports = { encrypt, decrypt, decryptWithFallback };
