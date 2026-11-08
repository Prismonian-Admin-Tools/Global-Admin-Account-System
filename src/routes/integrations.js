'use strict';
const express = require('express');
const { IntegrationStore } = require('../models/integrationStore');
const { RallyError } = require('../integrations/rally/rallyClient');
const { buildRallyClient, resolveRallyKey } = require('../integrations/rally');

/**
 * RESTful API integrations, from the Apps tab: pick a supported service,
 * paste its API key. Mounted behind the manageApps capability (server.js).
 * The key is write-only — no response ever contains it.
 *
 * reload(): re-reads the key and switches the matching sync on/off right
 * away (server.js), so saving or removing a key needs no restart.
 */
module.exports = function integrationRoutes({ config, integrationStore, activityLog, reload }) {
  const router = express.Router();
  const actorName = (req) => req.session.user.username;
  const actorUid = (req) => req.session.user.uid;

  /** Tries a key against the service. Returns { ok, account, warning } or throws a user-facing Error. */
  async function test(service, apiKey) {
    if (service === 'rally') {
      try {
        const me = await buildRallyClient(config, apiKey).currentUser();
        const admin = me.SubscriptionAdmin === true || me.SubscriptionPermission === 'Subscription Admin';
        return {
          ok: true,
          account: me.UserName || me.EmailAddress || me.DisplayName || String(me.ObjectID),
          warning: admin ? null : 'This key works, but its Rally user isn\'t a Subscription Administrator, so Passport won\'t be able to create Rally users with it.',
        };
      } catch (err) {
        if (err instanceof RallyError) {
          throw new Error(err.status === 401 || err.status === 403 ? 'Rally rejected this API key.' : `Couldn't reach Rally: ${err.message}`);
        }
        throw err;
      }
    }
    throw new Error('Unknown service');
  }

  router.get('/integrations', async (req, res) => {
    const saved = await integrationStore.list();
    // A key still coming from config.yml / RALLY_API_KEY shows up too, so the
    // tab reflects what's actually in use.
    let rallySource = null;
    try { rallySource = (await resolveRallyKey({ config, integrationStore })).source; } catch { rallySource = 'config-missing-key'; }
    res.json({
      services: IntegrationStore.services(),
      integrations: saved,
      fallbacks: rallySource && rallySource !== 'website' ? [{ service: 'rally', source: rallySource }] : [],
    });
  });

  /** Test a key before saving it (body.apiKey), or the saved one (no body). */
  router.post('/integrations/:service/test', express.json(), async (req, res) => {
    try {
      const { service } = req.params;
      if (!IntegrationStore.isService(service)) return res.status(404).json({ error: 'Unknown service' });
      let apiKey = (req.body && req.body.apiKey) ? String(req.body.apiKey).trim() : null;
      if (!apiKey) apiKey = await integrationStore.getKey(service);
      if (!apiKey && service === 'rally') apiKey = (await resolveRallyKey({ config, integrationStore })).apiKey;
      if (!apiKey) throw new Error('Enter an API key to test.');
      res.json(await test(service, apiKey));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/integrations/:service', express.json(), async (req, res) => {
    try {
      const { service } = req.params;
      if (!IntegrationStore.isService(service)) return res.status(404).json({ error: 'Unknown service' });
      const apiKey = String((req.body && req.body.apiKey) || '').trim();
      // Refuse a key the service rejects outright, rather than saving it and
      // having every sync quietly fail afterward.
      const result = await test(service, apiKey);
      await integrationStore.save(service, apiKey, actorName(req));
      await reload(service);
      await activityLog.add('apps', `${actorName(req)} connected ${service} (RESTful API) as ${result.account}`, actorUid(req), actorName(req));
      res.json({ ...result, integrations: await integrationStore.list() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/integrations/:service', async (req, res) => {
    const { service } = req.params;
    if (!IntegrationStore.isService(service)) return res.status(404).json({ error: 'Unknown service' });
    const removed = await integrationStore.remove(service);
    if (!removed) return res.status(404).json({ error: 'Not connected' });
    await reload(service);
    await activityLog.add('apps', `${actorName(req)} disconnected ${service} (RESTful API)`, actorUid(req), actorName(req));
    res.json({ ok: true });
  });

  return router;
};
