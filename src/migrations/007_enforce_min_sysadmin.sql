-- Enforces "at least one enabled systemAdministrator must always exist" at
-- the database level. Previously this was only checked in application
-- code (src/routes/users.js, scripts/gus-cli.js) as a read-then-act
-- sequence: count sysadmins, then demote/disable/delete if count > 1. Two
-- concurrent requests can both read "more than one left" before either
-- one's change commits, and together leave zero — permanently locking
-- everyone out of administration. A trigger sees every code path (web
-- routes, the CLI, anything added later) atomically, which an
-- application-level check can't.
--
-- Takes a fixed advisory lock before counting, so two concurrent
-- sysadmin-removing changes serialize against a single lock rather than
-- against each other's row locks (which, for the specific case of the
-- last two sysadmins being changed at once, would otherwise deadlock).

CREATE OR REPLACE FUNCTION enforce_min_one_sysadmin() RETURNS trigger AS $$
DECLARE
  remaining INTEGER;
  was_qualifying BOOLEAN;
  still_qualifying BOOLEAN;
BEGIN
  was_qualifying := (OLD.role = 'systemAdministrator' AND OLD.disabled = false);
  IF NOT was_qualifying THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    still_qualifying := false;
  ELSE
    still_qualifying := (NEW.role = 'systemAdministrator' AND NEW.disabled = false);
  END IF;
  IF still_qualifying THEN
    RETURN NEW;
  END IF;

  -- This row was a qualifying sysadmin and, after this change, won't be —
  -- confirm at least one other one exists before allowing it.
  PERFORM pg_advisory_xact_lock(847362951);
  SELECT count(*) INTO remaining FROM userdata
    WHERE role = 'systemAdministrator' AND disabled = false AND uid <> OLD.uid;
  IF remaining = 0 THEN
    RAISE EXCEPTION 'Cannot remove the last remaining sysadmin account';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_min_one_sysadmin ON userdata;
CREATE TRIGGER trg_enforce_min_one_sysadmin
  BEFORE UPDATE OR DELETE ON userdata
  FOR EACH ROW EXECUTE FUNCTION enforce_min_one_sysadmin();
