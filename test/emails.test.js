'use strict';
// Integration test for Passport's notification emails: triggers each one
// through the real code paths and captures it with a local SMTP sink
// (test/smtpSink.js, port 2525). Needs a DISPOSABLE Postgres database with
// no existing ada/prov/noemail accounts, and OVERWRITES its email settings.
//   GUS_CONFIG=/path/to/test-config.yml npm run test:email [-- <output dir>]
const assert = require('assert/strict');
const fs = require('fs');
const REPO = require('path').join(__dirname, '..');
const { loadConfig } = require(REPO + '/src/config');
const { initPool } = require(REPO + '/src/db');
const { UserStore } = require(REPO + '/src/models/userStore');
const { RankStore } = require(REPO + '/src/models/rankStore');
const { EmailSettingsStore } = require(REPO + '/src/models/emailSettingsStore');
const { SiteSettingsStore } = require(REPO + '/src/models/siteSettingsStore');
const { Mailer } = require(REPO + '/src/utils/mailer');
const { startSink } = require('./smtpSink');
// Rendered copies of every email (HTML + text) are written here for eyeballing.
const OUT = process.argv[2] || fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'passport-emails-'));

// Decode a captured message's quoted-printable / base64 parts (nodemailer output).
function parts(raw) {
  const boundary = (/boundary="?([^"\s;]+)"?/.exec(raw) || [])[1];
  const subject = (/^Subject: (.*(?:\n[ \t].*)*)/m.exec(raw) || [])[1].replace(/\n[ \t]/g, ' ');
  const decodeSubj = subject.replace(/=\?UTF-8\?Q\?([^?]*)\?=/gi, (_, q) => Buffer.from(q.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8')).replace(/\?=\s+=\?UTF-8\?Q\?/g, '');
  const out = { subject: decodeSubj };
  for (const p of raw.split('--' + boundary)) {
    const type = (/Content-Type: (text\/(?:plain|html))/i.exec(p) || [])[1];
    if (!type) continue;
    const enc = (/Content-Transfer-Encoding: (\S+)/i.exec(p) || [])[1] || '7bit';
    let body = p.split(/\n\n/).slice(1).join('\n\n');
    if (/quoted-printable/i.test(enc)) body = Buffer.from(body.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
    else if (/base64/i.test(enc)) body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8');
    out[type.endsWith('html') ? 'html' : 'text'] = body.trim();
  }
  return out;
}

(async () => {
  const sink = await startSink(2525);
  const config = loadConfig();
  const pool = initPool(config.database);
  const ess = new EmailSettingsStore(pool, { encryptionKey: config.server.encryptionKey });
  await ess.update({ enabled: true, host: '127.0.0.1', port: 2525, secure: false, fromAddress: 'noreply@prismonian.com', fromName: 'Passport' });
  const mailer = new Mailer(ess, { siteSettingsStore: new SiteSettingsStore(pool), publicUrl: 'https://auth.prismonian.com/' });
  const userStore = new UserStore(pool, new RankStore(pool), mailer);
  const last = () => parts(sink.messages[sink.messages.length - 1]);
  const save = (name, m) => { fs.writeFileSync(`${OUT}/${name}.html`, m.html); fs.writeFileSync(`${OUT}/${name}.txt`, `Subject: ${m.subject}\n\n${m.text}`); };
  let n = 0; const ok = (s) => console.log(`ok ${++n} - ${s}`);

  const pw = 'Tmp<&"\'Pass9';
  const ada = await userStore.create({ username: 'ada', password: pw, role: 'staff', fullName: 'Ada Lovelace', email: 'ada@example.com' });
  let m = last();
  assert.equal(m.subject, 'Your account is ready');
  assert.ok(m.html.includes('ada') && m.html.includes('Tmp&lt;&amp;&quot;&#39;Pass9'), 'html has username + escaped password');
  assert.ok(!m.html.includes(pw), 'raw password not injected unescaped into HTML');
  assert.match(m.text, /Username:\s+ada/); assert.ok(/Temporary password:\s+/.test(m.text) && m.text.includes(pw));
  assert.match(m.html, /Hi Ada,/); assert.match(m.html, /href="https:\/\/auth\.prismonian\.com"/);
  assert.match(m.text, /choose a new password/);
  save('1-account-created', m); ok('account created: username + temporary password, escaped HTML, plain text, sign-in link');

  await userStore.create({ username: 'prov', password: 'ProviderPass1', role: 'trustedInstaller', email: 'prov@example.com' });
  m = last(); assert.match(m.text, /\bPassword:\s+ProviderPass1/); assert.doesNotMatch(m.text, /Temporary password|choose a new password/);
  ok('Provider account (no forced change): password not labelled temporary');

  const before = sink.messages.length;
  await userStore.create({ username: 'noemail', password: 'password123', role: 'staff' });
  assert.equal(sink.messages.length, before); ok('no email address: nothing sent');

  await userStore.resetPassword(ada.uid, 'NewPass123!', { clearMustChange: true, changedBy: 'self' });
  m = last(); assert.match(m.text, /Changed by:\s+You/); assert.match(m.text, /didn't make this change/); save('2-password-changed-self', m);
  await userStore.resetPassword(ada.uid, 'AdminSet123!');
  m = last(); assert.match(m.text, /Changed by:\s+An administrator/); assert.match(m.text, /Next sign-in:/); assert.doesNotMatch(m.text, /AdminSet123/); save('3-password-reset-admin', m);
  ok('password changed: says who (you / administrator), never includes the new password');

  await userStore.update(ada.uid, { mustChangePassword: false });
  await userStore.update(ada.uid, { mustChangePassword: true });
  m = last(); assert.equal(m.subject, 'Action needed: change your password'); save('4-change-required', m); ok('change required email');

  const prof = { ...(await userStore.getProfile(ada.uid)), passwordExpiresAt: '2026-11-12T09:30:00Z' };
  await mailer.sendPasswordExpirySoon(prof, 5);
  m = last(); assert.equal(m.subject, 'Your password expires in 5 days'); assert.match(m.text, /Expires:\s+12 Nov 2026, 09:30 UTC/); save('5-expiry-soon', m);
  await mailer.sendPasswordExpirySoon(prof, 1); assert.equal(last().subject, 'Your password expires in 1 day');
  await mailer.sendPasswordExpired(prof);
  m = last(); assert.equal(m.subject, 'Your password has expired'); assert.match(m.text, /Expired:\s+12 Nov 2026/); save('6-expired', m);
  ok('expiry soon / expired: exact date in UTC and days left');

  await mailer.sendUnknownLogon(prof, { ip: '203.0.113.7', appName: 'Interstellar <Console>' });
  m = last(); assert.match(m.text, /IP address:\s+203\.0\.113\.7/); assert.ok(m.html.includes('Interstellar &lt;Console&gt;')); save('7-new-sign-in', m);
  ok('new sign-in: time, IP, app (escaped)');

  await mailer.sendTest('admin@example.com', { sentBy: 'admin' });
  m = last(); assert.equal(m.subject, 'Passport test email'); save('8-test', m); ok('test email uses the layout');

  console.log(`\nall ${n} passed; ${sink.messages.length} messages captured`);
  await pool.end(); sink.close();
})().catch((e) => { console.error(e); process.exit(1); });
