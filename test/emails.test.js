'use strict';
// Integration test for Passport's notification emails, the emailed one-time
// links, and the unfamiliar-sign-in IP lookup. Emails are captured by a local
// SMTP sink (test/smtpSink.js, port 2525); proxycheck.io is faked on port
// 2526. Needs a DISPOSABLE Postgres database: it creates t_* accounts and
// OVERWRITES the email + organization settings.
//   GUS_CONFIG=/path/to/test-config.yml npm run test:email [-- <output dir>]
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const REPO = path.join(__dirname, '..');
const { loadConfig } = require(`${REPO}/src/config`);
const { initPool } = require(`${REPO}/src/db`);
const { UserStore } = require(`${REPO}/src/models/userStore`);
const { RankStore } = require(`${REPO}/src/models/rankStore`);
const { SessionStore } = require(`${REPO}/src/models/sessionStore`);
const { ActivityLog } = require(`${REPO}/src/models/activityLog`);
const { PasswordPolicyStore } = require(`${REPO}/src/models/passwordPolicyStore`);
const { EmailSettingsStore } = require(`${REPO}/src/models/emailSettingsStore`);
const { SiteSettingsStore } = require(`${REPO}/src/models/siteSettingsStore`);
const { ResetLinkStore } = require(`${REPO}/src/models/resetLinkStore`);
const { Mailer } = require(`${REPO}/src/utils/mailer`);
const { IpLookup, isPrivateIp } = require(`${REPO}/src/utils/ipLookup`);
const resetLinkRoutes = require(`${REPO}/src/routes/resetLinks`);
const { startSink } = require('./smtpSink');

// Rendered copies of every email (HTML + text) are written here for eyeballing.
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'passport-emails-'));

