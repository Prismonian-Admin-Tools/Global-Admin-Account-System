'use strict';
const express = require('express');
const fs = require('fs');
const multer = require('multer');
const { requireAuth, requireOwner } = require('../middleware/frontendAuth');

const ALLOWED_LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

/**
 * Mounted ONCE, early — before the global requireAuth chain — because the
 * GET needs to be reachable by a signed-out visitor (the login screen
 * shows the site name/logo before anyone's authenticated). The mutating
 * routes carry their OWN requireAuth+requireOwner right here, per-route,
 * rather than relying on being mounted after some later gate — that
 * pattern (a shared gate applied only via mount order) is exactly what
 * caused the tab-shadowing bug in Console; keeping each route
 * self-contained avoids the same class of mistake here.
 */
module.exports = function brandingRoutes({ config, siteSettingsStore, activityLog }) {
  const router = express.Router();
  const logoDir = `${config.avatars.directory}/../branding`;
  fs.mkdirSync(logoDir, { recursive: true });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_LOGO_TYPES[file.mimetype]) return cb(new Error('Only PNG, JPEG, WEBP, or SVG images are allowed'));
      cb(null, true);
    },
  });

  router.get('/branding', async (req, res) => {
    res.json(await siteSettingsStore.get());
  });

  router.put('/branding', requireAuth, requireOwner, express.json(), async (req, res) => {
    try {
      const { siteName } = req.body || {};
      const settings = await siteSettingsStore.update({ siteName });
      const actor = req.session.user.username;
      await activityLog.add('branding', `${actor} updated the site name to "${settings.siteName}"`, req.session.user.uid, actor);
      res.json({ ok: true, settings });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/branding/logo', requireAuth, requireOwner, upload.single('logo'), async (req, res) => {
    try {
      if (!req.file) throw new Error('No file uploaded');
      const ext = ALLOWED_LOGO_TYPES[req.file.mimetype];
      fs.writeFileSync(`${logoDir}/logo.${ext}`, req.file.buffer);
      const settings = await siteSettingsStore.update({ logoExt: ext });
      const actor = req.session.user.username;
      await activityLog.add('branding', `${actor} updated the site logo`, req.session.user.uid, actor);
      res.json({ ok: true, settings });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/branding/logo', requireAuth, requireOwner, async (req, res) => {
    try {
      const current = await siteSettingsStore.get();
      if (current.logoExt) {
        try { fs.unlinkSync(`${logoDir}/logo.${current.logoExt}`); } catch (e) { /* already gone */ }
      }
      const settings = await siteSettingsStore.update({ logoExt: null });
      res.json({ ok: true, settings });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
