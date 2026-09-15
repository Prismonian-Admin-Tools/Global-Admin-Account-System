'use strict';
const express = require('express');
const { toProfile } = require('../models/userStore');

function clientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Login for GAM's OWN frontend (a person visiting auth.prismonian.com
 * directly, not an app calling the API). Cookie-based, like the old
 * panel — this is intentionally a completely separate mechanism from the
 * opaque app tokens issued via /api/v1/login.
 */
module.exports = function sessionRoutes({ userStore, rankStore, failedLoginStore, activityLog, knownLoginStore, mailer }) {
  const router = express.Router();

  async function withCapabilities(profile) {
    return { ...profile, capabilities: await rankStore.capabilitiesFor(profile.role) };
  }

  router.post('/session/login', express.json(), async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    const ip = clientIp(req);
    const lock = await failedLoginStore.isLocked(username, ip);
    if (lock.locked) {
      res.set('Retry-After', String(lock.retryAfterSeconds));
      return res.status(429).json({ error: 'Too many attempts. Try again later.', retryAfterSeconds: lock.retryAfterSeconds });
    }

    const result = await userStore.verify(username, password);
    if (result.status === 'bad' || result.status === 'disabled') {
      await failedLoginStore.record({
        username, ip, userAgent: req.header('user-agent'),
        reason: result.status === 'disabled' ? 'disabled' : 'bad-credentials',
      });
      if (result.status === 'disabled') return res.status(403).json({ error: 'This account has been disabled.' });
      return res.status(401).json({ error: 'Incorrect username or password.' });
    }

    req.session.user = { uid: result.user.uid, username: result.user.username, role: result.user.role };
    await userStore.touchLogin(result.user.uid);
    await activityLog.add('auth', `${result.user.username} signed in to GAM`, result.user.uid, result.user.username);

    const isUnknownLogonPoint = await knownLoginStore.recordAndCheckUnknown(result.user.uid, ip);
    if (isUnknownLogonPoint) {
      await mailer.sendUnknownLogon(toProfile(result.user), { ip, appName: 'GAM' });
      await activityLog.add('auth', `${result.user.username} signed in to GAM from a new address`, result.user.uid, result.user.username);
    }

    res.json({ ok: true, profile: await withCapabilities(toProfile(result.user)), requirePasswordChange: result.status === 'good_change_pw' });
  });

  router.post('/session/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  router.get('/session', async (req, res) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    const user = await userStore.findByUid(req.session.user.uid);
    if (!user) return req.session.destroy(() => res.status(401).json({ error: 'Account no longer exists' }));
    res.json({ profile: await withCapabilities(toProfile(user)), requirePasswordChange: !!user.must_change_password });
  });

  return router;
};
