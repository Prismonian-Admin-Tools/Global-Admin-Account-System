'use strict';
const express = require('express');

module.exports = function activityRoutes({ activityLog, failedLoginStore }) {
  const router = express.Router();

  router.get('/activity', async (req, res) => {
    res.json(await activityLog.list(50));
  });

  router.get('/failed-logins', async (req, res) => {
    res.json(await failedLoginStore.list(50));
  });

  return router;
};
