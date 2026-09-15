'use strict';
const crypto = require('crypto');

// Encrypts values GAM must be able to read back later (an SMTP password
// it needs to actually authenticate with) — unlike a user password or an
// app secret, this can't be a one-way hash. Keyed off sessionSecret so
// there's no separate secret to configure and lose track of; rotating
// sessionSecret does mean re-entering any encrypted values afterward.
function deriveKey(sessionSecret) {
  return crypto.createHash('sha256').update(String(sessionSecret), 'utf8').digest();
}

function encrypt(plaintext, sessionSecret) {
  const key = deriveKey(sessionSecret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decrypt(payload, sessionSecret) {
  const key = deriveKey(sessionSecret);
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
