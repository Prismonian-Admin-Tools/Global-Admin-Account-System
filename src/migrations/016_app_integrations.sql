-- RESTful API integrations: external services Passport calls with an API key
-- — set from the Apps tab ("RESTful API"), see src/models/integrationStore.js.
-- One row per connected service; the key is AES-256-GCM encrypted under
-- server.encryptionKey (same as the SMTP password) and never returned by any
-- endpoint — only key_hint (its last 4 characters) is shown.
CREATE TABLE IF NOT EXISTS app_integrations (
  service            TEXT PRIMARY KEY CHECK (service IN ('rally')),
  encrypted_api_key  TEXT NOT NULL,
  key_hint           TEXT NOT NULL DEFAULT '',
  updated_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
