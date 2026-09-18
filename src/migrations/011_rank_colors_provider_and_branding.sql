-- Per-rank color, shown wherever a rank badge renders — sysadmins can
-- restyle any rank's color (including the locked stock ones) from the
-- Ranks tab; see src/models/rankStore.js.
ALTER TABLE ranks ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#8b93a1';

-- Default colors for the four stock ranks — distinct at a glance, applied
-- once here so existing installs get them too, not just fresh ones.
UPDATE ranks SET color = '#ff8a3d' WHERE name = 'systemAdministrator';
UPDATE ranks SET color = '#5b9dd9' WHERE name = 'trustedInstaller';
UPDATE ranks SET color = '#a58bd9' WHERE name = 'elevatedStaff';
UPDATE ranks SET color = '#8b93a1' WHERE name = 'staff';

-- trustedInstaller ("Provider") is no longer the zero-capability
-- install-engineer rank — it's now a second full-access rank, alongside
-- systemAdministrator, for the bootstrap account (see scripts/bootstrap.js
-- and rankStore.js's HARDCODED_CAPABILITIES, which is what actually
-- enforces this — this UPDATE just keeps the stored row from disagreeing
-- with it).
UPDATE ranks SET
  manage_users = true, manage_ranks = true, manage_apps = true, view_activity = true,
  manage_branding = true, manage_password_policy = true, manage_email = true
WHERE name = 'trustedInstaller';

-- Default permissions for the two non-locked stock ranks, previously all
-- false for both. elevatedStaff can help run day-to-day user support;
-- staff stays at baseline (no admin-panel capabilities) until a sysadmin
-- grants some explicitly.
UPDATE ranks SET manage_users = true, view_activity = true WHERE name = 'elevatedStaff';

-- Passport (formerly GAM, formerly GUS).
ALTER TABLE site_settings ALTER COLUMN site_name SET DEFAULT 'Passport';
UPDATE site_settings SET site_name = 'Passport' WHERE site_name = 'GAM';
ALTER TABLE email_settings ALTER COLUMN from_name SET DEFAULT 'Passport';
UPDATE email_settings SET from_name = 'Passport' WHERE from_name = 'GAM';

-- Now that trustedInstaller (Provider) has every capability too, the
-- "last remaining admin" trigger from migration 007 has to protect
-- BOTH full-capability ranks, not just systemAdministrator — otherwise
-- a system with one Provider account and zero sysadmins could have that
-- one account demoted/disabled/deleted with nothing left to administer
-- it. Same advisory-lock/atomicity rationale as 007; only the qualifying
-- role check changes.
CREATE OR REPLACE FUNCTION enforce_min_one_sysadmin() RETURNS trigger AS $$
DECLARE
  remaining INTEGER;
  was_qualifying BOOLEAN;
  still_qualifying BOOLEAN;
BEGIN
  was_qualifying := (OLD.role IN ('systemAdministrator', 'trustedInstaller') AND OLD.disabled = false);
  IF NOT was_qualifying THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    still_qualifying := false;
  ELSE
    still_qualifying := (NEW.role IN ('systemAdministrator', 'trustedInstaller') AND NEW.disabled = false);
  END IF;
  IF still_qualifying THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(847362951);
  SELECT count(*) INTO remaining FROM userdata
    WHERE role IN ('systemAdministrator', 'trustedInstaller') AND disabled = false AND uid <> OLD.uid;
  IF remaining = 0 THEN
    RAISE EXCEPTION 'Cannot remove the last remaining admin account';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
