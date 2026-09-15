'use strict';
const express = require('express');
const crypto = require('crypto');
const { toProfile } = require('../models/userStore');
const { signRS256 } = require('../utils/jwt');

const ID_TOKEN_TTL_SECONDS = 5 * 60;
const SUPPORTED_SCOPES = ['openid', 'profile', 'email'];

/**
 * GAM as an OpenID Connect Identity Provider — for apps that can't be
 * taught the native GAM login contract (/api/v1/login) and only know
 * how to speak a standard protocol. Apps that DO support GAM keep using
 * /api/v1/login as before; this is a second, parallel front door for
 * everyone else, built entirely on infrastructure GAM already has:
 *
 * - "client_id" / "client_secret" ARE an app's existing appId/appSecret
 *   (the same pair used for X-App-Id/X-App-Secret) — no separate
 *   credential type to manage.
 * - the OIDC "access_token" IS the same opaque tok_... token issued by
 *   sessionStore for the native protocol, so an OIDC-authenticated
 *   session shows up in "Active Sessions" and can be revoked the same way.
 * - only the "id_token" (a short-lived, signed JWT asserting who just
 *   authenticated) is new — it exists purely for the initial exchange,
 *   per spec, not for ongoing API calls.
 *
 * Authorization-code flow only (no implicit/hybrid), PKCE (S256)
 * mandatory for every client. There is no consent screen: an app has to
 * be registered by a sysadmin before it can appear here at all, the same
 * trust boundary /api/v1/login already relies on.
 */
