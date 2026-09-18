'use strict';
const crypto = require('crypto');

// RFC 4226 (HOTP) / RFC 6238 (TOTP) — no external dependency, since this
// is a well-specified, self-contained algorithm: HMAC-SHA1 over a
// 30-second time counter, truncated to a 6-digit code. Checked at login
// via mfaStore.verifyLoginToken() — see mfaChallengeStore.js.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  const remainder = bits.length % 5;
  if (remainder) out += BASE32_ALPHABET[parseInt(bits.slice(-remainder).padEnd(5, '0'), 2)];
  return out;
}

function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of clean) bits += BASE32_ALPHABET.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** A fresh random secret for a new enrollment, base32-encoded (the form authenticator apps expect). */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBuffer, counter) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuffer).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

function currentCounter(atMs = Date.now()) {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

function generateToken(base32Secret, atMs) {
  return hotp(base32Decode(base32Secret), currentCounter(atMs));
}

/** Accepts the current step and one step either side, to tolerate clock drift between server and phone. */
function verifyToken(base32Secret, token, { window = 1, atMs = Date.now() } = {}) {
  if (!token || !/^\d{6}$/.test(token)) return false;
  const secretBuffer = base32Decode(base32Secret);
  const counter = currentCounter(atMs);
  for (let delta = -window; delta <= window; delta++) {
    if (hotp(secretBuffer, counter + delta) === token) return true;
  }
  return false;
}

/** The otpauth:// URL an authenticator app's QR scanner expects. */
function otpauthUrl(base32Secret, { issuer, accountName }) {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({ secret: base32Secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = { generateSecret, generateToken, verifyToken, otpauthUrl };
