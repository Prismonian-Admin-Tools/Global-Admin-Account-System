-- A numeric hierarchy, separate from capabilities: who can edit whose
-- account in the Users tab. 0-255, higher outranks lower — see
-- rankStore.js for how it's enforced (and for why trustedInstaller's
-- EFFECTIVE level, used in every comparison, is actually hardcoded above
-- this entire column rather than trusted from the stored value below).
ALTER TABLE ranks ADD COLUMN IF NOT EXISTS permission_level SMALLINT NOT NULL DEFAULT 0 CHECK (permission_level BETWEEN 0 AND 255);

UPDATE ranks SET permission_level = 255 WHERE name = 'trustedInstaller';
UPDATE ranks SET permission_level = 200 WHERE name = 'systemAdministrator';
UPDATE ranks SET permission_level = 50  WHERE name = 'elevatedStaff';
UPDATE ranks SET permission_level = 0   WHERE name = 'staff';
