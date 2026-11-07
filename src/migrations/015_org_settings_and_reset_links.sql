-- Organization name and support address, shown in notification emails
-- ("<Organization> has created a Passport account in your name", "Please
-- contact <support email> or reply to this email") and used as the emails'
-- Reply-To. Set from the website's Settings page. Empty = not set.
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS org_name TEXT NOT NULL DEFAULT '';
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS support_email TEXT NOT NULL DEFAULT '';

-- Single-use, expiring links emailed to a user — see
-- src/models/resetLinkStore.js:
--   reset       — "Reset password": set a new password without the old one
--   compromised — "Wasn't you?": sign out every session, then set a new
--                 password without the old one
-- Only a SHA-256 hash of the token is stored, so a database leak can't be
-- turned into working links. Rows go with the account (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS password_reset_links (
  token_hash    TEXT PRIMARY KEY,
  uid           UUID NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  purpose       TEXT NOT NULL CHECK (purpose IN ('reset', 'compromised')),
  expires_at    TIMESTAMPTZ NOT NULL,
  signed_out_at TIMESTAMPTZ,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_links_uid ON password_reset_links(uid);
CREATE INDEX IF NOT EXISTS idx_password_reset_links_expires ON password_reset_links(expires_at);