/** Pulls headers, the text/plain + text/html parts and inline attachments out of a raw captured message. */
function parse(raw) {
  const header = (name) => {
    const m = new RegExp(`^${name}: (.*(?:\\n[ \\t].*)*)`, 'mi').exec(raw.split('\n\n')[0]);
    if (!m) return null;
    return m[1].replace(/\n[ \t]/g, ' ').replace(/=\?UTF-8\?Q\?([^?]*)\?=/gi, (_, q) => Buffer.from(q.replace(/_/g, ' ')
      .replace(/=([0-9A-F]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8')).replace(/\?=\s+=\?UTF-8\?Q\?/gi, '');
  };
  const boundaries = [...raw.matchAll(/boundary="?([^";\s]+)"?/g)].map((m) => m[1]);
  let chunks = [raw];
  for (const b of boundaries) chunks = chunks.flatMap((c) => c.split(`--${b}`));
  const out = { subject: header('Subject'), replyTo: header('Reply-To'), cids: [] };
  for (const p of chunks) {
    const type = (/Content-Type: ([^;\s]+)/i.exec(p) || [])[1];
    const cid = (/Content-ID: <([^>]+)>/i.exec(p) || [])[1];
    if (cid) out.cids.push(cid);
    if (!type || !/^text\/(plain|html)$/i.test(type)) continue;
    const enc = (/Content-Transfer-Encoding: (\S+)/i.exec(p) || [])[1] || '7bit';
    let body = p.split(/\n\n/).slice(1).join('\n\n');
    if (/quoted-printable/i.test(enc)) body = Buffer.from(body.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
    else if (/base64/i.test(enc)) body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8');
    out[/html/i.test(type) ? 'html' : 'text'] = body.trim();
  }
  return out;
}

(async () => {
  const sink = await startSink(2525);
  // Fake proxycheck.io: 203.0.113.7 is a VPN, 198.51.100.9 an ordinary ISP, anything else errors.
  const pcCalls = [];
  const fakePc = http.createServer((req, res) => {
    const ip = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
    pcCalls.push({ ip, key: new URL(req.url, 'http://x').searchParams.get('key') });
    const data = {
      '203.0.113.7': { asn: 'AS9009', provider: 'M247 Europe SRL', country: 'Netherlands', region: 'North Holland', city: 'Amsterdam', proxy: 'yes', type: 'VPN' },
      '198.51.100.9': { asn: 'AS7922', provider: 'Comcast Cable Communications', country: 'United States', region: 'Colorado', city: 'Denver', proxy: 'no', type: 'Residential' },
    }[ip];
    res.writeHead(data ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data ? { status: 'ok', [ip]: data } : { status: 'error', message: 'boom' }));
  });
  await new Promise((r) => fakePc.listen(2526, '127.0.0.1', r));

  const config = loadConfig();
  const pool = initPool(config.database);
  const rankStore = new RankStore(pool);
  // A permanent admin, so the "at least one full admin" trigger lets cleanup
  // delete the Provider account a previous run created.
  if (!(await new UserStore(pool, rankStore).findByUsername('root'))) {
    await new UserStore(pool, rankStore).create({ username: 'root', password: 'password123', role: 'systemAdministrator' });
  }
  await pool.query("DELETE FROM users WHERE uid IN (SELECT uid FROM usernames WHERE username LIKE 't\\_%')");
  const ess = new EmailSettingsStore(pool, { encryptionKey: config.server.encryptionKey });
  await ess.update({ enabled: true, host: '127.0.0.1', port: 2525, secure: false, fromAddress: 'noreply@prismonian.com', fromName: 'Passport' });
  const site = new SiteSettingsStore(pool);
  await site.update({ siteName: 'Passport', orgName: 'Prismonian', supportEmail: 'support@prismonian.com' });
  const resetLinkStore = new ResetLinkStore(pool);
  const ipLookup = new IpLookup({ proxycheck: { apiKey: 'test-key' } }, { proxycheckUrl: 'http://127.0.0.1:2526/' });
  const mailer = new Mailer(ess, { siteSettingsStore: site, publicUrl: 'https://auth.prismonian.com/', resetLinkStore, ipLookup });
  const userStore = new UserStore(pool, rankStore, mailer);
  const sessionStore = new SessionStore(pool, config.session);
  const last = () => parse(sink.messages[sink.messages.length - 1]);
  const save = (name, m) => { fs.writeFileSync(`${OUT}/${name}.html`, m.html.replace(/cid:banner@passport/g, `file://${REPO}/public/brand/email-banner.png`)); fs.writeFileSync(`${OUT}/${name}.txt`, `Subject: ${m.subject}\n\n${m.text}`); };
  const tokenOf = (m) => (/reset-password#([A-Za-z0-9_-]+)/.exec(m.text) || [])[1];
  let n = 0; const ok = (s) => console.log(`ok ${++n} - ${s}`);

  // ---- account created ----
  const pw = 'Tmp<&"\'Pass9';
  const ada = await userStore.create({ username: 't_ada', password: pw, role: 'staff', fullName: 'Ada Lovelace', email: 'ada@example.com' });
  let m = last();
  const staffLabel = (await rankStore.findByName('staff')).label;
  assert.equal(m.subject, 'Your Passport account');
  assert.match(m.html, /<h1[^>]*>Hello Ada Lovelace\.<\/h1>/);
  assert.ok(m.text.includes('Prismonian has created a Passport account in your name. Your account details are included.'));
  assert.match(m.html, /<h2[^>]*>Account details<\/h2>/);
  assert.match(m.text, /Username:\s+t_ada/); assert.match(m.text, new RegExp(`Rank:\\s+${staffLabel}`));
  assert.ok(m.text.includes(pw) && m.html.includes('Tmp&lt;&amp;&quot;&#39;Pass9') && !m.html.includes(pw), 'password present, escaped in HTML');
  assert.ok(m.text.includes('Please sign in at https://auth.prismonian.com'));
  assert.ok(m.text.includes('You will be prompted to change your password at login.'));
  assert.match(m.html, /<h6[^>]*>You are receiving this email because an administrator has created an account in your name\. Please contact support@prismonian\.com or reply to this email\.<\/h6>/);
  assert.equal(m.replyTo, 'support@prismonian.com');
  assert.ok(m.cids.includes('banner@passport') && m.html.includes('src="cid:banner@passport"'), 'banner attached inline');
  save('1-account-created', m); ok('account created: spec layout, username/password/rank, sign-in URL, footer, reply-to, inline banner');

  await site.update({ orgName: '', supportEmail: '' });
  await userStore.create({ username: 't_prov', password: 'ProviderPass1', role: 'trustedInstaller', email: 'prov@example.com' });
  m = last();
  assert.ok(m.text.includes('A Passport account has been created in your name.'));
  assert.doesNotMatch(m.text, /prompted to change/); assert.ok(m.text.includes('Please contact your administrator.')); assert.equal(m.replyTo, null);
  await site.update({ orgName: 'Prismonian', supportEmail: 'support@prismonian.com' });
  ok('no organization / support email set: neutral wording, no reply-to; Provider account not told to change password');

  // ---- unfamiliar sign-in ----
  const prof = await userStore.getProfile(ada.uid);
  await mailer.sendUnknownLogon(prof, { ip: '203.0.113.7', headers: {} });
  m = last();
  assert.equal(m.subject, 'New sign-in from an unfamiliar location');
  assert.match(m.html, /<h1[^>]*>Hello Ada Lovelace, you are receiving this email because someone has signed in from an unfamiliar location\.<\/h1>/);
  assert.match(m.html, /<h2[^>]*>Information<\/h2>/);
  assert.match(m.text, /IP address:\s+203\.0\.113\.7/); assert.match(m.text, /City:\s+Amsterdam, North Holland, Netherlands/);
  assert.match(m.text, /ISP:\s+M247 Europe SRL/); assert.match(m.text, /WARNING: This sign-in came through a VPN/);
  assert.ok(m.text.includes("Wasn't you? Sign this user out and change your password."));
  const compromisedToken = tokenOf(m);
  const link = await resetLinkStore.find(compromisedToken);
  assert.equal(link.purpose, 'compromised'); assert.equal(link.uid, ada.uid);
  assert.equal(pcCalls.at(-1).key, 'test-key');
  save('2-unfamiliar-sign-in-vpn', m);
  ok('unfamiliar sign-in: IP, city, ISP, VPN warning, working "Wasn\'t you?" link');

  await mailer.sendUnknownLogon(prof, { ip: '198.51.100.9' });
  m = last(); assert.match(m.text, /City:\s+Denver, Colorado, United States/); assert.match(m.text, /ISP:\s+Comcast/); assert.doesNotMatch(m.text, /WARNING/);
  const callsBefore = pcCalls.length;
  await mailer.sendUnknownLogon(prof, { ip: '198.51.100.9' });
  assert.equal(pcCalls.length, callsBefore, 'second lookup served from cache');
  await mailer.sendUnknownLogon(prof, { ip: '192.0.2.44' });
  m = last(); assert.match(m.text, /City:\s+Unknown/); assert.match(m.text, /ISP:\s+Unknown/);
  await mailer.sendUnknownLogon(prof, { ip: '::ffff:192.168.1.20' });
  m = last(); assert.match(m.text, /City:\s+Local network/);
  assert.ok(!pcCalls.some((c) => c.ip.includes('192.168')), 'private IPs never sent to proxycheck');
  ok('ordinary ISP (no warning), cached lookups, lookup failure -> Unknown, private IP never looked up');

  const trusting = new IpLookup({ trustLocationHeaders: true, proxycheck: { enabled: false } });
  const r1 = await trusting.lookup('198.51.100.9', { 'cf-ipcity': 'S%C3%A3o%20Paulo', 'cf-region': 'Sao Paulo', 'cf-ipcountry': 'BR' });
  assert.deepEqual([r1.city, r1.region, r1.country, r1.isp], ['São Paulo', 'Sao Paulo', 'BR', null]);
  const untrusting = new IpLookup({ proxycheck: { enabled: false } });
  assert.equal((await untrusting.lookup('198.51.100.9', { 'cf-ipcity': 'Fake' })).city, null);
  assert.ok(isPrivateIp('10.1.2.3') && isPrivateIp('172.20.0.1') && isPrivateIp('fd00::1') && isPrivateIp('100.64.0.1') && !isPrivateIp('8.8.8.8'));
  ok('location headers used only when trusted; private-range detection');

  // ---- expiry ----
  const exp = { ...prof, passwordExpiresAt: '2026-11-12T09:30:00Z' };
  await mailer.sendPasswordExpirySoon(exp, 5);
  m = last();
  assert.equal(m.subject, 'Your password expires on 12 November 2026, 09:30 UTC');
  assert.match(m.html, /<h1[^>]*>Hello, Ada Lovelace, you are receiving this email because your password is going to expire on 12 November 2026, 09:30 UTC\. Please reset your password now\.<\/h1>/);
  assert.ok(m.text.includes('Reset password')); assert.equal((await resetLinkStore.find(tokenOf(m))).purpose, 'reset');
  save('3-password-expiring', m);
  await mailer.sendPasswordExpired(exp);
  m = last();
  assert.match(m.html, /your password has expired\. Please reset your password now\.<\/h1>/); assert.doesNotMatch(m.html, /<h1[^>]*>[^<]*November/);
  save('4-password-expired', m);
  ok('expiry soon (with date) / expired (no date), each with a working Reset password link');

  // ---- changed / change required ----
  await userStore.update(ada.uid, { mustChangePassword: false });
  await userStore.update(ada.uid, { mustChangePassword: true });
  m = last(); assert.equal(m.subject, 'Please change your password'); assert.ok(tokenOf(m)); save('5-change-required', m);
  await userStore.resetPassword(ada.uid, 'AdminSet123!');
  m = last(); assert.match(m.html, /an administrator has reset the password/); assert.equal(tokenOf(m), undefined); assert.doesNotMatch(m.text, /AdminSet123/);
  save('6-password-reset-by-admin', m);
  assert.equal(await resetLinkStore.find(compromisedToken), null, 'password change cancelled outstanding links');
  await userStore.resetPassword(ada.uid, 'SelfSet1234!', { clearMustChange: true, changedBy: 'self' });
  m = last(); assert.match(m.html, /was just changed/); assert.equal((await resetLinkStore.find(tokenOf(m))).purpose, 'compromised');
  save('7-password-changed', m);
  await mailer.sendTest('admin@example.com', { sentBy: 'admin' });
  m = last(); assert.equal(m.subject, 'Passport test email'); save('8-test', m);
  ok('change required, admin reset (no link, no password), self change (Wasn\'t you? link), password change cancels old links, test email');

  // ---- one-time link API ----
  const app = express();
  app.use('/api', resetLinkRoutes({ resetLinkStore, userStore, sessionStore, passwordPolicyStore: new PasswordPolicyStore(pool), activityLog: new ActivityLog(pool) }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const api = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const tok = await resetLinkStore.issue(ada.uid, 'compromised');
  await sessionStore.issue(ada.uid, null).catch(() => {});
  await pool.query(`INSERT INTO frontend_sessions (sid, sess, expire) VALUES ('t-sid', $1, now() + interval '1 hour')`, [JSON.stringify({ user: { uid: ada.uid } })]);
  let r = await api('/reset-link/inspect', { token: tok });
  assert.equal(r.status, 200); assert.deepEqual([r.body.purpose, r.body.username, r.body.signedOut, r.body.blocked], ['compromised', 't_ada', false, null]);
  r = await api('/reset-link/sign-out', { token: tok });
  assert.equal(r.status, 200);
  assert.equal((await pool.query(`SELECT 1 FROM frontend_sessions WHERE sid = 't-sid'`)).rowCount, 0, 'website session ended');
  assert.equal((await pool.query('SELECT 1 FROM sessions WHERE uid = $1', [ada.uid])).rowCount, 0, 'app sessions ended');
  assert.equal((await api('/reset-link/inspect', { token: tok })).body.signedOut, true);
  r = await api('/reset-link/complete', { token: tok, newPassword: 'short', confirmPassword: 'short' });
  assert.equal(r.status, 400); assert.match(r.body.error, /at least 8/);
  r = await api('/reset-link/complete', { token: tok, newPassword: 'Kite#Lamp!482', confirmPassword: 'nope' });
  assert.equal(r.status, 400);
  assert.ok(await resetLinkStore.find(tok), 'failed attempts do not use the link up');
  r = await api('/reset-link/complete', { token: tok, newPassword: 'Kite#Lamp!482', confirmPassword: 'Kite#Lamp!482' });
  assert.equal(r.status, 200);
  assert.equal((await userStore.verify('t_ada', 'Kite#Lamp!482')).status, 'good', 'new password works, no forced change');
  r = await api('/reset-link/complete', { token: tok, newPassword: 'Other#Pass!731', confirmPassword: 'Other#Pass!731' });
  assert.equal(r.status, 400); assert.match(r.body.error, /already been used/);
  assert.equal((await api('/reset-link/inspect', { token: 'garbage' })).status, 400);
  ok('one-time link API: inspect, sign out (app + website sessions), validation, set password, single use');

  const t2 = await resetLinkStore.issue(ada.uid, 'reset');
  await userStore.update(ada.uid, { disabled: true });
  r = await api('/reset-link/inspect', { token: t2 }); assert.match(r.body.blocked, /disabled/);
  r = await api('/reset-link/complete', { token: t2, newPassword: 'Brave#Owl!519', confirmPassword: 'Brave#Owl!519' });
  assert.equal(r.status, 400); assert.match(r.body.error, /disabled/);
  await userStore.update(ada.uid, { disabled: false });
  await pool.query("UPDATE password_reset_links SET expires_at = now() - interval '1 minute' WHERE uid = $1", [ada.uid]);
  assert.equal((await api('/reset-link/inspect', { token: t2 })).status, 400, 'expired link rejected');
  ok('disabled account blocked; expired link rejected');

  console.log(`\nall ${n} passed; ${sink.messages.length} messages captured; previews in ${OUT}`);
  server.close(); fakePc.close(); sink.close();
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
