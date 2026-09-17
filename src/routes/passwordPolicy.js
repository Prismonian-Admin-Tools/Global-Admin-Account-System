'use strict';
const express = require('express');
const { RULE_TYPES } = require('../utils/passwordPolicy');
const { asyncHandler } = require('../middleware/asyncHandler');

module.exports = function passwordPolicyRoutes({ passwordPolicyStore, activityLog }) {
  const router = express.Router();

  function actor(req) { return req.session.user.uid; }
  function actorName(req) { return req.session.user.username; }

  router.get('/password-policy', asyncHandler(async (req, res) => {
    res.json({ rules: await passwordPolicyStore.list(), ruleTypes: Object.keys(RULE_TYPES) });
  }));

  router.post('/password-policy', express.json(), async (req, res) => {
    try {
      const { type, label, params, enabled } = req.body || {};
      const rule = await passwordPolicyStore.create({ type, label, params, enabled });
      await activityLog.add('password-policy', `${actorName(req)} added the password rule "${rule.label}"`, actor(req), actorName(req));
      res.json({ ok: true, rule });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/password-policy/:id', express.json(), async (req, res) => {
    try {
      const { label, enabled, params } = req.body || {};
      const rule = await passwordPolicyStore.update(req.params.id, { label, enabled, params });
      await activityLog.add('password-policy', `${actorName(req)} updated the password rule "${rule.label}"`, actor(req), actorName(req));
      res.json({ ok: true, rule });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/password-policy/:id', async (req, res) => {
    try {
      await passwordPolicyStore.remove(req.params.id);
      await activityLog.add('password-policy', `${actorName(req)} deleted a password rule`, actor(req), actorName(req));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
