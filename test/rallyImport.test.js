'use strict';
// Integration test for the Rally user import (rally import-list / rally import)
// against a fake Rally (test/mockRally.js) and a real, DISPOSABLE Postgres
// database — it wipes users/rally_accounts. Same test config as rally.test.js:
//   GUS_CONFIG=/path/to/test-config.yml npm run test:rally
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const REPO = path.join(__dirname, '..');
const { loadConfig } = require(`${REPO}/src/config`);
const { initPool } = require(`${REPO}/src/db`);
const { UserStore } = require(`${REPO}/src/models/userStore`);
const { RankStore } = require(`${REPO}/src/models/rankStore`);
const { ActivityLog } = require(`${REPO}/src/models/activityLog`);
const { setUpRallySync, buildRallyImporter } = require(`${REPO}/src/integrations/rally`);
const { rowsToCsv, objectIdsFromCsv } = require(`${REPO}/src/integrations/rally/rallyImport`);
const { startMockRally } = require('./mockRally');

(async () => {
  const mock = await startMockRally(9911);
  const config = loadConfig();
  const pool = initPool(config.database);
  const rankStore = new RankStore(pool);
  const userStore = new UserStore(pool, rankStore);
  // A permanent admin, so the "at least one sysadmin" trigger lets cleanup
  // delete systemAdministrator accounts a previous run imported.
  if (!(await userStore.findByUsername('root'))) await userStore.create({ username: 'root', password: 'password123', role: 'systemAdministrator', skipAccountSync: true });
  await pool.query("DELETE FROM users WHERE uid IN (SELECT uid FROM usernames WHERE username <> 'root')");
  await pool.query('DELETE FROM rally_accounts');
  const sync = await setUpRallySync({ config, pool, userStore, activityLog: new ActivityLog(pool) });
  const importer = buildRallyImporter({ config, rallySync: sync, userStore, rankStore });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-import-'));
  let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);

  const R = (id, UserName, EmailAddress, extra = {}) => mock.state.users.set(id, { ObjectID: id, ObjectUUID: `u${id}`, UserName, EmailAddress, Disabled: false, SubscriptionPermission: 'Workspace User', ...extra });
  R(101, 'boss@corp.com', 'boss@corp.com', { SubscriptionAdmin: true, SubscriptionPermission: 'Subscription Admin', FirstName: 'Big', LastName: 'Boss' });
  R(102, 'wanda@corp.com', 'wanda@corp.com', { SubscriptionPermission: 'Workspace Admin' });
  R(103, 'joe@corp.com', 'joe@corp.com', { SubscriptionPermission: 'Project Admin', DisplayName: 'Joe D' });
  R(104, 'old@corp.com', 'old@corp.com', { Disabled: true });
  R(105, 'noemail', '');
  R(106, 'jane.smith@corp.com', 'Jane@Corp.com');
  R(107, 'pat@x.com', 'pat@x.com');
  R(108, 'sam@x.com', 'sam@x.com');
  R(109, 'dup@a.com', 'dup@a.com');
  R(110, 'dup@b.com', 'dup@b.com');
  R(111, 'linked@corp.com', 'linked@corp.com');
  R(112, 'evil@corp.com', 'evil@corp.com', { FirstName: '=HYPERLINK("x")', LastName: 'Evil' });
  R(113, 'gone@corp.com', 'gone@corp.com');
  R(114, 'pend@corp.com', 'pend@corp.com');
  for (let i = 0; i < 250; i++) R(1000 + i, `filler${i}@f.com`, `filler${i}@f.com`);
  const rallyCount = mock.state.users.size;

  const mk = (username, email, extra = {}) => userStore.create({ username, password: 'password123', role: 'staff', email, skipAccountSync: true, ...extra });
  const jsmith = await mk('jsmith', 'jane@corp.com', { fullName: 'Jane Original' });
  await mk('pat', null);
  await mk('sam', 'sam@other.com');
  const linked = await mk('linked', 'linked@corp.com');
  await sync.link(await userStore.getProfile(linked.uid), mock.state.users.get(111));
  // Enrolled in sync but never got a Rally user (Rally was down at creation):
  // not really linked, so the import may link it.
  const pend = await mk('pend', 'pend@corp.com');
  await pool.query("INSERT INTO rally_accounts (uid, username, desired_state, attempts, last_error) VALUES ($1, 'pend', 'active', 3, 'Rally down')", [pend.uid]);
  const gone = await mk('gone', 'gone@corp.com');
  await userStore.update(gone.uid, { disabled: true });

  // 1. plan
  const { rows, hiddenNoEmail } = await importer.planImport();
  const by = Object.fromEntries(rows.map((r) => [r.rallyObjectId, r]));
  assert.equal(hiddenNoEmail, 1); assert.equal(by['105'], undefined);
  assert.equal(rows.length, rallyCount - 1, 'paged past the first 200');
  assert.deepEqual([by['101'].action, by['101'].passportUsername, by['101'].passportRank], ['create', 'boss', 'systemAdministrator']);
  assert.deepEqual([by['102'].action, by['102'].passportRank], ['create', 'elevatedStaff']);
  assert.deepEqual([by['103'].action, by['103'].passportRank, by['103'].fullName], ['create', 'staff', 'Joe D']);
  assert.match(by['104'].note, /created disabled/);
  assert.deepEqual([by['106'].action, by['106'].linkTo], ['link', 'jsmith']); assert.match(by['106'].note, /same email/);
  assert.deepEqual([by['107'].action, by['107'].linkTo], ['link', 'pat']); assert.match(by['107'].note, /same username/);
  assert.equal(by['108'].action, 'skip'); assert.match(by['108'].note, /different email/);
  assert.equal(by['109'].action, 'skip'); assert.equal(by['110'].action, 'skip'); assert.match(by['109'].note, /shared by 2/);
  assert.equal(by['111'].action, 'skip'); assert.match(by['111'].note, /already linked to Passport account "linked"/);
  assert.equal(by['113'].action, 'link'); assert.match(by['113'].note, /DISABLED to match/);
  assert.deepEqual([by['114'].action, by['114'].linkTo], ['link', 'pend']);
  ok('import-list plans create / link / skip correctly, maps ranks, pages through Rally');

  const withNoEmail = await importer.planImport({ includeNoEmail: true });
  const ne = withNoEmail.rows.find((r) => r.rallyObjectId === '105');
  assert.deepEqual([ne.action, ne.passportUsername], ['create', 'noemail']); assert.equal(withNoEmail.hiddenNoEmail, 0);
  ok('--include-no-email shows Rally users without an email');

  // 2. CSV
  const csv = rowsToCsv(rows);
  assert.ok(csv.includes(`"'=HYPERLINK(""x"") Evil"`), 'formula neutralised');
  assert.deepEqual(objectIdsFromCsv(csv), rows.map((r) => r.rallyObjectId));
  assert.deepEqual(objectIdsFromCsv('﻿note,rally_object_id\r\n"a, b",101\r\n,\r\nx,102\r\n'), ['101', '102']);
  ok('CSV export neutralises formulas and round-trips object IDs');

  // 3. dry run + unknown id
  const usersBefore = (await userStore.listIdentities()).length;
  const dry = await importer.importUsers({ select: { all: true }, dryRun: true });
  assert.ok(dry.results.every((x) => x.outcome.startsWith('would')));
  assert.equal((await userStore.listIdentities()).length, usersBefore);
  await assert.rejects(importer.importUsers({ select: { identifiers: ['joe@corp.com', 'nobody@x.com'] }, passwordsFile: path.join(tmp, 'x.csv') }), /Not found in Rally: nobody@x.com/);
  assert.equal((await userStore.listIdentities()).length, usersBefore); assert.equal(fs.existsSync(path.join(tmp, 'x.csv')), false);
  ok('dry run and unknown identifiers change nothing');

  // 4. real import by identifier
  const pwFile = path.join(tmp, 'pw.csv');
  const { results } = await importer.importUsers({
    select: { identifiers: ['boss@corp.com', '102', 'JOE@corp.com', 'jane.smith@corp.com', 'pat@x.com', 'sam@x.com', 'old@corp.com', '113', '114'] },
    passwordsFile: pwFile,
  });
  const out = Object.fromEntries(results.map((x) => [x.row.rallyObjectId, x.outcome]));
  assert.deepEqual(out, { 101: 'created', 102: 'created', 103: 'created', 104: 'created', 106: 'linked', 107: 'linked', 108: 'skipped', 113: 'linked', 114: 'linked' });
  const boss = await userStore.findByUsername('boss');
  assert.deepEqual([boss.role, boss.full_name, boss.email, boss.must_change_password], ['systemAdministrator', 'Big Boss', 'boss@corp.com', true]);
  assert.equal((await userStore.findByUsername('wanda')).role, 'elevatedStaff');
  assert.equal((await userStore.findByUsername('joe')).role, 'staff');
  assert.equal((await userStore.findByUsername('old')).disabled, true);
  const js = await userStore.findByUsername('jsmith');
  assert.deepEqual([js.full_name, js.role, js.email], ['Jane Original', 'staff', 'jane@corp.com']);
  assert.equal(mock.state.users.size, rallyCount, 'no Rally users created');
  assert.equal(mock.state.users.get(113).Disabled, true, 'linked Rally user disabled to match Passport');
  for (const u of ['boss', 'wanda', 'joe', 'old', 'jsmith', 'pat', 'gone', 'pend']) {
    const row = await sync.get((await userStore.findByUsername(u)).uid);
    assert.equal(row.linked_existing, true, u); assert.equal(row.in_sync, true, u);
  }
  assert.equal((fs.statSync(pwFile).mode & 0o777), 0o600);
  const pwRows = fs.readFileSync(pwFile, 'utf8').trim().split('\n');
  assert.equal(pwRows.length, 5); assert.equal(pwRows[0], 'passport_username,email,passport_rank,temporary_password');
  for (const line of pwRows.slice(1)) {
    const [u, , , pw] = line.split(',');
    const v = await userStore.verify(u, pw);
    assert.ok(['good_change_pw', 'disabled'].includes(v.status), `${u} ${v.status}`);
  }
  ok('import creates/links the chosen users, with ranks, disabled state, and a 0600 passwords file');

  await assert.rejects(importer.importUsers({ select: { identifiers: ['wanda@corp.com', 'evil@corp.com'] }, passwordsFile: pwFile }), /EEXIST/);
  assert.equal(await userStore.findByUsername('evil'), null);
  ok('refuses to overwrite an existing passwords file');

  // 5. re-plan: imported now skipped
  const again = Object.fromEntries((await importer.planImport()).rows.map((r) => [r.rallyObjectId, r]));
  for (const id of ['101', '102', '106', '107', '113']) { assert.equal(again[id].action, 'skip', id); assert.match(again[id].note, /already linked/); }
  ok('already-imported users show as skipped on the next list');

  // 6. --from CSV of an edited list
  const remaining = (await importer.planImport()).rows.filter((r) => ['112', '1000', '1001'].includes(r.rallyObjectId));
  const csvFile = path.join(tmp, 'edited.csv'); fs.writeFileSync(csvFile, rowsToCsv(remaining));
  const fromCsv = await importer.importUsers({ select: { identifiers: objectIdsFromCsv(fs.readFileSync(csvFile, 'utf8')) }, passwordsFile: path.join(tmp, 'pw2.csv') });
  assert.deepEqual(fromCsv.results.map((x) => x.outcome), ['created', 'created', 'created']);
  assert.equal((await userStore.findByUsername('evil')).full_name, '=HYPERLINK("x") Evil');
  ok('imports exactly the rows left in an edited CSV');

  // 7. imported users then follow normal sync: disable mirrors; delete never hard-deletes
  const joe = await userStore.findByUsername('joe');
  await userStore.update(joe.uid, { disabled: true });
  assert.equal(mock.state.users.get(103).Disabled, true);
  sync.options.onPassportDelete = 'delete';
  await userStore.remove(joe.uid);
  assert.ok(mock.state.users.has(103), 'linked Rally user not deleted');
  sync.options.onPassportDelete = 'disable';
  ok('imported accounts sync disable, and are never hard-deleted in Rally');

  // 8. CLI
  // Async, not execFileSync: the fake Rally runs in THIS process and must keep serving.
  const cli = async (...args) => (await execFile('node', [path.join(REPO, 'scripts/gus-cli.js'), 'rally', ...args], { env: process.env, cwd: tmp, encoding: 'utf8' })).stdout;
  const table = await cli('import-list');
  assert.match(table, /RALLY USER/); assert.match(table, /1 without an email hidden/);
  const json = JSON.parse(await cli('import-list', '--json'));
  assert.equal(json.hiddenNoEmail, 1); assert.ok(json.users.find((u) => u.rally_object_id === '109' && u.action === 'skip'));
  await cli('import-list', '--csv', path.join(tmp, 'list.csv'));
  assert.match(fs.readFileSync(path.join(tmp, 'list.csv'), 'utf8'), /^rally_object_id,/);
  const dryCli = await cli('import', '--dry-run', 'wanda@corp.com', 'filler5@f.com');
  assert.match(dryCli, /Dry run/); assert.match(dryCli, /filler5 .*would create/); assert.match(dryCli, /wanda .*skipped/);
  assert.equal(await userStore.findByUsername('filler5'), null);
  const real = await cli('import', 'filler6@f.com', 'noemail', '--include-no-email');
  assert.match(real, /Temporary passwords were written to rally-import-passwords-\d{8}-\d{6}\.csv/);
  assert.doesNotMatch(real, /,[A-Za-z0-9!@#%]{16}\b/);
  assert.ok(await userStore.findByUsername('noemail'));
  ok('CLI: import-list table/--json/--csv, import --dry-run, passwords file default name, never printed');

  console.log(`\nall ${n} passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  await pool.end(); mock.close();
})().catch((err) => { console.error(err); process.exit(1); });
