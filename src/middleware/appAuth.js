'use strict';

/**
 * Every /api/v1/* call must prove which application is calling, via
 * X-App-Id / X-App-Secret headers — separate from the end user's own
 * username/password in the request body. This is what stops "anyone who
 * can reach the server" from harvesting real users' data: without a valid
 * registered app secret, the request never even reaches the login logic.
 */
function requireApp(appStore) {
  return async (req, res, next) => {
    const appId = req.header('X-App-Id');
    const appSecret = req.header('X-App-Secret');
    const app = await appStore.verify(appId, appSecret);
    if (!app) return res.status(401).json({ status: 'invalid_app' });
    req.callingApp = app;
    next();
  };
}

module.exports = { requireApp };
