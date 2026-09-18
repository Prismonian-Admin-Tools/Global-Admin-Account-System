-- Onboarding wizard: a new (non-trustedInstaller) account is created with
-- needs_onboarding = true and, like every other account, must_change_password
-- = true. Both get cleared together when the new hire completes the
-- onboarding form (see PUT /account/onboarding). Existing rows default to
-- false — nothing retroactively sends already-active users through this.
ALTER TABLE userdata ADD COLUMN IF NOT EXISTS needs_onboarding BOOLEAN NOT NULL DEFAULT false;
