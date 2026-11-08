'use strict';
// Integration test for Rally account sync against a fake Rally (test/mockRally.js)
// and a real, DISPOSABLE Postgres database — it deletes accounts named t_* and
// every rally_accounts row. Point GUS_CONFIG at a test config with
// rally.enabled: true, rally.baseUrl: http://127.0.0.1:9911, rally.apiKey: test-key.
//   GUS_CONFIG=/path/to/test-config.yml npm run test:rally
const assert = require('assert/strict');
const REPO = require('path').join(__dirname, '..');
const { loadConfig } = require(`${REPO}/src/config`);
const { initPool } = require(`${REPO}/src/db`);
const { UserStore } = require(`${REPO}/src/models/userStore`);
const { RankStore } = require(`${REPO}/src/models/rankStore`);
const { ActivityLog } = require(`${REPO}/src/models/activityLog`);
const { setUpRallySync } = require(`${REPO}/src/integrations/rally`);
const { startMockRally } = require('./mockRally');

(async () => {
  const mock = await startMockRally(9911);
  const config = loadConfig();
  const pool = initPool(config.database);
  await pool.query("DELETE FROM users WHERE uid IN (SELECT uid FROM usernames WHERE username LIKE 't_%')");
  await pool.query('DELETE FROM rally_accounts');
  const userStore = new UserStore(pool, new RankStore(pool));
  const activityLog = new ActivityLog(pool);
  const sync = await setUpRallySync({ config, pool, userStore, activityLog });
  const rallyUser = (row) => mock.state.users.get(Number(row.rally_object_id));
  let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);

  // 1. create -> Rally user created with the required fields
  const ada = await userStore.create({ username: 't_ada', password: 'password123', role: 'staff', fullName: 'Ada King Lovelace', email: 'ada@example.com' });
  let row = await sync.get(ada.uid);
  assert.equal(row.in_sync, true); assert.equal(row.rally_state, 'active'); assert.equal(row.linked_existing, false);
  const ru = rallyUser(row);
  assert.deepEqual([ru.EmailAddress, ru.FirstName, ru.LastName, ru.DisplayName, ru.Language, ru.Locale, ru.sessionTimeout], ['ada@example.com', 'Ada', 'King Lovelace', 'Ada King Lovelace', 'US English', 'US English', 3600]);
  assert.ok(mock.state.requests.every((r) => r.key === 'test-key'));
  ok('create makes a Rally user with required fields, via ZSESSIONID');

  // 2. disable / enable mirror to Rally
  await userStore.update(ada.uid, { disabled: true });
  row = await sync.get(ada.uid);
  assert.equal(row.rally_state, 'disabled'); assert.equal(rallyUser(row).Disabled, true); assert.equal(row.in_sync, true);
  await userStore.update(ada.uid, { disabled: false });
  row = await sync.get(ada.uid);
  assert.equal(row.rally_state, 'active'); assert.equal(rallyUser(row).Disabled, false);
  ok('disable and re-enable mirror to Rally');

  // 3. unrelated update makes no Rally call
  const before = mock.state.requests.length;
  await userStore.update(ada.uid, { description: 'hello', theme: 'dark' });
  assert.equal(mock.state.requests.length, before);
  ok('unrelated profile edits make no Rally calls');

  // 4. no email -> waits, then created once email set
  const bob = await userStore.create({ username: 't_bob', password: 'password123', role: 'staff' });
  row = await sync.get(bob.uid);
  assert.equal(row.in_sync, false); assert.equal(row.rally_object_id, null); assert.match(row.last_error, /email/); assert.equal(row.attempts, 0);
  await userStore.update(bob.uid, { email: 'bob@example.com' });
  row = await sync.get(bob.uid);
  assert.equal(row.in_sync, true); assert.equal(rallyUser(row).EmailAddress, 'bob@example.com');
  ok('account without email waits, then syncs once an email is set');

  // 5. Rally failing: Passport create still succeeds; sweep recovers; no duplicate
  mock.state.fail = true;
  const cy = await userStore.create({ username: 't_cy', password: 'password123', role: 'staff', email: 'cy@example.com' });
  assert.ok(await userStore.getProfile(cy.uid));
  row = await sync.get(cy.uid);
  assert.equal(row.in_sync, false); assert.equal(row.attempts, 1); assert.match(row.last_error, /Simulated Rally failure/);
  await sync.sweep();
  assert.equal((await sync.get(cy.uid)).attempts, 2);
  mock.state.fail = false;
  await sync.sweep();
  row = await sync.get(cy.uid);
  assert.equal(row.in_sync, true); assert.equal(row.attempts, 0); assert.equal(row.last_error, null);
  assert.equal([...mock.state.users.values()].filter((u) => u.EmailAddress === 'cy@example.com').length, 1);
  ok('Rally 200-with-Errors failures are recorded, Passport unaffected, sweep retries');

  // 6. maxAttempts stops the sweep; resetFailed revives
  mock.state.fail = true;
  await userStore.update(cy.uid, { disabled: true });
  for (let i = 0; i < 15; i++) await sync.sweep();
  row = await sync.get(cy.uid);
  assert.equal(row.attempts, 10);
  mock.state.fail = false;
  await sync.sweep(); assert.equal((await sync.get(cy.uid)).in_sync, false);
  await sync.resetFailed(); await sync.sweep();
  row = await sync.get(cy.uid);
  assert.equal(row.in_sync, true); assert.equal(rallyUser(row).Disabled, true);
  ok('gives up after maxAttempts; resetFailed + sweep recovers');

  // 7. delete with default onPassportDelete=disable -> Rally user disabled, kept
  await userStore.update(cy.uid, { disabled: false });
  await userStore.remove(ada.uid);
  row = await sync.get(ada.uid);
  assert.equal(row.desired_state, 'deleted'); assert.equal(row.in_sync, true); assert.equal(row.rally_state, 'disabled');
  assert.equal(rallyUser(row).Disabled, true);
  ok('deleting a Passport account disables (not deletes) its Rally user by default');

  // 8. hard delete mode
  sync.options.onPassportDelete = 'delete';
  await userStore.remove(bob.uid);
  row = await sync.get(bob.uid);
  assert.equal(row.rally_state, 'deleted'); assert.equal(row.in_sync, true); assert.equal(rallyUser(row), undefined);
  ok('onPassportDelete=delete permanently deletes the Rally user');

  // 9. pre-existing Rally user is linked, not duplicated, and never hard-deleted
  mock.state.users.set(5, { ObjectID: 5, ObjectUUID: 'u5', EmailAddress: 'dee@example.com', UserName: 'dee', Disabled: false });
  const dee = await userStore.create({ username: 't_dee', password: 'password123', role: 'staff', email: 'dee@example.com' });
  row = await sync.get(dee.uid);
  assert.equal(row.linked_existing, true); assert.equal(Number(row.rally_object_id), 5);
  assert.equal([...mock.state.users.values()].filter((u) => u.EmailAddress === 'dee@example.com').length, 1);
  await userStore.remove(dee.uid);
  row = await sync.get(dee.uid);
  assert.equal(row.in_sync, true); assert.equal(row.rally_state, 'disabled'); assert.equal(mock.state.users.get(5).Disabled, true);
  ok('existing Rally user (same email) is linked, and only disabled on delete even in delete mode');

  // 10. Rally failure during delete is retried after the Passport row is gone
  const eve = await userStore.create({ username: 't_eve', password: 'password123', role: 'staff', email: 'eve@example.com' });
  const eveId = Number((await sync.get(eve.uid)).rally_object_id);
  mock.state.fail = true;
  await userStore.remove(eve.uid);
  assert.equal(await userStore.getProfile(eve.uid), null);
  assert.equal((await sync.get(eve.uid)).in_sync, false);
  mock.state.fail = false;
  await sync.sweep();
  assert.equal((await sync.get(eve.uid)).rally_state, 'deleted'); assert.equal(mock.state.users.has(eveId), false);
  ok('Rally delete that failed is retried after the Passport account is gone');
  sync.options.onPassportDelete = 'disable';

  // 11. concurrent reconciles create exactly one Rally user
  mock.state.delayMs = 150;
  const fay = await userStore.create({ username: 't_fay', password: 'password123', role: 'staff' });
  await pool.query("UPDATE userdata SET email = 'fay@example.com' WHERE uid = $1", [fay.uid]);
  await Promise.all([sync.reconcile(fay.uid), sync.reconcile(fay.uid), sync.sweep()]);
  mock.state.delayMs = 0;
  await sync.sweep();
  assert.equal([...mock.state.users.values()].filter((u) => u.EmailAddress === 'fay@example.com').length, 1);
  assert.equal((await sync.get(fay.uid)).in_sync, true);
  ok('concurrent reconciles never create duplicate Rally users');

  // 12. unsafe email rejected without a query
  const gus = await userStore.create({ username: 't_gus', password: 'password123', role: 'staff', email: 'g"x@example.com' });
  row = await sync.get(gus.uid);
  assert.equal(row.in_sync, false); assert.match(row.last_error, /isn't usable/);
  ok('emails that would break a WSAPI query are refused');

  // 13. Rally sync off -> no rows, no hooks
  const plain = new UserStore(pool, new RankStore(pool));
  const hal = await plain.create({ username: 't_hal', password: 'password123', role: 'staff', email: 'hal@example.com' });
  assert.equal(await sync.get(hal.uid), null);
  ok('with no sync attached nothing is enrolled');

  const acts = await pool.query("SELECT message FROM activity_log WHERE category = 'rally' ORDER BY id");
  assert.ok(acts.rows.some((r) => /created Rally user for "t_ada"/.test(r.message)));
  ok('activity log records Rally actions');

  console.log(`\nall ${n} passed`);
  await pool.end(); mock.close();
})().catch((err) => { console.error(err); process.exit(1); });
