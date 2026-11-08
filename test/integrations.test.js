'use strict';
// Integration test for RESTful API integrations (Apps tab → "RESTful API"):
// saving / testing / removing Rally's API key, encryption at rest, and the
// Rally sync switching on and off without a restart. Uses the fake Rally in
// test/mockRally.js (port 9911) and a DISPOSABLE Postgres database. The test
// config should have rally.baseUrl: http://127.0.0.1:9911 and may have
// rally.enabled false (the key saved here turns sync on by itself).
//   GUS_CONFIG=/path/to/test-config.yml node test/integrations.test.js
const assert = require('assert/strict');
const path = require('path');
const express = require('express');
const REPO = path.join(__dirname, '..');
const { loadConfig } = require(`${REPO}/src/config`);
const { initPool } = require(`${REPO}/src/db`);
const { UserStore } = require(`${REPO}/src/models/userStore`);
const { RankStore } = require(`${REPO}/src/models/rankStore`);
const { ActivityLog } = require(`${REPO}/src/models/activityLog`);
const { IntegrationStore } = require(`${REPO}/src/models/integrationStore`);
const { setUpRallySync } = require(`${REPO}/src/integrations/rally`);
const integrationRoutes = require(`${REPO}/src/routes/integrations`);
const { startMockRally } = require('./mockRally');

(async () => {
  const mock = await startMockRally(9911);
  const loaded = loadConfig();
  // Force: Rally pointed at the fake, and NOT enabled via config — only a
  // key saved through the integration may turn it on here.
  const config = { ...loaded, rally: { ...(loaded.rally || {}), enabled: false, apiKey: '', baseUrl: 'http://127.0.0.1:9911' } };
  const pool = initPool(config.database);
  await pool.query("DELETE FROM users WHERE uid IN (SELECT uid FROM usernames WHERE username LIKE 'i\\_%')");
  await pool.query('DELETE FROM rally_accounts');
  await pool.query('DELETE FROM app_integrations');
  const userStore = new UserStore(pool, new RankStore(pool));
  const activityLog = new ActivityLog(pool);
  const integrationStore = new IntegrationStore(pool, { encryptionKey: config.server.encryptionKey });
  let rallySync = null;
  const reload = async () => { rallySync = await setUpRallySync({ config, pool, userStore, activityLog, integrationStore }); };
  await reload();
  assert.equal(rallySync, null); assert.equal(userStore.accountSync, null);

  const app = express();
  app.use((req, res, next) => { req.session = { user: { uid: null, username: 'tester' } }; next(); });
  app.use('/api', integrationRoutes({ config, integrationStore, activityLog, reload }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api${p}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  let n = 0; const ok = (s) => console.log(`ok ${++n} - ${s}`);

  let r = await call('GET', '/integrations');
  assert.deepEqual(r.body.services.map((s) => s.id), ['rally']); assert.equal(r.body.services[0].label, 'Rally (WSAPI)');
  assert.deepEqual(r.body.integrations, []); assert.deepEqual(r.body.fallbacks, []);
  ok('lists Rally (WSAPI) as a supported service; nothing connected');

  r = await call('POST', '/integrations/rally/test', { apiKey: 'wrong-key' });
  assert.equal(r.status, 400); assert.match(r.body.error, /rejected this API key/);
  r = await call('PUT', '/integrations/rally', { apiKey: 'wrong-key' });
  assert.equal(r.status, 400); assert.deepEqual(await integrationStore.list(), []);
  ok('a key Rally rejects fails Test and is not saved');

  r = await call('POST', '/integrations/rally/test', { apiKey: 'plain-key' });
  assert.equal(r.status, 200); assert.match(r.body.warning, /isn't a Subscription Administrator/);
  r = await call('POST', '/integrations/rally/test', { apiKey: 'test-key' });
  assert.deepEqual([r.status, r.body.account, r.body.warning], [200, 'rally-admin@corp.com', null]);
  ok('Test connection: reports the Rally account, warns when it is not a Subscription Admin');

  r = await call('PUT', '/integrations/rally', { apiKey: 'test-key' });
  assert.equal(r.status, 200); assert.equal(r.body.integrations[0].keyHint, '-key');
  assert.ok(rallySync && userStore.accountSync === rallySync, 'sync switched on without a restart');
  assert.equal(rallySync.keySource, 'website');
  const stored = (await pool.query("SELECT encrypted_api_key FROM app_integrations WHERE service = 'rally'")).rows[0].encrypted_api_key;
  assert.ok(!stored.includes('test-key'), 'key encrypted at rest');
  r = await call('GET', '/integrations');
  assert.ok(!JSON.stringify(r.body).includes('test-key'), 'key never returned');
  assert.deepEqual([r.body.integrations[0].service, r.body.integrations[0].updatedBy], ['rally', 'tester']);
  ok('Save: stored encrypted, never returned (only last 4 chars), Rally sync on immediately');

  const before = mock.state.users.size;
  const u = await userStore.create({ username: 'i_ivy', password: 'password123', role: 'staff', email: 'ivy@example.com' });
  assert.equal(mock.state.users.size, before + 1);
  assert.equal((await rallySync.get(u.uid)).in_sync, true);
  r = await call('POST', '/integrations/rally/test', {});
  assert.equal(r.body.account, 'rally-admin@corp.com');
  ok('with the saved key, creating a Passport user creates the Rally user; Test uses the saved key');

  r = await call('DELETE', '/integrations/rally');
  assert.equal(r.status, 200); assert.equal(rallySync, null); assert.equal(userStore.accountSync, null);
  const size = mock.state.users.size;
  await userStore.create({ username: 'i_jon', password: 'password123', role: 'staff', email: 'jon@example.com' });
  assert.equal(mock.state.users.size, size, 'no Rally call once disconnected');
  assert.equal((await call('DELETE', '/integrations/rally')).status, 404);
  assert.equal((await call('PUT', '/integrations/nope', { apiKey: 'x' })).status, 404);
  ok('Disconnect: sync off immediately; unknown service / not connected -> 404');

  const withConfig = { ...config, rally: { ...config.rally, enabled: true, apiKey: 'test-key' } };
  const app2 = express();
  app2.use((req, res, next) => { req.session = { user: { uid: null, username: 'tester' } }; next(); });
  app2.use('/api', integrationRoutes({ config: withConfig, integrationStore, activityLog, reload }));
  const s2 = await new Promise((res) => { const s = app2.listen(0, '127.0.0.1', () => res(s)); });
  const g = await (await fetch(`http://127.0.0.1:${s2.address().port}/api/integrations`)).json();
  assert.deepEqual(g.fallbacks, [{ service: 'rally', source: 'config' }]);
  const fromConfig = await setUpRallySync({ config: withConfig, pool, userStore, activityLog, integrationStore });
  assert.equal(fromConfig.keySource, 'config');
  await integrationStore.save('rally', 'plain-key', 'tester');
  assert.equal((await setUpRallySync({ config: withConfig, pool, userStore, activityLog, integrationStore })).keySource, 'website', 'website key wins over config.yml');
  await integrationStore.remove('rally'); userStore.setAccountSync(null); s2.close();
  ok('a key in config.yml still works and is shown as such; a key saved on the Apps tab takes precedence');

  console.log(`\nall ${n} passed`);
  server.close(); mock.close(); await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
