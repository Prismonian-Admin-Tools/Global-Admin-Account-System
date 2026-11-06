-- Rally (WSAPI) account sync — see src/integrations/rally/rallySync.js.
--
-- One row per Passport account enrolled in Rally sync. Each row records
-- what Passport WANTS (desired_state) next to what Rally is last known to
-- HAVE (rally_state); the sync code's only job is to make the second match
-- the first, so a failed call is simply retried later by the background
-- sweep instead of being lost.
--
-- Deliberately NO foreign key to users(uid): when a Passport account is
-- deleted, this row has to outlive it — it's the only remaining record of
-- which Rally user to disable/delete, and of whether that has happened yet
-- (Rally may well be unreachable at the moment of deletion). username and
-- email are snapshots for the same reason: readable status after the
-- Passport row is gone.
CREATE TABLE IF NOT EXISTS rally_accounts (
  uid                UUID PRIMARY KEY,
  username           TEXT NOT NULL,
  desired_state      TEXT NOT NULL CHECK (desired_state IN ('active', 'disabled', 'deleted')),
  -- NULL = no Rally user yet (not created, or still waiting on an email address).
  rally_state        TEXT CHECK (rally_state IN ('active', 'disabled', 'deleted')),
  rally_object_id    BIGINT,
  rally_object_uuid  TEXT,
  rally_email        TEXT,
  -- true = this Passport account was matched (by email) to a Rally user
  -- that already existed, rather than Passport creating it. Passport never
  -- hard-deletes a Rally user it didn't create — see rallySync.js.
  linked_existing    BOOLEAN NOT NULL DEFAULT false,
  in_sync            BOOLEAN NOT NULL DEFAULT false,
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  last_attempt_at    TIMESTAMPTZ,
  -- Short-lived claim so the request path and the background sweep never
  -- work the same row at once (which could create two Rally users).
  locked_until       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rally_accounts_out_of_sync ON rally_accounts(in_sync) WHERE in_sync = false;
