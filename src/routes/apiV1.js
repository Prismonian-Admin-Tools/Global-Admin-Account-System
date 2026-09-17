'use strict';
const express = require('express');
const { toProfile, toAppProfile, omitMfaEnabled, isPasswordExpired } = require('../models/userStore');
const { enforcePasswordPolicy } = require('../utils/enforcePasswordPolicy');

function clientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * The core external contract. Every response to /login is exactly one of
 * the agreed statuses for a well-formed request from a known app — 'good',
 * 'good_change_pw', 'bad', 'disabled', 'good-no-access' (valid credentials,
 * but this app has blocked this user), or 'good_mfa_required' (valid
 * credentials, but this account has MFA enabled and this app has opted
 * into handling that — see apps.supports_mfa_challenge and /login/mfa
 * below) — plus 'invalid_request' / 'invalid_app' / 'rate_limited' for the
 * cases outside that contract (malformed body, bad app credentials, too
 * many attempts). An app registered under a non-GAM auth method always
 * gets 'bad' here, since this endpoint isn't the contract it's supposed to
 * be using. Nothing else ever comes back from this endpoint.
 */
module.exports = function apiV1Routes({ userStore, appStore, sessionStore, failedLoginStore, activityLog, passwordPolicyStore, knownLoginStore, mailer, mfaStore, mfaChallengeStore }) {
  const router = express.Router();

  /**
   * The tail shared by /login (when no MFA challenge is needed) and
   * /login/mfa (once one is cleared) — issuing the token and everything
   * that goes with actually granting access. Split out so a stolen
   * password without the second factor never touches any of this: no
   * token, no touchLogin, no "signed in" activity entry, no unknown-
   * logon-point email, until the real login is complete.
   */
  async function finishLogin(user, status, req, res) {
    const ip = clientIp(req);
    const token = await sessionStore.issue(user.uid, req.callingApp.app_id);
    await userStore.touchLogin(user.uid);
    await activityLog.add('auth', `${user.username} signed in via ${req.callingApp.slug}`, user.uid, user.username);

    const isUnknownLogonPoint = await knownLoginStore.recordAndCheckUnknown(user.uid, ip);
    if (isUnknownLogonPoint) {
      await mailer.sendUnknownLogon(toProfile(user), { ip, appName: req.callingApp.name });
      await activityLog.add('auth', `${user.username} signed in from a new address (via ${req.callingApp.slug})`, user.uid, user.username);
    }

    return res.json({ status, token, user: toAppProfile(user) });
  }

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

    // Opt-in per app (apps.supports_mfa_challenge) — an app that hasn't
    // declared it can handle this keeps the old dormant behavior exactly:
    // mfa_enabled is never even looked at, same as before this existed.
    if (req.callingApp.supports_mfa_challenge && result.user.mfa_enabled) {
      const mfaTicket = await mfaChallengeStore.issue(result.user.uid, req.callingApp.app_id);
      return res.json({ status: 'good_mfa_required', mfaTicket });
    }

    return finishLogin(result.user, result.status, req, res);
  });

  /**
   * Completes a good_mfa_required challenge from /login. Accepts either a
   * live TOTP code or an unused backup code (mfaStore.verifyLoginToken).
   * A wrong code counts against the SAME (username, ip) lockout as a
   * wrong password (see failedLoginStore.isLocked) — someone who has a
   * real password but not the second factor is still a login attacker,
   * and without this they could just request a fresh ticket via /login
   * every time this ticket's own attempt cap runs out.
   */
  router.post('/login/mfa', express.json(), async (req, res) => {
    const { mfaTicket, token: code } = req.body || {};
    if (!mfaTicket || typeof mfaTicket !== 'string' || !code || typeof code !== 'string') {
      return res.status(400).json({ status: 'invalid_request', error: 'mfaTicket and token are required strings' });
    }

    const challenge = await mfaChallengeStore.takeAttempt(mfaTicket);
    if (!challenge || challenge.app_id !== req.callingApp.app_id) {
      return res.status(401).json({ status: 'invalid_request', error: 'That code is incorrect or has expired — sign in again.' });
    }

    const user = await userStore.findByUid(challenge.uid);
    if (!user || user.disabled) {
      await mfaChallengeStore.consume(mfaTicket);
      return res.json({ status: 'disabled' });
    }

    const ip = clientIp(req);
    if (!(await mfaStore.verifyLoginToken(challenge.uid, code))) {
      await failedLoginStore.record({
        username: user.username, appId: req.callingApp.app_id, ip, userAgent: req.header('user-agent'), reason: 'bad-mfa-code',
      });
      return res.status(401).json({ status: 'invalid_request', error: 'That code is incorrect or has expired — sign in again.' });
    }
    await mfaChallengeStore.consume(mfaTicket);

    if (await appStore.isBlocked(req.callingApp.app_id, user.uid)) {
      await activityLog.add('auth', `Blocked sign-in — "${user.username}" has no access to "${req.callingApp.slug}"`, user.uid, user.username);
      return res.json({ status: 'good-no-access' });
    }

    const status = (user.must_change_password || isPasswordExpired(user)) ? 'good_change_pw' : 'good';
    return finishLogin(user, status, req, res);
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
    return res.json({ valid: true, user: toAppProfile(user) });
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

    try {
      await enforcePasswordPolicy({ passwordPolicyStore, userStore, uid, password: newPassword });
    } catch (err) {
      return res.status(400).json({ status: 'invalid_request', error: err.message });
    }

    const profile = await userStore.resetPassword(uid, newPassword, { clearMustChange: true });
    // Kills every token this account holds, across every app — including
    // the one just used for this request — so a stolen token doesn't
    // survive the one recovery action a compromised user can take on
    // their own. Immediately issues a fresh one for THIS app so the
    // caller doesn't have to round-trip through /login to keep going.
    await sessionStore.revokeAllForUser(uid);
    const newToken = await sessionStore.issue(uid, req.callingApp.app_id);
    await activityLog.add('account', `${user.username} changed their password (via ${req.callingApp.slug})`, uid, user.username);
    res.json({ status: 'ok', token: newToken, user: omitMfaEnabled(profile) });
  });

  /**
   * Self-service profile update (fullName/description/theme) for the
   * logged-in app user. Blocked while a password change is pending —
   * mirrors GAM's own frontend, which blocks every route except a small
   * allowlist (see requireGoodStanding) until that's resolved. Unlike
   * /validate (whose whole job is to hand the calling app the raw status,
   * including mustChangePassword, so IT can decide what "continuing"
   * means in its own UI), there's no equivalent reason for this endpoint
   * to let an app change unrelated profile fields before the account is
   * back in good standing.
   */
  router.post('/update-profile', express.json(), async (req, res) => {
    const { token, fullName, description, theme } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ status: 'invalid_request', error: 'token is required' });
    }
    const uid = await sessionStore.validate(token, req.callingApp.app_id);
    if (!uid) return res.status(401).json({ status: 'invalid_token' });

    const user = await userStore.findByUid(uid);
    if (!user) return res.status(401).json({ status: 'invalid_token' });
    if (user.must_change_password) {
      return res.status(403).json({ status: 'forbidden', error: 'A password change is required before updating your profile.' });
    }

    const updates = {};
    if (fullName !== undefined) updates.fullName = String(fullName).slice(0, 100);
    if (description !== undefined) updates.description = String(description).slice(0, 300);
    if (theme !== undefined && ['ember', 'ocean', 'forest', 'light', 'sharp'].includes(theme)) updates.theme = theme;

    const profile = await userStore.update(uid, updates);
    res.json({ status: 'ok', user: omitMfaEnabled(profile) });
  });

  return router;
};
