'use strict';
const { RallyClient } = require('./rallyClient');
const { RallySync } = require('./rallySync');
const { RallyImporter } = require('./rallyImport');

/**
 * Where Rally's API key comes from, first match wins:
 *   1. website — saved on the Apps tab ("RESTful API"), stored encrypted
 *      (IntegrationStore, migration 016). Turns Rally sync on by itself.
 *   2. env     — RALLY_API_KEY, when config.yml has rally.enabled: true
 *   3. config  — rally.apiKey, when config.yml has rally.enabled: true
 * Everything else (baseUrl, onPassportDelete, retries, user defaults, import
 * rank map) still comes from config.yml's `rally:` section, with defaults.
 */
async function resolveRallyKey({ config, integrationStore = null }) {
  if (integrationStore) {
    try {
      const key = await integrationStore.getKey('rally');
      if (key) return { apiKey: key, source: 'website' };
    } catch (err) {
      console.error('Could not read the Rally API key saved on the Apps tab:', err.message);
    }
  }
  const rally = config.rally || {};
  if (!rally.enabled) return { apiKey: null, source: null };
  if (process.env.RALLY_API_KEY) return { apiKey: process.env.RALLY_API_KEY, source: 'env' };
  if (rally.apiKey) return { apiKey: rally.apiKey, source: 'config' };
  throw new Error('rally.enabled is true but no API key is set — add one on the Apps tab (RESTful API), rally.apiKey in config.yml, or RALLY_API_KEY.');
}

function buildRallyClient(config, apiKey) {
  const rally = config.rally || {};
  return new RallyClient({
    baseUrl: rally.baseUrl || 'https://rally1.rallydev.com',
    apiKey,
    timeoutMs: (Number(rally.requestTimeoutSeconds) || 15) * 1000,
  });
}

/**
 * Builds the Rally account sync and attaches it to the UserStore, or detaches
 * it (and returns null) when Rally has no API key. Safe to call again at any
 * time — the server does, whenever the key is saved or removed on the Apps
 * tab, so the change applies without a restart. Shared by server.js, the CLI
 * and bootstrap so every path that creates/disables/deletes a Passport
 * account syncs the same way.
 */
async function setUpRallySync({ config, pool, userStore, activityLog = null, integrationStore = null }) {
  const { apiKey, source } = await resolveRallyKey({ config, integrationStore });
  if (!apiKey) {
    userStore.setAccountSync(null);
    return null;
  }
  const rally = config.rally || {};
  const defaults = rally.userDefaults || {};
  const sync = new RallySync({
    pool,
    client: buildRallyClient(config, apiKey),
    userStore,
    activityLog,
    options: {
      onPassportDelete: rally.onPassportDelete || 'disable',
      maxAttempts: Number(rally.maxAttempts) || 10,
      userDefaults: {
        ...(defaults.language ? { Language: defaults.language } : {}),
        ...(defaults.locale ? { Locale: defaults.locale } : {}),
        ...(defaults.sessionTimeout ? { sessionTimeout: Number(defaults.sessionTimeout) } : {}),
      },
    },
  });
  sync.keySource = source;
  userStore.setAccountSync(sync);
  return sync;
}

/** The Rally user importer (CLI `rally import-list` / `rally import`), on top of an enabled sync. */
function buildRallyImporter({ config, rallySync, userStore, rankStore }) {
  const roleMap = ((config.rally || {}).import || {}).roleMap || {};
  return new RallyImporter({ client: rallySync.client, rallySync, userStore, rankStore, roleMap });
}

module.exports = { setUpRallySync, buildRallyImporter, buildRallyClient, resolveRallyKey };
