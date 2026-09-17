-- Phase 2: password policy engine + history, per-user email addresses,
-- SMTP notifications, and unknown-logon-point detection.

ALTER TABLE ranks ADD COLUMN IF NOT EXISTS manage_password_policy BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ranks ADD COLUMN IF NOT EXISTS manage_email BOOLEAN NOT NULL DEFAULT false;

-- One row per rule INSTANCE (not per rule TYPE), so the same rule type
-- (e.g. minCount) can be used more than once with different params (e.g.
-- a letters minimum AND a separate lowercase minimum), and admins can
-- add/remove/disable instances without any code change. New rule TYPES
-- are added in src/utils/passwordPolicy.js; this table just configures
-- instances of whatever types exist.
CREATE TABLE IF NOT EXISTS password_policy_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        TEXT NOT NULL,
  label       TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  params      JSONB NOT NULL DEFAULT '{}',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO password_policy_rules (type, label, params, sort_order) VALUES
  ('noYears',      'No years',                          '{"minYear": 1900, "maxYear": 2099}', 0),
  ('minCount',     '2 symbols minimum',                  '{"charset": "symbols", "min": 2}',    1),
  ('minCount',     '3 numbers minimum',                  '{"charset": "numbers", "min": 3}',    2),
  ('minCount',     '5 letters minimum',                  '{"charset": "letters", "min": 5}',    3),
  ('minCount',     '1 uppercase letter',                 '{"charset": "uppercase", "min": 1}',  4),
  ('noSpaces',     'No spaces',                          '{}',                                  5),
  ('notSimilarTo', 'Not 70% similar to "password"',      '{"values": ["password"], "threshold": 0.7}', 6)
ON CONFLICT DO NOTHING;

ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;

-- A password can never be un-hashed to compare it letter-by-letter
-- against a NEW password, so "70% similar to your last two passwords"
-- needs something bcrypt can't give us: a fuzzy fingerprint computed
-- once, at set-time, while the plaintext is still in memory. password_simhash
-- is a 64-bit SimHash over the password's character bigrams — enough to
-- estimate similarity between two passwords via Hamming distance, but
-- (unlike encryption) not reversible back to the original string. It is
-- still MORE information than a cryptographic hash reveals, which is the
-- unavoidable cost of this feature; see README's security notes.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_simhash TEXT;

-- The two most recently retired passwords per user, kept only for the
-- history-similarity check above — trimmed to 2 rows per uid by the
-- application layer on every password change.
CREATE TABLE IF NOT EXISTS password_history (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uid               UUID NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  password_hash     TEXT NOT NULL,
  password_simhash  TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_history_uid ON password_history(uid, created_at DESC);

-- Tracks whether we've already sent the one-time "expiring soon" /
-- "expired" notice for a user's CURRENT password, so the hourly sweep
-- (see server.js) doesn't re-email them every run. Cleared whenever the
-- password actually changes.
CREATE TABLE IF NOT EXISTS password_expiry_notices (
  uid                 UUID PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  expiry_soon_sent_at TIMESTAMPTZ,
  expired_sent_at     TIMESTAMPTZ
);

-- IPs GAM has already seen a successful login from, per user. The first
-- IP a brand-new account logs in from isn't "unknown" — there's nothing
-- to compare it to yet — but any IP after that which isn't already in
-- this table triggers the "Unknown logon point" email.
CREATE TABLE IF NOT EXISTS known_logins (
  uid         UUID NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  ip          TEXT NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (uid, ip)
);

-- Single-row SMTP configuration, editable at runtime from the admin UI —
-- same pattern as site_settings. encrypted_password is AES-256-GCM
-- ciphertext (see src/utils/crypto.js), not plaintext: decrypted only in
-- memory, only when actually sending mail.
CREATE TABLE IF NOT EXISTS email_settings (
  id                  INTEGER PRIMARY KEY DEFAULT 1,
  enabled             BOOLEAN NOT NULL DEFAULT false,
  host                TEXT,
  port                INTEGER NOT NULL DEFAULT 587,
  secure              BOOLEAN NOT NULL DEFAULT true,
  username            TEXT,
  encrypted_password  TEXT,
  from_address        TEXT,
  from_name           TEXT NOT NULL DEFAULT 'GAM',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT email_settings_single_row CHECK (id = 1)
);
INSERT INTO email_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