module.exports = function oidcRoutes({ config, appStore, userStore, sessionStore, oidcKeyStore, oidcCodeStore, activityLog }) {
  const router = express.Router();
  const issuer = config.server.publicUrl.replace(/\/$/, '');

  function b64url(input) {
    return Buffer.isBuffer(input) ? input.toString('base64url') : Buffer.from(input).toString('base64url');
  }

  router.get('/.well-known/openid-configuration', (req, res) => {
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/oidc/authorize`,
      token_endpoint: `${issuer}/oidc/token`,
      userinfo_endpoint: `${issuer}/oidc/userinfo`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: SUPPORTED_SCOPES,
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      claims_supported: ['sub', 'preferred_username', 'name', 'email', 'updated_at'],
    });
  });

  router.get('/.well-known/jwks.json', async (req, res) => {
    res.json(await oidcKeyStore.jwks());
  });

  function redirectWithError(res, redirectUri, state, error, description) {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    if (description) url.searchParams.set('error_description', description);
    if (state !== undefined) url.searchParams.set('state', state);
    return res.redirect(url.toString());
  }

  router.get('/oidc/authorize', async (req, res) => {
    const { response_type, client_id, redirect_uri, scope, state, nonce, code_challenge, code_challenge_method } = req.query;

    // Everything up to here can't safely redirect the browser anywhere —
    // client_id and redirect_uri are exactly what we're still validating,
    // so an error at this stage is a plain page, never a redirect.
    const app = client_id ? await appStore.findById(client_id) : null;
    if (!app || app.disabled || app.auth_method !== 'oidc') {
      return res.status(400).send('Unknown or misconfigured client_id.');
    }
    if (!redirect_uri || !(app.redirect_uris || []).includes(redirect_uri)) {
      return res.status(400).send('redirect_uri is not registered for this client.');
    }

    // From here on, redirect_uri is trusted, so errors go back to the
    // client per spec instead of dead-ending in GAM's own UI.
    if (response_type !== 'code') return redirectWithError(res, redirect_uri, state, 'unsupported_response_type');
    const scopes = (scope || '').split(/\s+/).filter(Boolean);
    if (!scopes.includes('openid')) return redirectWithError(res, redirect_uri, state, 'invalid_scope', 'the openid scope is required');
    if (!code_challenge || (code_challenge_method && code_challenge_method !== 'S256')) {
      return redirectWithError(res, redirect_uri, state, 'invalid_request', 'PKCE (S256) is required');
    }

    if (!req.session || !req.session.user) {
      return res.redirect(`/?continue=${encodeURIComponent(req.originalUrl)}`);
    }
    const user = await userStore.findByUid(req.session.user.uid);
    if (!user || user.disabled) return redirectWithError(res, redirect_uri, state, 'access_denied');
    // A pending forced password change blocks everything else in GAM's
    // own frontend already; sending them there first (rather than
    // minting a code for an account mid-forced-change) keeps that one
    // rule true everywhere, not just inside /api.
    if (user.must_change_password) {
      return res.redirect(`/?continue=${encodeURIComponent(req.originalUrl)}`);
    }

    const code = await oidcCodeStore.issue({
      uid: user.uid, appId: app.app_id, redirectUri: redirect_uri,
      scope: scopes.join(' '), nonce, codeChallenge: code_challenge,
    });
    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state !== undefined) url.searchParams.set('state', state);
    return res.redirect(url.toString());
  });

  function clientCredentialsFrom(req) {
    const authHeader = req.header('authorization') || '';
    if (authHeader.startsWith('Basic ')) {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep === -1) return { clientId: decoded, clientSecret: '' };
      return { clientId: decodeURIComponent(decoded.slice(0, sep)), clientSecret: decodeURIComponent(decoded.slice(sep + 1)) };
    }
    return { clientId: req.body.client_id, clientSecret: req.body.client_secret };
  }

  router.post('/oidc/token', express.urlencoded({ extended: false }), async (req, res) => {
    const body = req.body || {};
    if (body.grant_type !== 'authorization_code') {
      return res.status(400).json({ error: 'unsupported_grant_type' });
    }
    const { clientId, clientSecret } = clientCredentialsFrom(req);
    const app = await appStore.verify(clientId, clientSecret);
    if (!app || app.auth_method !== 'oidc') return res.status(401).json({ error: 'invalid_client' });

    const record = await oidcCodeStore.consume(body.code);
    if (!record || record.app_id !== app.app_id || record.redirect_uri !== body.redirect_uri) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    const expectedChallenge = b64url(crypto.createHash('sha256').update(body.code_verifier || '').digest());
    if (expectedChallenge !== record.code_challenge) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }

    const user = await userStore.findByUid(record.uid);
    if (!user || user.disabled) return res.status(400).json({ error: 'invalid_grant' });

    const accessToken = await sessionStore.issue(user.uid, app.app_id);
    const signingKey = await oidcKeyStore.getSigningKey();
    const now = Math.floor(Date.now() / 1000);
    const scopes = record.scope.split(' ');
    const claims = { iss: issuer, sub: user.uid, aud: app.app_id, exp: now + ID_TOKEN_TTL_SECONDS, iat: now };
    if (record.nonce) claims.nonce = record.nonce;
    if (scopes.includes('profile')) { claims.preferred_username = user.username; claims.name = user.full_name || user.username; claims.updated_at = Math.floor(new Date(user.updated_at).getTime() / 1000); }
    if (scopes.includes('email')) claims.email = user.email || null;
    const idToken = signRS256(claims, signingKey.private_key, { kid: signingKey.kid });

    await userStore.touchLogin(user.uid);
    await activityLog.add('auth', `${user.username} signed in via ${app.slug} (OIDC)`, user.uid, user.username);

    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: config.session.idleTimeoutMinutes * 60,
      id_token: idToken,
      scope: record.scope,
    });
  });

  router.get('/oidc/userinfo', async (req, res) => {
    const authHeader = req.header('authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'invalid_token' });
    }
    const session = await sessionStore.validateAny(authHeader.slice(7));
    if (!session) return res.status(401).json({ error: 'invalid_token' });
    const app = await appStore.findById(session.appId);
    if (!app || app.disabled || app.auth_method !== 'oidc') return res.status(401).json({ error: 'invalid_token' });

    const user = await userStore.findByUid(session.uid);
    if (!user || user.disabled) return res.status(401).json({ error: 'invalid_token' });
    const profile = toProfile(user);
    res.json({
      sub: profile.uid,
      preferred_username: profile.username,
      name: profile.fullName || profile.username,
      email: profile.email || undefined,
      updated_at: Math.floor(new Date(profile.updatedAt).getTime() / 1000),
    });
  });

  return router;
};
