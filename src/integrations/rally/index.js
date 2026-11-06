'use strict';
const { RallyClient } = require('./rallyClient');
const { RallySync } = require('./rallySync');

/**
 * Builds the Rally account sync from config.yml's `rally:` section and
 * attaches it to the UserStore, or returns null (and attaches nothing) when
 * Rally sync is off. Shared by server.js, the CLI and bootstrap so every
 * path that creates/disables/deletes a Passport account syncs the same way.
 *
 * The API key comes from RALLY_API_KEY if set, else rally.apiKey.
 */
function setUpRallySync({ config, pool, userStore, activityLog = null }) {
  const rally = config.rally || {};
  if (!rally.enabled) return null;

  const apiKey = process.env.RALLY_API_KEY || rally.apiKey;
  if (!apiKey) {
    throw new Error('rally.enabled is true but no API key is set — add rally.apiKey to config.yml or set RALLY_API_KEY.');
  }

  const client = new RallyClient({
    baseUrl: rally.baseUrl || 'https://rally1.rallydev.com',
    apiKey,
    timeoutMs: (Number(rally.requestTimeoutSeconds) || 15) * 1000,
  });

  const defaults = rally.userDefaults || {};
  const sync = new RallySync({
    pool,
    client,
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
  userStore.setAccountSync(sync);
  return sync;
}

module.exports = { setUpRallySync };
