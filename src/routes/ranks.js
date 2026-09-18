'use strict';
const express = require('express');
const { CAPABILITIES } = require('../models/rankStore');
const { asyncHandler } = require('../middleware/asyncHandler');

module.exports = function ranksRoutes({ rankStore, activityLog, requireCapability, requireAnyCapability }) {
  const router = express.Router();

  function actor(req) { return req.session.user.uid; }
  function actorName(req) { return req.session.user.username; }

  // Reading the rank list is also how the Users tab populates its role
  // picker, so anyone who can manage users needs it too — only creating,
  // editing, or deleting a rank is restricted to manageRanks itself.
  router.get('/ranks', requireAnyCapability(['manageUsers', 'manageRanks']), asyncHandler(async (req, res) => {
    res.json({ ranks: await rankStore.list(), capabilities: CAPABILITIES });
  }));

  router.post('/ranks', requireCapability('manageRanks'), express.json(), async (req, res) => {
    try {
      const { name, label, capabilities, color, permissionLevel } = req.body || {};
      const rank = await rankStore.create({ name, label, capabilities, color, permissionLevel });
      await activityLog.add('ranks', `${actorName(req)} created rank "${rank.label}" (${rank.name})`, actor(req), actorName(req));
      res.json({ ok: true, rank });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/ranks/:name', requireCapability('manageRanks'), express.json(), async (req, res) => {
    try {
      const { label, capabilities, color, permissionLevel } = req.body || {};
      const rank = await rankStore.update(req.params.name, { label, capabilities, color, permissionLevel });
      await activityLog.add('ranks', `${actorName(req)} updated rank "${rank.label}"`, actor(req), actorName(req));
      res.json({ ok: true, rank });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/ranks/:name', requireCapability('manageRanks'), async (req, res) => {
    try {
      await rankStore.remove(req.params.name);
      await activityLog.add('ranks', `${actorName(req)} deleted rank "${req.params.name}"`, actor(req), actorName(req));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
