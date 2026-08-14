'use strict';
const crypto = require('crypto');

// Opaque tokens/app secrets are high-entropy random strings, not
// low-entropy human passwords — bcrypt would be needlessly slow for a
// lookup that happens on every single request. SHA-256 gives a fast,
// deterministic index while still meaning a stolen DB doesn't hand over
// usable tokens directly.
function generate(prefix, byteLength = 32) {
  const raw = crypto.randomBytes(byteLength).toString('base64url');
  return prefix ? `${prefix}_${raw}` : raw;
}

function fingerprint(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

module.exports = { generate, fingerprint };
