'use strict';
const express = require('express');
const fs = require('fs');
const multer = require('multer');
const { verify: verifyPassword } = require('../utils/passwords');
const { enforcePasswordPolicy } = require('../utils/enforcePasswordPolicy');
const { matchesImageType } = require('../utils/imageSniff');

const ALLOWED_AVATAR_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

module.exports = function accountRoutes({ config, userStore, passwordPolicyStore, sessionStore, activityLog }) {
  const router = express.Router();
  fs.mkdirSync(config.avatars.directory, { recursive: true });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_AVATAR_TYPES[file.mimetype]) return cb(new Error('Only PNG, JPEG, or WEBP images are allowed'));
      cb(null, true);
    },
  });

  function myUid(req) {
    return req.session && req.session.user ? req.session.user.uid : null;
  }

  router.get('/account', async (req, res) => {
    const profile = await userStore.getProfile(myUid(req));
    if (!profile) return res.status(404).json({ error: 'Account not found' });
    res.json(profile);
  });

  router.put('/account', express.json(), async (req, res) => {
    try {
      const { fullName, description, theme } = req.body || {};
      const updates = {};
      if (fullName !== undefined) updates.fullName = String(fullName).slice(0, 100);
      if (description !== undefined) updates.description = String(description).slice(0, 300);
      if (theme !== undefined && ['ember', 'ocean', 'forest', 'light'].includes(theme)) updates.theme = theme;
      const profile = await userStore.update(myUid(req), updates);
      res.json({ ok: true, profile });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/account/password', express.json(), async (req, res) => {
    try {
      const uid = myUid(req);
      const user = await userStore.findByUid(uid);
      if (!user) return res.status(404).json({ error: 'Account not found' });
      if (user.cannot_change_password) {
        return res.status(403).json({ error: 'This account is not permitted to change its own password. Ask a sysadmin to reset it.' });
      }
      const { currentPassword, newPassword, confirmPassword } = req.body || {};
      if (!newPassword || newPassword.length < 8) throw new Error('New password must be at least 8 characters');
      if (newPassword !== confirmPassword) throw new Error('New password and confirmation do not match');
      // A forced change doesn't require the old password — that's the point of "forced."
      if (!user.must_change_password) {
        if (!verifyPassword(currentPassword, user.password_hash)) throw new Error('Current password is incorrect');
      }
      await enforcePasswordPolicy({ passwordPolicyStore, userStore, uid, password: newPassword });
      const profile = await userStore.resetPassword(uid, newPassword, { clearMustChange: true });
      await activityLog.add('account', `${user.username} changed their password`, uid, user.username);
      res.json({ ok: true, profile });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/account/avatar', upload.single('avatar'), async (req, res) => {
    try {
      const uid = myUid(req);
      if (!req.file) throw new Error('No file uploaded');
      if (!matchesImageType(req.file.buffer, req.file.mimetype)) throw new Error('File content does not match its declared image type');
      const ext = ALLOWED_AVATAR_TYPES[req.file.mimetype];
      fs.writeFileSync(`${config.avatars.directory}/${uid}.${ext}`, req.file.buffer);
      const profile = await userStore.update(uid, { avatarExt: ext });
      res.json({ ok: true, profile });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * "Active Sessions": every app currently holding a live token for this
   * account (issued via /api/v1/login), not GAM's own frontend cookie
   * session — those are separate mechanisms entirely.
   */
  router.get('/account/sessions', async (req, res) => {
    res.json(await sessionStore.listForUser(myUid(req)));
  });

  router.delete('/account/sessions/:tokenHash', async (req, res) => {
    const ok = await sessionStore.revokeByHash(req.params.tokenHash, myUid(req));
    if (!ok) return res.status(404).json({ error: 'No such session' });
    res.json({ ok: true });
  });

  router.post('/account/sessions/revoke-all', async (req, res) => {
    await sessionStore.revokeAllForUser(myUid(req));
    res.json({ ok: true });
  });

  return router;
};
