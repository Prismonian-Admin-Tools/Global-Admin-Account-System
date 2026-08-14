'use strict';

// This guards the GUS's OWN frontend (auth.prismonian.com) — separate
// entirely from the app-facing /api/v1/* login contract. A person visits
// the GUS directly to manage their account, and owners use it to manage
// everyone else's.

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

function requireOwner(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.session.user.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  next();
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

module.exports = { requireAuth, requireOwner, requireGoodStanding };
