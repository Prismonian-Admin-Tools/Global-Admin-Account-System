'use strict';
const express = require('express');

module.exports = function appsRoutes({ appStore, activityLog }) {
  const router = express.Router();

  function actor(req) { return req.session.user.uid; }
  function actorName(req) { return req.session.user.username; }

  router.get('/apps', async (req, res) => {
    res.json(await appStore.list());
  });

  /** Returns the plaintext secret ONCE, at creation. It cannot be retrieved again — only regenerated. */
  router.post('/apps', express.json(), async (req, res) => {
    try {
      const { slug, name } = req.body || {};
      const { app, secret } = await appStore.create({ slug, name });
      await activityLog.add('apps', `${actorName(req)} registered app "${app.name}" (${app.slug})`, actor(req), actorName(req));
      res.json({ ok: true, app, secret });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/apps/:appId/regenerate-secret', async (req, res) => {
    try {
      const { app, secret } = await appStore.regenerateSecret(req.params.appId);
      await activityLog.add('apps', `${actorName(req)} regenerated the secret for "${app.name}"`, actor(req), actorName(req));
      res.json({ ok: true, app, secret });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/apps/:appId', express.json(), async (req, res) => {
    try {
      if (typeof req.body?.disabled === 'boolean') {
        const app = await appStore.setDisabled(req.params.appId, req.body.disabled);
        await activityLog.add('apps', `${actorName(req)} ${req.body.disabled ? 'disabled' : 're-enabled'} app "${app.name}"`, actor(req), actorName(req));
        return res.json({ ok: true, app });
      }
      res.status(400).json({ error: 'Nothing to update' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/apps/:appId', async (req, res) => {
    try {
      await appStore.remove(req.params.appId);
      await activityLog.add('apps', `${actorName(req)} deleted an app registration`, actor(req), actorName(req));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
