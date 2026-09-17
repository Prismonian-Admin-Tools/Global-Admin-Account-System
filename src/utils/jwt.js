'use strict';
const crypto = require('crypto');

// Signs OIDC ID tokens. Deliberately sign-only — GAM never needs to
// verify a JWT someone else handed it (there's no "log into GAM via an
// external IdP" flow; see README's Federated identity section), so the
// one class of JWT bug that matters most in general-purpose libraries
// (alg-confusion / "alg: none" during VERIFICATION) doesn't apply here.

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/** RS256-signs a JWT from a claims object and a PEM private key. Returns the compact header.payload.signature string. */
function signRS256(payload, privateKeyPem, { kid } = {}) {
  const header = { alg: 'RS256', typ: 'JWT' };
  if (kid) header.kid = kid;
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKeyPem).toString('base64url');
  return `${signingInput}.${signature}`;
}

module.exports = { signRS256 };
