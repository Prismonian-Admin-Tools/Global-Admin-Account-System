'use strict';
const express = require('express');
const { toProfile } = require('../models/userStore');

function clientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * The core external contract. Every response to /login is exactly one of
 * the agreed statuses for a well-formed request from a known app — 'good',
 * 'good_change_pw', 'bad', 'disabled', or 'good-no-access' (valid
 * credentials, but this app has blocked this user) — plus 'invalid_request'
 * / 'invalid_app' / 'rate_limited' for the cases outside that contract
 * (malformed body, bad app credentials, too many attempts). An app
 * registered under a non-GAM auth method always gets 'bad' here, since
 * this endpoint isn't the contract it's supposed to be using. Nothing else
 * ever comes back from this endpoint.
 */
module.exports = function apiV1Routes({ userStore, appStore, sessionStore, failedLoginStore, activityLog }) {
  const router = express.Router();

  router.post('/login', express.json(), async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({ status: 'invalid_request', error: 'username and password are required strings' });
    }

    // This endpoint IS the GAM (username+password -> opaque token) contract.
    // An app registered under any other auth method doesn't speak this
    // contract at all — it should be authenticating via that protocol's
    // own flow, not this one. Rather than reveal anything about why (a
    // valid password, a pending forced change, an OAuth-only app all look
    // identical to a caller here), every one of those cases collapses to
    // the same generic 'bad' the wrong-password case already uses.
    if (req.callingApp.auth_method !== 'gam') {
      return res.json({ status: 'bad' });
    }

    const ip = clientIp(req);
    const lock = await failedLoginStore.isLocked(username, ip);
    if (lock.locked) {
      res.set('Retry-After', String(lock.retryAfterSeconds));
      return res.status(429).json({ status: 'rate_limited', retryAfterSeconds: lock.retryAfterSeconds });
    }

    const result = await userStore.verify(username, password);

    if (result.status === 'bad' || result.status === 'disabled') {
      await failedLoginStore.record({
        username, appId: req.callingApp.app_id, ip, userAgent: req.header('user-agent'),
        reason: result.status === 'disabled' ? 'disabled' : 'bad-credentials',
      });
      if (result.status === 'disabled') {
        await activityLog.add('auth', `Blocked sign-in — "${username}" is disabled (via ${req.callingApp.slug})`, null, username);
      }
      return res.json({ status: result.status });
    }

    // 'good' or 'good_change_pw' — but a sysadmin may have blocked this
    // specific user from this specific app without disabling either one.
    // Valid credentials, no token: the account is fine, this app just
    // isn't open to it.
    if (await appStore.isBlocked(req.callingApp.app_id, result.user.uid)) {
      await activityLog.add('auth', `Blocked sign-in — "${username}" has no access to "${req.callingApp.slug}"`, result.user.uid, result.user.username);
      return res.json({ status: 'good-no-access' });
    }

    const token = await sessionStore.issue(result.user.uid, req.callingApp.app_id);
    await userStore.touchLogin(result.user.uid);
    await activityLog.add('auth', `${result.user.username} signed in via ${req.callingApp.slug}`, result.user.uid, result.user.username);

    return res.json({ status: result.status, token, user: toProfile(result.user) });
  });

  router.post('/validate', express.json(), async (req, res) => {
    const { token } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ status: 'invalid_request', error: 'token is required' });
    }
    const uid = await sessionStore.validate(token, req.callingApp.app_id);
    if (!uid) return res.json({ valid: false });

    const user = await userStore.findByUid(uid);
    if (!user || user.disabled || (await appStore.isBlocked(req.callingApp.app_id, uid))) {
      await sessionStore.revoke(token, req.callingApp.app_id);
      return res.json({ valid: false });
    }
    return res.json({ valid: true, user: toProfile(user) });
  });

  router.post('/logout', express.json(), async (req, res) => {
    const { token } = req.body || {};
    if (token) await sessionStore.revoke(token, req.callingApp.app_id);
    res.json({ ok: true });
  });

  /**
   * Used to clear a forced password change (the 'good_change_pw' path).
   * Deliberately does NOT require the current password when the account
   * is under must_change_password — that's the whole point of "forced."
   * A voluntary change (mustChangePassword already false) does require it.
   */
  router.post('/change-password', express.json(), async (req, res) => {
    const { token, currentPassword, newPassword, confirmPassword } = req.body || {};
    if (!token || !newPassword || !confirmPassword) {
      return res.status(400).json({ status: 'invalid_request', error: 'token, newPassword, and confirmPassword are required' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ status: 'invalid_request', error: 'newPassword and confirmPassword do not match' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ status: 'invalid_request', error: 'Password must be at least 8 characters' });
    }

    const uid = await sessionStore.validate(token, req.callingApp.app_id);
    if (!uid) return res.status(401).json({ status: 'invalid_token' });

    const user = await userStore.findByUid(uid);
    if (!user) return res.status(401).json({ status: 'invalid_token' });
    if (user.cannot_change_password) {
      return res.status(403).json({ status: 'forbidden', error: 'This account is not permitted to change its own password.' });
    }
    if (!user.must_change_password) {
      const { verify } = require('../utils/passwords');
      if (!verify(currentPassword, user.password_hash)) {
        return res.status(401).json({ status: 'invalid_request', error: 'Current password is incorrect' });
      }
    }

    const profile = await userStore.resetPassword(uid, newPassword, { clearMustChange: true });
    await activityLog.add('account', `${user.username} changed their password (via ${req.callingApp.slug})`, uid, user.username);
    res.json({ status: 'ok', user: profile });
  });

  /** Self-service profile update (fullName/description/theme) for the logged-in app user. */
  router.post('/update-profile', express.json(), async (req, res) => {
    const { token, fullName, description, theme } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ status: 'invalid_request', error: 'token is required' });
    }
    const uid = await sessionStore.validate(token, req.callingApp.app_id);
    if (!uid) return res.status(401).json({ status: 'invalid_token' });

    const updates = {};
    if (fullName !== undefined) updates.fullName = String(fullName).slice(0, 100);
    if (description !== undefined) updates.description = String(description).slice(0, 300);
    if (theme !== undefined && ['ember', 'ocean', 'forest', 'light'].includes(theme)) updates.theme = theme;

    const profile = await userStore.update(uid, updates);
    res.json({ status: 'ok', user: profile });
  });

  return router;
};
