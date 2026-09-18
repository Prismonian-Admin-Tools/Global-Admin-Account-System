'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Nothing in server.js set a CSP, X-Frame-Options, X-Content-Type-Options,
 * or HSTS — the login page and admin panel had no defense-in-depth layer
 * against script injection or clickjacking beyond "there's no XSS bug
 * today" (see the SVG-upload finding this app has since closed: a CSP
 * would have blocked exactly that class of payload from executing even
 * before the upload path itself was fixed).
 *
 * script-src is pinned to the exact inline <script> in public/index.html
 * via a hash computed from the file's own current content at startup —
 * not hand-maintained, so it never goes stale, but it also means any
 * OTHER script (an injected payload, a future accidental second inline
 * script) is blocked outright rather than allowed via 'unsafe-inline'.
 * style-src keeps 'unsafe-inline' since the page uses inline style="..."
 * throughout — style injection can't run script or call the API, so this
 * is the standard, low-risk trade-off.
 */
function computeInlineScriptHash() {
  const htmlPath = path.join(__dirname, '..', '..', 'public', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error(`Could not find an inline <script> in ${htmlPath} to hash for the CSP`);
  const digest = crypto.createHash('sha256').update(match[1], 'utf8').digest('base64');
  return `'sha256-${digest}'`;
}

function securityHeaders() {
  const scriptHash = computeInlineScriptHash();
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${scriptHash}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  return (req, res, next) => {
    res.set('Content-Security-Policy', csp);
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Only asserted over a connection Express itself considers secure
    // (respects trust proxy / X-Forwarded-Proto) — telling a browser to
    // always upgrade to HTTPS on a deployment that's intentionally
    // HTTP-only (local dev, a proxy that doesn't forward the scheme)
    // would be actively wrong, not just unnecessary.
    if (req.secure) {
      res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    }
    next();
  };
}

module.exports = { securityHeaders };
