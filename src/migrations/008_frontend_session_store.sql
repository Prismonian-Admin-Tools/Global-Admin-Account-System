-- Backs GAM's own frontend cookie session (connect-pg-simple) with
-- Postgres instead of express-session's default in-memory store, which
-- the library itself warns is not fit for production: every session was
-- lost on restart, and it can't be shared across more than one process.
-- Named distinctly from the existing `sessions` table, which is a
-- completely different thing — opaque tokens issued to CLIENT APPS via
-- /api/v1/login, not this frontend's own cookie session.
-- Schema matches connect-pg-simple's expected default exactly (see its
-- own table.sql) so it needs no createTableIfMissing permission at runtime.
CREATE TABLE IF NOT EXISTS frontend_sessions (
  sid     VARCHAR NOT NULL COLLATE "default",
  sess    JSON NOT NULL,
  expire  TIMESTAMP(6) NOT NULL
)
WITH (OIDS = FALSE);

ALTER TABLE frontend_sessions DROP CONSTRAINT IF EXISTS frontend_sessions_pkey;
ALTER TABLE frontend_sessions ADD CONSTRAINT frontend_sessions_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS idx_frontend_sessions_expire ON frontend_sessions (expire);
