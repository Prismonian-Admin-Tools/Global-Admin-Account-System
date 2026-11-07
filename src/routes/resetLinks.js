'use strict';
const express = require('express');
const { enforcePasswordPolicy } = require('../utils/enforcePasswordPolicy');

/**
 * The emailed one-time links (see models/resetLinkStore.js) — "Reset
 * password" and "Wasn't you? Sign this user out and change your password".
 * The page at /reset-password (public/index.html, renderResetLink) calls
 * these. Mounted before the frontend's requireAuth: the whole point is that
 * the person may not be able to sign in (expired password, or someone else
 * changed it). The link token is the only credential, so every endpoint
 * re-checks it, and nothing happens on a GET.
 */
module.exports = function resetLinkRoutes({ resetLinkStore, userStore, sessionStore, passwordPolicyStore, activityLog }) {
  const router = express.Router();

  // Same message for unknown, used and expired links — no oracle for guessing.
  const INVALID = 'This link is invalid, has already been used, or has expired. Sign in and change your password from My Account, or ask an administrator to reset it.';

  async function load(token) {
    const link = await resetLinkStore.find(token);
    if (!link) return null;
    const user = await userStore.findByUid(link.uid);
    if (!user) return null;
    return { link, user };
  }

  router.post('/reset-link/inspect', express.json(), async (req, res) => {
    const found = await load(req.body && req.body.token);
    if (!found) return res.status(400).json({ error: INVALID });
    const { link, user } = found;
    const rules = (await passwordPolicyStore.listEnabled()).map((r) => r.label);
    res.json({
      purpose: link.purpose,
      username: user.username,
      fullName: user.full_name || '',
      signedOut: Boolean(link.signed_out_at),
      expiresAt: link.expires_at,
      // Reasons the password part can't be done here (signing out still can).
      blocked: user.disabled ? 'This account is disabled. Contact your administrator.'
        : user.cannot_change_password ? 'This account isn\'t allowed to change its own password. Contact your administrator to have it reset.'
          : null,
      rules,
    });
  });

  /** "Wasn't you?": end every app token AND website session for the account, right now. */
  router.post('/reset-link/sign-out', express.json(), async (req, res) => {
    const token = req.body && req.body.token;
    const found = await load(token);
    if (!found) return res.status(400).json({ error: INVALID });
    const { user } = found;
    const ended = await sessionStore.revokeEverywhere(user.uid);
    await resetLinkStore.markSignedOut(token);
    await activityLog.add('account', `${user.username} signed out of all sessions from an emailed "Wasn't you?" link (${ended} ended)`, user.uid, user.username);
    res.json({ ok: true, ended });
  });

  router.post('/reset-link/complete', express.json(), async (req, res) => {
    try {
      const { token, newPassword, confirmPassword } = req.body || {};
      const found = await load(token);
      if (!found) return res.status(400).json({ error: INVALID });
      const { link, user } = found;
      if (user.disabled) throw new Error('This account is disabled. Contact your administrator.');
      if (user.cannot_change_password) throw new Error('This account isn\'t allowed to change its own password. Contact your administrator to have it reset.');
      if (!newPassword || newPassword.length < 8) throw new Error('New password must be at least 8 characters');
      if (newPassword !== confirmPassword) throw new Error('New password and confirmation do not match');
      // Same rules as any self-service change (policy + not too similar to recent ones).
      await enforcePasswordPolicy({ passwordPolicyStore, userStore, uid: user.uid, password: newPassword });

      // Only now use the link up — atomically, so a double submit can't set two passwords.
      if (!(await resetLinkStore.consume(token))) return res.status(400).json({ error: INVALID });
      await userStore.resetPassword(user.uid, newPassword, { clearMustChange: true, changedBy: 'self' });
      // A new password should never leave old sessions alive.
      await sessionStore.revokeEverywhere(user.uid);
      const how = link.purpose === 'compromised' ? '"Wasn\'t you?"' : 'reset';
      await activityLog.add('account', `${user.username} set a new password from an emailed ${how} link`, user.uid, user.username);
      res.json({ ok: true, username: user.username });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
