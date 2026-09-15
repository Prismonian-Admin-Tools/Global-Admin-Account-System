-- Phase 4: GAM as an OpenID Connect Identity Provider (for apps that
-- can't be taught the native GAM login contract and only know how to
-- speak a standard protocol), plus a dormant TOTP MFA scaffold.
--
-- SAML, SSSD, and Kerberos remain a dark release — auth_method already
-- accepts those values (migration 003) but nothing implements them yet.

-- Which callback URLs an OIDC app is allowed to redirect to after
-- authorizing — checked with an exact string match, never a prefix, so
-- a registered app can't be used as an open redirect.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS redirect_uris TEXT[] NOT NULL DEFAULT '{}';

-- GAM's own RSA keypair(s) for signing OIDC ID tokens. The private key
-- never leaves the server; public_jwk is exactly what /.well-known/
-- jwks.json serves so client libraries can verify a token's signature.
-- Generated lazily on first use (see oidcKeyStore.js) rather than at
-- migration time, since generating a keypair is an application concern,
-- not a schema one.
CREATE TABLE IF NOT EXISTS oidc_signing_keys (
  kid          TEXT PRIMARY KEY,
  private_key  TEXT NOT NULL,
  public_jwk   JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Authorization codes from the OIDC authorization_code flow: short-lived
-- (minutes), single-use (consumed atomically — see oidcCodeStore.js),
-- and PKCE is mandatory (code_challenge is NOT NULL) rather than
-- optional, per current OAuth best practice for every client type.
CREATE TABLE IF NOT EXISTS oidc_auth_codes (
  code_hash              TEXT PRIMARY KEY,
  uid                    UUID NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  app_id                 UUID NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  redirect_uri           TEXT NOT NULL,
  scope                  TEXT NOT NULL,
  nonce                  TEXT,
  code_challenge         TEXT NOT NULL,
  used                   BOOLEAN NOT NULL DEFAULT false,
  expires_at             TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oidc_auth_codes_expires ON oidc_auth_codes(expires_at);

-- Dormant MFA: a user can enroll (real setup UI — see routes/mfa.js) and
-- get real backup codes, but nothing at login checks mfa_enabled yet.
-- mfa_secret is encrypted at rest the same way the SMTP password is
-- (src/utils/secretBox.js) — GAM has to read it back, in plaintext, to
-- check a submitted code, so it can't be a one-way hash.
ALTER TABLE passwords ADD COLUMN IF NOT EXISTS mfa_secret TEXT;
ALTER TABLE passwords ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS mfa_backup_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uid         UUID NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mfa_backup_codes_uid ON mfa_backup_codes(uid);
