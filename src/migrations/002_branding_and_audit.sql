-- Denormalize the acting username onto activity_log at write time. Without
-- this, deleting a user (ON DELETE SET NULL on actor_uid) silently erases
-- their name from every audit entry they ever produced — exactly the
-- opposite of what an audit log is for.
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS actor_username TEXT;

-- Site branding shown on the login screen and header. Single-row table
-- (not config.yml) so an owner can change it from the UI without a
-- restart — config.yml is only read once, at boot.
CREATE TABLE IF NOT EXISTS site_settings (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  site_name   TEXT NOT NULL DEFAULT 'GUS',
  logo_ext    TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT site_settings_single_row CHECK (id = 1)
);
INSERT INTO site_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_activity_log_category ON activity_log(category);
CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at);
