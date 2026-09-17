'use strict';
const express = require('express');
const QRCode = require('qrcode');
const { verify: verifyPassword } = require('../utils/passwords');

/**
 * Self-service TOTP enrollment — dormant, see src/models/mfaStore.js.
 * Mounted under /api alongside account.js, same auth requirements
 * (a logged-in GAM frontend session), but kept in its own file since
 * it's a self-contained feature layered on top of an account, not a
 * core account field.
 */
module.exports = function mfaRoutes({ userStore, mfaStore }) {
  const router = express.Router();

  function myUid(req) {
    return req.session && req.session.user ? req.session.user.uid : null;
  }

  router.get('/account/mfa', async (req, res) => {
    try {
      res.json(await mfaStore.status(myUid(req)));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/account/mfa/setup', express.json(), async (req, res) => {
    try {
      const user = await userStore.findByUid(myUid(req));
      const { secret, otpauthUrl } = await mfaStore.beginSetup(myUid(req), { issuer: 'GAM', accountName: user.username });
      const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
      res.json({ ok: true, secret, otpauthUrl, qrCodeDataUrl });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/account/mfa/confirm', express.json(), async (req, res) => {
    try {
      const backupCodes = await mfaStore.confirmSetup(myUid(req), req.body?.token);
      res.json({ ok: true, backupCodes });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/account/mfa/disable', express.json(), async (req, res) => {
    try {
      const uid = myUid(req);
      const user = await userStore.findByUid(uid);
      if (!verifyPassword(req.body?.currentPassword, user.password_hash)) throw new Error('Current password is incorrect');
      await mfaStore.disable(uid);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
