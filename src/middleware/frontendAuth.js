'use strict';

// This guards the GAM's OWN frontend (auth.prismonian.com) — separate
// entirely from the app-facing /api/v1/* login contract. A person visits
// GAM directly to manage their account, and capability-holding ranks use
// it to manage everyone else's.

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

/**
 * Gates a route on a single capability of the caller's CURRENT rank —
 * re-fetched from the DB on every request rather than trusting
 * req.session.user.role (cached at login), otherwise a user whose rank is
 * changed, or whose rank's capabilities are edited, keeps acting on the
 * old capability set for as long as their session cookie lives.
 */
function requireCapability(rankStore, userStore, capability) {
  return async (req, res, next) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    const user = await userStore.findByUid(req.session.user.uid);
    if (!user || user.disabled) return res.status(401).json({ error: 'Not authenticated' });
    const allowed = await rankStore.hasCapability(user.role, capability);
    if (!allowed) return res.status(403).json({ error: `This requires the "${capability}" capability` });
    next();
  };
}

/** Gates a route on ANY of several capabilities — for routes multiple ranks legitimately need (e.g. reading the rank list to populate a role picker). Same fresh-role rule as requireCapability. */
function requireAnyCapability(rankStore, userStore, capabilities) {
  return async (req, res, next) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    const user = await userStore.findByUid(req.session.user.uid);
    if (!user || user.disabled) return res.status(401).json({ error: 'Not authenticated' });
    for (const capability of capabilities) {
      if (await rankStore.hasCapability(user.role, capability)) return next();
    }
    res.status(403).json({ error: `This requires one of: ${capabilities.join(', ')}` });
  };
}

/**
 * Kills the session outright if the account was disabled mid-session, and
 * blocks every route except a small allowlist while a forced password
 * change is pending — mirrors the old panel's requireGoodStanding.
 */
function requireGoodStanding(userStore) {
  const ALLOWED_WHILE_CHANGE_REQUIRED = new Set(['/session', '/logout', '/account/password', '/account']);
  return async (req, res, next) => {
    if (!req.session || !req.session.user) return next();
    const user = await userStore.findByUid(req.session.user.uid);
    if (!user) {
      return req.session.destroy(() => res.status(401).json({ error: 'Account no longer exists' }));
    }
    if (user.disabled) {
      return req.session.destroy(() => res.status(403).json({ error: 'This account has been disabled.' }));
    }
    const needsChange = !!user.must_change_password;
    if (needsChange && !ALLOWED_WHILE_CHANGE_REQUIRED.has(req.path)) {
      return res.status(428).json({ error: 'A password change is required before continuing.', requirePasswordChange: true });
    }
    next();
  };
}

module.exports = { requireAuth, requireCapability, requireAnyCapability, requireGoodStanding };
