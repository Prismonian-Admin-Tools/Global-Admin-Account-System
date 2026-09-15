'use strict';
const express = require('express');
const session = require('express-session');
const path = require('path');

const { loadConfig } = require('./config');
const { initPool } = require('./db');
const { UserStore } = require('./models/userStore');
const { RankStore } = require('./models/rankStore');
const { AppStore } = require('./models/appStore');
const { SessionStore } = require('./models/sessionStore');
const { FailedLoginStore } = require('./models/failedLoginStore');
const { ActivityLog } = require('./models/activityLog');
const { SiteSettingsStore } = require('./models/siteSettingsStore');

const { requireApp } = require('./middleware/appAuth');
const { perAppRateLimit } = require('./middleware/rateLimit');
const { requireAuth, requireCapability, requireAnyCapability, requireGoodStanding } = require('./middleware/frontendAuth');

const apiV1Routes = require('./routes/apiV1');
const sessionRoutes = require('./routes/session');
const accountRoutes = require('./routes/account');
const usersRoutes = require('./routes/users');
const ranksRoutes = require('./routes/ranks');
const appsRoutes = require('./routes/apps');
const activityRoutes = require('./routes/activity');
const brandingRoutes = require('./routes/branding');

async function main() {
  const config = loadConfig();
  const pool = initPool(config.database);

  const rankStore = new RankStore(pool);
  const userStore = new UserStore(pool, rankStore);
  const appStore = new AppStore(pool);
  const sessionStore = new SessionStore(pool, config.session);
  const failedLoginStore = new FailedLoginStore(pool, config.rateLimit.login);
  const activityLog = new ActivityLog(pool);
  const siteSettingsStore = new SiteSettingsStore(pool);

  if (await userStore.isEmpty()) {
    console.warn('\n⚠  No users exist yet in the GAM database.');
    console.warn('   Run: npm run bootstrap\n');
  }

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(session({
    secret: config.server.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12, secure: 'auto' },
  }));

  /* =========================================================
   * App-facing API — the login status contract (good / good_change_pw /
   * bad / disabled / good-no-access).
   * Requires X-App-Id / X-App-Secret headers on every call.
   * ========================================================= */
  app.use(
    '/api/v1',
    requireApp(appStore),
    perAppRateLimit(config.rateLimit.perApp),
    apiV1Routes({ userStore, appStore, sessionStore, failedLoginStore, activityLog })
  );

  /* =========================================================
   * GAM's own frontend — cookie-session based.
   * Branding is mounted BEFORE requireAuth: its GET has to be reachable
   * by a signed-out visitor (the login screen shows it), and its mutating
   * routes carry their own requireAuth+requireCapability internally — see
   * routes/branding.js.
   * ========================================================= */
  app.use('/api', brandingRoutes({ config, rankStore, siteSettingsStore, activityLog }));
  app.use('/api', sessionRoutes({ userStore, rankStore, failedLoginStore, activityLog }));
  app.use('/api', requireAuth);
  app.use('/api', requireGoodStanding(userStore));
  app.use('/api', accountRoutes({ config, userStore, sessionStore, activityLog }));
  app.use('/api', requireCapability(rankStore, 'manageUsers'), usersRoutes({ userStore, rankStore, sessionStore, activityLog }));
  app.use('/api', ranksRoutes({ rankStore, activityLog, requireCapability: (cap) => requireCapability(rankStore, cap), requireAnyCapability: (caps) => requireAnyCapability(rankStore, caps) }));
  app.use('/api', requireCapability(rankStore, 'manageApps'), appsRoutes({ appStore, userStore, activityLog }));
  app.use('/api', requireCapability(rankStore, 'viewActivity'), activityRoutes({ activityLog, failedLoginStore }));

  app.use('/avatars', express.static(config.avatars.directory));
  app.use('/branding', express.static(`${config.avatars.directory}/../branding`));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.listen(config.server.port, config.server.bind, () => {
    console.log(`GAM listening on http://${config.server.bind}:${config.server.port}`);
  });
}

main().catch((err) => {
  console.error('Failed to start GAM:', err);
  process.exit(1);
});
