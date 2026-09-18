'use strict';
const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { FULL_CAPABILITY_RANKS, UNASSIGNABLE_RANKS } = require('../models/rankStore');

module.exports = function usersRoutes({ userStore, rankStore, sessionStore, activityLog, mfaStore }) {
  const router = express.Router();

  function actor(req) {
    return req.session.user.uid;
  }
  function actorName(req) {
    return req.session.user.username;
  }

  /**
   * The gate behind everything below: having the manageUsers capability
   * used to be the ONLY check on who a rank could edit — anyone holding
   * it could edit or delete literally any account, including their own
   * and ones outranking them, and grant themselves or anyone else a
   * higher rank than they actually have. Every route below that touches
   * an existing target account calls this first.
   *
   * req.session.user.role is cached at login and can go stale — re-fetch
   * the actor's CURRENT row rather than trust it, same reasoning as
   * requireCapability() in frontendAuth.js.
   */
  async function requireCanManage(req, target) {
    const actorUser = await userStore.findByUid(actor(req));
    if (!actorUser) throw new Error('Your account could not be found');
    if (target.uid === actorUser.uid) {
      throw new Error('You cannot manage your own account from this panel — use My Account instead.');
    }
    const actorLevel = await rankStore.permissionLevelFor(actorUser.role);
    const targetLevel = await rankStore.permissionLevelFor(target.role);
    if (targetLevel >= actorLevel) {
      throw new Error('You do not have a high enough permission level to manage this account.');
    }
    return actorLevel;
  }

  /** Same idea for a role being newly ASSIGNED (on create, or a role change on an existing account) — separate from requireCanManage because creating a brand-new peer at your own level is fine; touching an existing one at or above your level is not. */
  async function requireAssignableRole(role, actorLevel) {
    if (UNASSIGNABLE_RANKS.includes(role)) {
      throw new Error('That rank cannot be assigned from this panel.');
    }
    const roleLevel = await rankStore.permissionLevelFor(role);
    if (roleLevel > actorLevel) {
      throw new Error('You cannot assign a rank with a higher permission level than your own.');
    }
  }

  router.get('/users', asyncHandler(async (req, res) => {
    res.json(await userStore.list({ limit: req.query.limit, offset: req.query.offset }));
  }));

  router.get('/users/:uid', asyncHandler(async (req, res) => {
    const profile = await userStore.getProfile(req.params.uid);
    if (!profile) return res.status(404).json({ error: 'No such user' });
    res.json(profile);
  }));

  router.post('/users', express.json(), async (req, res) => {
    try {
      const { username, password, role, fullName, description, email } = req.body || {};
      if (!(await rankStore.exists(role))) throw new Error('Invalid role');
      const actorUser = await userStore.findByUid(actor(req));
      if (!actorUser) throw new Error('Your account could not be found');
      const actorLevel = await rankStore.permissionLevelFor(actorUser.role);
      await requireAssignableRole(role, actorLevel);
      const profile = await userStore.create({ username, password, role, fullName, description, email });
      await activityLog.add('admin', `${actorName(req)} created user "${profile.username}" (${profile.role})`, actor(req), actorName(req));
      res.json({ ok: true, profile });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** Full profile update — role, rename, password reset, and every account flag in one call. */
  router.patch('/users/:uid', express.json(), async (req, res) => {
    try {
      const body = req.body || {};
      const target = await userStore.findByUid(req.params.uid);
      if (!target) throw new Error('No such user');
      const actorLevel = await requireCanManage(req, target);

      // Don't let the last full-capability admin (systemAdministrator OR
      // trustedInstaller/Provider) demote or disable themselves-into-nothing.
      const demotingOrDisabling = (body.role && !FULL_CAPABILITY_RANKS.includes(body.role)) || body.disabled === true;
      if (FULL_CAPABILITY_RANKS.includes(target.role) && demotingOrDisabling) {
        const admins = await userStore.countFullAdmins();
        if (admins <= 1) throw new Error('Cannot remove the last remaining admin account');
      }

      if (body.role) {
        await requireAssignableRole(body.role, actorLevel);
        await userStore.setRole(req.params.uid, body.role);
        await activityLog.add('admin', `${actorName(req)} changed ${target.username}'s role to ${body.role}`, actor(req), actorName(req));
      }

      if (body.newUsername && body.newUsername !== target.username) {
        await userStore.rename(req.params.uid, body.newUsername);
        await activityLog.add('admin', `${actorName(req)} renamed "${target.username}" to "${body.newUsername}"`, actor(req), actorName(req));
      }

      if (body.password) {
        if (body.password.length < 8) throw new Error('Password must be at least 8 characters');
        if (body.confirmPassword !== undefined && body.password !== body.confirmPassword) {
          throw new Error('Password and confirmation do not match');
        }
        // Forces a change by default (resetPassword's own default) —
        // keepMustChangeFlag is an explicit opt OUT of that, not the
        // reverse. (The web UI doesn't send this field at all; it
        // controls the outcome via the mustChangePassword checkbox
        // below instead, which is applied after this and wins.)
        await userStore.resetPassword(req.params.uid, body.password, { clearMustChange: Boolean(body.keepMustChangeFlag) });
        await sessionStore.revokeAllForUser(req.params.uid);
        await activityLog.add('admin', `${actorName(req)} reset ${target.username}'s password`, actor(req), actorName(req));
      }

      const rest = {};
      ['fullName', 'description', 'email', 'theme', 'disabled', 'mustChangePassword', 'cannotChangePassword', 'passwordNeverExpires', 'passwordExpiresAt', 'needsOnboarding'].forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(body, k)) rest[k] = body[k];
      });
      if (Object.keys(rest).length) await userStore.update(req.params.uid, rest);
      if (body.disabled === true) {
        await sessionStore.revokeAllForUser(req.params.uid);
        await activityLog.add('admin', `${actorName(req)} disabled "${target.username}"`, actor(req), actorName(req));
      }

      res.json({ ok: true, profile: await userStore.getProfile(req.params.uid) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/users/:uid', async (req, res) => {
    try {
      const target = await userStore.findByUid(req.params.uid);
      if (!target) throw new Error('No such user');
      await requireCanManage(req, target);
      if (FULL_CAPABILITY_RANKS.includes(target.role) && (await userStore.countFullAdmins()) <= 1) {
        throw new Error('Cannot delete the last remaining admin account');
      }
      await userStore.remove(req.params.uid);
      await sessionStore.revokeAllForUser(req.params.uid);
      await activityLog.add('admin', `${actorName(req)} deleted user "${target.username}"`, actor(req), actorName(req));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/users/:uid/sessions', asyncHandler(async (req, res) => {
    res.json(await sessionStore.listForUser(req.params.uid));
  }));

  router.delete('/users/:uid/sessions/:tokenHash', async (req, res) => {
    try {
      const target = await userStore.findByUid(req.params.uid);
      if (!target) throw new Error('No such user');
      await requireCanManage(req, target);
      const ok = await sessionStore.revokeByHash(req.params.tokenHash, req.params.uid);
      if (!ok) return res.status(404).json({ error: 'No such session' });
      await activityLog.add('admin', `${actorName(req)} signed ${target.username} out of a session`, actor(req), actorName(req));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/users/:uid/sessions/revoke-all', async (req, res) => {
    try {
      const target = await userStore.findByUid(req.params.uid);
      if (!target) throw new Error('No such user');
      await requireCanManage(req, target);
      await sessionStore.revokeAllForUser(req.params.uid);
      await activityLog.add('admin', `${actorName(req)} signed ${target.username} out everywhere`, actor(req), actorName(req));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * The console-side escape hatch for someone locked out of their own
   * authenticator and backup codes — not recommended (the frontend says
   * so), but a sysadmin needs some way to get a user back in without
   * being able to complete the second factor themselves.
   */
  router.post('/users/:uid/mfa/disable', async (req, res) => {
    try {
      const target = await userStore.findByUid(req.params.uid);
      if (!target) throw new Error('No such user');
      await requireCanManage(req, target);
      await mfaStore.disable(req.params.uid);
      await activityLog.add('admin', `${actorName(req)} disabled two-factor authentication for "${target.username}"`, actor(req), actorName(req));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
