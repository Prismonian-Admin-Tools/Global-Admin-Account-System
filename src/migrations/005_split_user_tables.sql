-- Splits the monolithic `users` table into three focused tables plus a
-- minimal identity anchor. `users(uid)` is left in place as exactly that
-- anchor — every other table that already references it (sessions,
-- activity_log, app_access, password_history, password_expiry_notices,
-- known_logins) keeps working unchanged, since the FK target still
-- exists with the same primary key. Only src/models/userStore.js's
-- queries change to join across the new tables; every other file talks
-- to users exclusively through UserStore, and the row shape UserStore
-- hands back is unchanged.

CREATE TABLE IF NOT EXISTS usernames (
  uid         UUID PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  username    TEXT UNIQUE NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS passwords (
  uid                     UUID PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  password_hash           TEXT NOT NULL,
  password_simhash        TEXT,
  must_change_password    BOOLEAN NOT NULL DEFAULT true,
  cannot_change_password  BOOLEAN NOT NULL DEFAULT false,
  password_never_expires  BOOLEAN NOT NULL DEFAULT true,
  password_expires_at     TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS userdata (
  uid          UUID PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  role         TEXT NOT NULL REFERENCES ranks(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  full_name    TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  email        TEXT,
  disabled     BOOLEAN NOT NULL DEFAULT false,
  theme        TEXT NOT NULL DEFAULT 'ember',
  avatar_ext   TEXT,
  last_login   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO usernames (uid, username, updated_at)
  SELECT uid, username, updated_at FROM users
  ON CONFLICT (uid) DO NOTHING;

INSERT INTO passwords (uid, password_hash, password_simhash, must_change_password, cannot_change_password, password_never_expires, password_expires_at, updated_at)
  SELECT uid, password_hash, password_simhash, must_change_password, cannot_change_password, password_never_expires, password_expires_at, updated_at FROM users
  ON CONFLICT (uid) DO NOTHING;

INSERT INTO userdata (uid, role, full_name, description, email, disabled, theme, avatar_ext, last_login, updated_at)
  SELECT uid, role, full_name, description, email, disabled, theme, avatar_ext, last_login, updated_at FROM users
  ON CONFLICT (uid) DO NOTHING;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_fkey;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key;

ALTER TABLE users
  DROP COLUMN IF EXISTS username,
  DROP COLUMN IF EXISTS password_hash,
  DROP COLUMN IF EXISTS password_simhash,
  DROP COLUMN IF EXISTS role,
  DROP COLUMN IF EXISTS full_name,
  DROP COLUMN IF EXISTS description,
  DROP COLUMN IF EXISTS email,
  DROP COLUMN IF EXISTS disabled,
  DROP COLUMN IF EXISTS must_change_password,
  DROP COLUMN IF EXISTS cannot_change_password,
  DROP COLUMN IF EXISTS password_never_expires,
  DROP COLUMN IF EXISTS password_expires_at,
  DROP COLUMN IF EXISTS theme,
  DROP COLUMN IF EXISTS avatar_ext,
  DROP COLUMN IF EXISTS last_login,
  DROP COLUMN IF EXISTS updated_at;
