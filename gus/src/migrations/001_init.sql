-- GUS (Global User System) initial schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The identity itself. uid is the stable, immutable key other apps store
-- against — username is just a mutable attribute on top of it.
CREATE TABLE IF NOT EXISTS users (
  uid                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username                TEXT UNIQUE NOT NULL,
  password_hash           TEXT NOT NULL,
  role                    TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'moderator')),
  full_name               TEXT NOT NULL DEFAULT '',
  description             TEXT NOT NULL DEFAULT '',
  disabled                BOOLEAN NOT NULL DEFAULT false,
  -- Every new account is created with this true — no exceptions, enforced
  -- again at the application layer in userStore.create().
  must_change_password    BOOLEAN NOT NULL DEFAULT true,
  cannot_change_password  BOOLEAN NOT NULL DEFAULT false,
  password_never_expires  BOOLEAN NOT NULL DEFAULT true,
  password_expires_at     TIMESTAMPTZ,
  theme                   TEXT NOT NULL DEFAULT 'ember',
  avatar_ext              TEXT,
  last_login              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Registered client applications (Console, Casino admin, etc). Each gets
-- its own secret — this is what proves the CALLER is a legitimate app,
-- separate from the end user's own username/password.
CREATE TABLE IF NOT EXISTS apps (
  app_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  disabled     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Opaque session tokens. We store a hash of the token, never the token
-- itself, same principle as the password. token_hash is the lookup key so
-- validating a token is a single indexed read.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash    TEXT PRIMARY KEY,
  uid           UUID NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  app_id        UUID NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Slides forward on each successful /validate call, capped by
  -- absoluteTtlDays enforced at the application layer via created_at.
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_uid ON sessions(uid);

CREATE TABLE IF NOT EXISTS failed_logins (
  id          BIGSERIAL PRIMARY KEY,
  username    TEXT,
  app_id      UUID REFERENCES apps(app_id) ON DELETE SET NULL,
  ip          TEXT,
  user_agent  TEXT,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_failed_logins_lookup ON failed_logins(username, ip, created_at);

CREATE TABLE IF NOT EXISTS activity_log (
  id          BIGSERIAL PRIMARY KEY,
  category    TEXT NOT NULL,
  message     TEXT NOT NULL,
  actor_uid   UUID REFERENCES users(uid) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
