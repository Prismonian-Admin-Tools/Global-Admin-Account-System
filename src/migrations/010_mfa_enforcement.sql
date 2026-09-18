-- MFA enforcement, opt-in per app (see src/routes/apiV1.js). An app that
-- hasn't set supports_mfa_challenge keeps today's dormant behavior exactly
-- — /login never even looks at mfa_enabled for it. GAM's own frontend
-- (src/routes/session.js) always enforces MFA when it's on; it doesn't
-- need this flag since there's no third-party compatibility concern for
-- first-party code.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS supports_mfa_challenge BOOLEAN NOT NULL DEFAULT false;

-- Bridges a verified username/password to the second-factor step. Never
-- grants access by itself — only the right to attempt one TOTP or backup
-- code against the (uid, app_id) it was issued for. app_id NULL means
-- GAM's own frontend rather than a client app. attempts is capped at the
-- application layer (mfaChallengeStore.takeAttempt), not here.
CREATE TABLE IF NOT EXISTS mfa_challenges (
  ticket_hash TEXT PRIMARY KEY,
  uid UUID NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  app_id UUID REFERENCES apps(app_id) ON DELETE CASCADE,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mfa_challenges_expires ON mfa_challenges (expires_at);
