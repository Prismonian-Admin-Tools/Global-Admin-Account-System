-- Replaces the fixed owner/admin/moderator enum with a ranks table so
-- sysadmins can create custom ranks with their own capability sets.
-- systemAdministrator and trustedInstaller are "locked" rows: their
-- capabilities can't be edited and they can't be deleted, because the
-- application layer also hardcodes their behavior (systemAdministrator
-- always has every capability, trustedInstaller always has none) — the
-- lock just keeps the stored row from lying about that.
CREATE TABLE IF NOT EXISTS ranks (
  name              TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  is_builtin        BOOLEAN NOT NULL DEFAULT false,
  locked            BOOLEAN NOT NULL DEFAULT false,
  manage_users      BOOLEAN NOT NULL DEFAULT false,
  manage_ranks      BOOLEAN NOT NULL DEFAULT false,
  manage_apps       BOOLEAN NOT NULL DEFAULT false,
  view_activity     BOOLEAN NOT NULL DEFAULT false,
  manage_branding   BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ranks (name, label, is_builtin, locked, manage_users, manage_ranks, manage_apps, view_activity, manage_branding) VALUES
  ('trustedInstaller',     'Provider',      true, true,  false, false, false, false, false),
  ('systemAdministrator',  'Sysadmin',      true, true,  true,  true,  true,  true,  true),
  ('elevatedStaff',        'ElevatedAdmins',true, false, false, false, false, false, false),
  ('staff',                'StaffUsers',    true, false, false, false, false, false, false)
ON CONFLICT (name) DO NOTHING;

-- Carry existing accounts over to the new names before the old CHECK
-- constraint (which only allows the old three values) is dropped.
UPDATE users SET role = 'systemAdministrator' WHERE role = 'owner';
UPDATE users SET role = 'elevatedStaff' WHERE role = 'admin';
UPDATE users SET role = 'staff' WHERE role = 'moderator';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_fkey FOREIGN KEY (role) REFERENCES ranks(name)
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- Which auth protocol an app's end users authenticate with. Only 'gam'
-- (this service's own username/password + opaque token contract) is
-- functional today — the rest are a dark release: the column and value
-- accept them so app records can be tagged ahead of the login/session
-- code that will actually speak those protocols.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS auth_method TEXT NOT NULL DEFAULT 'gam';
ALTER TABLE apps DROP CONSTRAINT IF EXISTS apps_auth_method_check;
ALTER TABLE apps ADD CONSTRAINT apps_auth_method_check
  CHECK (auth_method IN ('gam', 'oauth', 'saml', 'oidc', 'sssd', 'kerberos'));

-- GUS was renamed to GAM (Global Admin Account System). Only touch sites
-- that never changed the branding away from the old default name.
ALTER TABLE site_settings ALTER COLUMN site_name SET DEFAULT 'GAM';
UPDATE site_settings SET site_name = 'GAM' WHERE site_name = 'GUS';

-- Per-(app, user) access override. A GAM account is allowed into an app
-- by default; a row here with blocked = true is a sysadmin explicitly
-- revoking that one user's access to that one app without touching the
-- app-wide `apps.disabled` switch or the user's account as a whole.
CREATE TABLE IF NOT EXISTS app_access (
  app_id      UUID NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  uid         UUID NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  blocked     BOOLEAN NOT NULL DEFAULT true,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, uid)
);
