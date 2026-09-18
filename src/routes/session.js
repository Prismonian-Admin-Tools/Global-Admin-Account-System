'use strict';
const express = require('express');
const { toProfile, isPasswordExpired } = require('../models/userStore');
const { asyncHandler } = require('../middleware/asyncHandler');

function clientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Login for GAM's OWN frontend (a person visiting auth.prismonian.com
 * directly, not an app calling the API). Cookie-based, like the old
 * panel — this is intentionally a completely separate mechanism from the
 * opaque app tokens issued via /api/v1/login.
 */
module.exports = function sessionRoutes({ userStore, rankStore, failedLoginStore, activityLog, knownLoginStore, mailer, mfaStore, mfaChallengeStore }) {
  const router = express.Router();

  async function withCapabilities(profile) {
    const rank = await rankStore.findByName(profile.role);
    return {
      ...profile,
      capabilities: await rankStore.capabilitiesFor(profile.role),
      rankColor: rank ? rank.color : null,
      // What the Users tab uses client-side to decide which role options
      // and which rows' Manage button to even show — cosmetic only, the
      // server-side check in users.js's requireCanManage is the real gate.
      permissionLevel: rank ? rank.permissionLevel : 0,
    };
  }

  /**
   * The tail shared by /session/login (when no MFA challenge is needed)
   * and /session/login/mfa (once one is cleared) — actually establishing
   * the cookie session and everything that goes with it. Split out so a
   * stolen password without the second factor never touches any of this:
   * no session, no touchLogin, no "signed in" activity entry, no unknown-
   * logon-point email, until the real login is complete.
   */
  async function completeLogin(user, status, req, res) {
    const ip = clientIp(req);
    req.session.user = { uid: user.uid, username: user.username, role: user.role };
    await userStore.touchLogin(user.uid);
    await activityLog.add('auth', `${user.username} signed in to GAM`, user.uid, user.username);

    const isUnknownLogonPoint = await knownLoginStore.recordAndCheckUnknown(user.uid, ip);
    if (isUnknownLogonPoint) {
      await mailer.sendUnknownLogon(toProfile(user), { ip, appName: 'GAM' });
      await activityLog.add('auth', `${user.username} signed in to GAM from a new address`, user.uid, user.username);
    }

    res.json({
      ok: true,
      profile: await withCapabilities(toProfile(user)),
      requirePasswordChange: status === 'good_change_pw',
      onboardingRequired: !!user.needs_onboarding,
    });
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

    // Always enforced when enabled — unlike /api/v1/login's per-app
    // opt-in, GAM's own frontend is first-party code with no compatibility
    // concern to preserve, so there's no reason to let it stay dormant.
    if (result.user.mfa_enabled) {
      const mfaTicket = await mfaChallengeStore.issue(result.user.uid, null);
      return res.json({ mfaRequired: true, mfaTicket });
    }

    return completeLogin(result.user, result.status, req, res);
  });

  /**
   * Completes a mfaRequired challenge from /session/login. Accepts either
   * a live TOTP code or an unused backup code. A wrong code counts
   * against the same (username, ip) lockout as a wrong password — see
   * failedLoginStore.isLocked and apiV1.js's /login/mfa for why.
   */
  router.post('/session/login/mfa', express.json(), async (req, res) => {
    const { mfaTicket, token } = req.body || {};
    if (!mfaTicket || !token) return res.status(400).json({ error: 'mfaTicket and token are required' });

    const challenge = await mfaChallengeStore.takeAttempt(mfaTicket);
    if (!challenge || challenge.app_id !== null) {
      return res.status(401).json({ error: 'That code is incorrect or has expired — sign in again.' });
    }

    const user = await userStore.findByUid(challenge.uid);
    if (!user || user.disabled) {
      await mfaChallengeStore.consume(mfaTicket);
      return res.status(403).json({ error: 'This account is no longer available.' });
    }

    const ip = clientIp(req);
    if (!(await mfaStore.verifyLoginToken(challenge.uid, token))) {
      await failedLoginStore.record({ username: user.username, ip, userAgent: req.header('user-agent'), reason: 'bad-mfa-code' });
      return res.status(401).json({ error: 'That code is incorrect or has expired — sign in again.' });
    }
    await mfaChallengeStore.consume(mfaTicket);

    const status = user.must_change_password || isPasswordExpired(user) ? 'good_change_pw' : 'good';
    return completeLogin(user, status, req, res);
  });

  router.post('/session/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  router.get('/session', asyncHandler(async (req, res) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    const user = await userStore.findByUid(req.session.user.uid);
    if (!user) return req.session.destroy(() => res.status(401).json({ error: 'Account no longer exists' }));
    res.json({
      profile: await withCapabilities(toProfile(user)),
      requirePasswordChange: !!user.must_change_password,
      onboardingRequired: !!user.needs_onboarding,
    });
  }));

  return router;
};
