'use strict';
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { IpLookup } = require('./ipLookup');

// Every send goes through here so the rest of the app never has to think
// about whether email is configured: if it isn't (or the user has no
// address on file), sendMail() is a silent, safe no-op instead of an
// exception a login/password-change flow would otherwise have to guard
// against. A transport is built fresh per send from the CURRENT database
// settings, the same "takes effect without a restart" pattern branding
// uses — SMTP is sent rarely enough that this isn't worth pooling.
//
// Every notification uses renderEmail() below: the fixed banner
// (public/brand/email-banner.png, attached inline so it shows without the
// reader having to "load images" from our server), a heading, an optional
// details section and button, and a small footer — plus a plain-text
// version. Replies go to the Support email address set in Settings.

const BANNER_PATH = path.join(__dirname, '..', '..', 'public', 'brand', 'email-banner.png');
const BANNER_CID = 'banner@passport';
let bannerCache;
function bannerAttachment() {
  if (bannerCache === undefined) {
    try { bannerCache = fs.readFileSync(BANNER_PATH); } catch (err) {
      console.error('Email banner missing:', err.message);
      bannerCache = null;
    }
  }
  return bannerCache ? { filename: 'banner.png', content: bannerCache, cid: BANNER_CID, contentType: 'image/png' } : null;
}

class Mailer {
  /**
   * siteSettingsStore: site name, organization name and support email.
   * publicUrl: Passport's public address, for sign-in and reset links.
   * resetLinkStore: issues the one-time "Reset password" / "Wasn't you?" links.
   * ipLookup: config.ipLookup (city / ISP / VPN for unfamiliar sign-ins).
   */
  constructor(emailSettingsStore, { siteSettingsStore = null, publicUrl = null, resetLinkStore = null, ipLookup = {} } = {}) {
    this.emailSettingsStore = emailSettingsStore;
    this.siteSettingsStore = siteSettingsStore;
    this.publicUrl = publicUrl ? String(publicUrl).replace(/\/+$/, '') : null;
    this.resetLinkStore = resetLinkStore;
    this.ipLookup = ipLookup instanceof IpLookup ? ipLookup : new IpLookup(ipLookup);
  }

  async sendMail({ to, subject, html, text, replyTo, attachments }) {
    if (!to) return { sent: false, reason: 'no-recipient-address' };
    let settings;
    try {
      settings = await this.emailSettingsStore.getForSending();
    } catch (err) {
      console.error('Could not load email settings:', err.message);
      return { sent: false, reason: 'settings-unavailable' };
    }
    if (!settings || !settings.enabled || !settings.host) return { sent: false, reason: 'email-not-configured' };

    try {
      const transport = nodemailer.createTransport({
        host: settings.host,
        port: settings.port,
        secure: settings.secure,
        auth: settings.username ? { user: settings.username, pass: settings.password } : undefined,
      });
      await transport.sendMail({
        from: settings.fromAddress ? `"${settings.fromName}" <${settings.fromAddress}>` : settings.fromName,
        to, subject, html, text: text || html.replace(/<[^>]+>/g, ''),
        ...(replyTo ? { replyTo } : {}),
        ...(attachments && attachments.length ? { attachments } : {}),
      });
      return { sent: true };
    } catch (err) {
      console.error(`Failed to send email "${subject}" to ${to}:`, err.message);
      return { sent: false, reason: 'send-failed' };
    }
  }

  /** Site name, organization name and support email. Never throws. */
  async org() {
    const out = { siteName: 'Passport', orgName: '', supportEmail: '' };
    if (!this.siteSettingsStore) return out;
    try {
      const s = typeof this.siteSettingsStore.getFull === 'function'
        ? await this.siteSettingsStore.getFull() : await this.siteSettingsStore.get();
      if (s.siteName) out.siteName = s.siteName;
      out.orgName = s.orgName || '';
      out.supportEmail = s.supportEmail || '';
    } catch (err) {
      console.error('Could not load organization settings for email:', err.message);
    }
    return out;
  }

  /** A one-time /reset-password link, or null if links can't be made (no publicUrl / store). */
  async oneTimeLink(user, purpose) {
    if (!this.resetLinkStore || !this.publicUrl || !user.uid) return null;
    try {
      const token = await this.resetLinkStore.issue(user.uid, purpose);
      return `${this.publicUrl}/reset-password#${token}`;
    } catch (err) {
      console.error('Could not create one-time link:', err.message);
      return null;
    }
  }

  async send(to, org, content) {
    const { subject, html, text } = renderEmail({ ...content, org });
    const banner = bannerAttachment();
    return this.sendMail({
      to, subject, html, text,
      replyTo: org.supportEmail || undefined,
      attachments: banner ? [banner] : [],
    });
  }

  /** Settings check from the Email page / `email send-test`. */
  async sendTest(to, { sentBy = null } = {}) {
    const org = await this.org();
    return this.send(to, org, {
      subject: `${org.siteName} test email`,
      heading: 'Hello.',
      paragraphs: [`This is a test email from ${org.siteName}${sentBy ? `, sent by ${sentBy}` : ''}. If you can read it, email is working.`],
      footer: 'You are receiving this email because someone sent a test message from the email settings.',
    });
  }

  /**
   * password: the password the account was created with (temporary unless
   * it's a Provider account, see userStore.create()). rankLabel: the
   * rank's display name.
   */
  async sendAccountCreated(user, { password = null, rankLabel = null } = {}) {
    if (!user.email) return { sent: false, reason: 'no-recipient-address' };
    const org = await this.org();
    const who = org.orgName ? `${org.orgName} has created a ${org.siteName} account in your name.`
      : `A ${org.siteName} account has been created in your name.`;
    return this.send(user.email, org, {
      subject: `Your ${org.siteName} account`,
      heading: `Hello ${displayName(user)}.`,
      paragraphs: [`${who} Your account details are included.`],
      sectionTitle: 'Account details',
      rows: [
        ['Username', user.username],
        ...(password ? [['Password', password, { mono: true }]] : []),
        ['Rank', rankLabel || user.role],
      ],
      after: [
        this.publicUrl ? { text: 'Please sign in at ', link: this.publicUrl } : { text: 'Please sign in.' },
        ...(user.mustChangePassword !== false ? [{ text: 'You will be prompted to change your password at login.' }] : []),
      ],
      footer: 'You are receiving this email because an administrator has created an account in your name.',
    });
  }

  async sendUnknownLogon(user, { ip, headers = {} } = {}) {
    if (!user.email) return { sent: false, reason: 'no-recipient-address' };
    const [org, where, link] = await Promise.all([
      this.org(), this.ipLookup.lookup(ip, headers), this.oneTimeLink(user, 'compromised'),
    ]);
    const city = where.private ? 'Local network'
      : [where.city, where.region, where.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ') || 'Unknown';
    const rows = [
      ['IP address', ip || 'Unknown', { mono: true }],
      ['City', city],
      ['ISP', where.private ? 'Local network' : (where.isp || 'Unknown')],
    ];
    if (where.vpn) {
      rows.push(['Warning', `This sign-in came through a ${where.vpnType && where.vpnType !== 'Proxy' ? where.vpnType : 'VPN or proxy'}${where.isp ? ` (${where.isp})` : ''}, so the city above may not be where the person really is.`, { warn: true }]);
    }
    return this.send(user.email, org, {
      subject: 'New sign-in from an unfamiliar location',
      heading: `Hello ${displayName(user)}, you are receiving this email because someone has signed in from an unfamiliar location.`,
      sectionTitle: 'Information',
      rows,
      button: link ? { text: 'Wasn\'t you? Sign this user out and change your password.', url: link, danger: true } : null,
      after: link ? [] : [{ text: 'If this wasn\'t you, sign in and change your password right away.' }],
      footer: 'You are receiving this email because someone signed in to your account from a location it hasn\'t used before.',
    });
  }

  async sendPasswordExpirySoon(user) {
    if (!user.email) return { sent: false, reason: 'no-recipient-address' };
    const [org, link] = await Promise.all([this.org(), this.oneTimeLink(user, 'reset')]);
    const when = user.passwordExpiresAt ? ` on ${formatDate(user.passwordExpiresAt)}` : ' soon';
    return this.send(user.email, org, {
      subject: `Your password expires${when}`,
      heading: `Hello, ${displayName(user)}, you are receiving this email because your password is going to expire${when}. Please reset your password now.`,
      button: link ? { text: 'Reset password', url: link } : null,
      after: link ? [] : [{ text: 'Sign in and change your password from My Account.' }],
      footer: 'You are receiving this email because your account\'s password has an expiry date.',
    });
  }

  async sendPasswordExpired(user) {
    if (!user.email) return { sent: false, reason: 'no-recipient-address' };
    const [org, link] = await Promise.all([this.org(), this.oneTimeLink(user, 'reset')]);
    return this.send(user.email, org, {
      subject: 'Your password has expired',
      heading: `Hello, ${displayName(user)}, you are receiving this email because your password has expired. Please reset your password now.`,
      button: link ? { text: 'Reset password', url: link } : null,
      after: link ? [] : [{ text: 'You will be prompted to choose a new password the next time you sign in.' }],
      footer: 'You are receiving this email because your account\'s password has expired.',
    });
  }

  async sendPasswordChangeRequired(user) {
    if (!user.email) return { sent: false, reason: 'no-recipient-address' };
    const [org, link] = await Promise.all([this.org(), this.oneTimeLink(user, 'reset')]);
    return this.send(user.email, org, {
      subject: 'Please change your password',
      heading: `Hello ${displayName(user)}, you are receiving this email because an administrator has asked you to change your password.`,
      paragraphs: ['You will be prompted to change it the next time you sign in, or you can change it now.'],
      button: link ? { text: 'Reset password', url: link } : null,
      footer: 'You are receiving this email because a password change was required on your account.',
    });
  }

  /** changedBy: 'self' (the user changed it themselves) or 'admin' (an administrator reset it). */
  async sendPasswordChanged(user, { changedBy = 'self' } = {}) {
    if (!user.email) return { sent: false, reason: 'no-recipient-address' };
    const byAdmin = changedBy === 'admin';
    const [org, link] = await Promise.all([this.org(), byAdmin ? null : this.oneTimeLink(user, 'compromised')]);
    return this.send(user.email, org, {
      subject: 'Your password was changed',
      heading: byAdmin
        ? `Hello ${displayName(user)}, you are receiving this email because an administrator has reset the password for your account.`
        : `Hello ${displayName(user)}, you are receiving this email because the password for your account was just changed.`,
      paragraphs: byAdmin
        ? [`Your administrator will give you the new password.${user.mustChangePassword ? ' You will be prompted to change it at login.' : ''}`]
        : [],
      button: link ? { text: 'Wasn\'t you? Sign this user out and change your password.', url: link, danger: true } : null,
      after: !byAdmin && !link ? [{ text: 'If this wasn\'t you, contact your administrator right away.' }] : [],
      footer: 'You are receiving this security notice because your account\'s password changed.',
    });
  }
}

/* ---------------- rendering ---------------- */

const C = {
  page: '#f2f4f7', card: '#ffffff', text: '#1f2933', dim: '#52606d', faint: '#7b8794', border: '#e4e7eb',
  button: '#2676fd', danger: '#c62828', warnBg: '#fff4e5', warnText: '#8a4b00',
};
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

/**
 * heading (h1), paragraphs, sectionTitle (h2) + rows [[label, value, {mono, warn}]],
 * after (paragraphs after the section; {text, link?}), button {text, url, danger},
 * footer (h6; the support-contact sentence is appended automatically).
 */
function renderEmail({ subject, heading, paragraphs = [], sectionTitle, rows = [], after = [], button, footer, org }) {
  const contact = org.supportEmail
    ? `Please contact ${org.supportEmail} or reply to this email.`
    : 'Please contact your administrator.';
  const footerText = [footer, contact].filter(Boolean).join(' ');
  const p = (inner) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:${C.text};">${inner}</p>`;

  const rowsHtml = rows.map(([label, value, opt = {}]) => opt.warn
    ? `<tr><td colspan="2" style="padding:10px 12px;background:${C.warnBg};color:${C.warnText};font-size:14px;line-height:1.5;border-radius:4px;">&#9888;&#65039; ${esc(value)}</td></tr>`
    : `<tr>
        <td style="padding:6px 16px 6px 0;color:${C.dim};font-size:14px;white-space:nowrap;vertical-align:top;">${esc(label)}:</td>
        <td style="padding:6px 0;color:${C.text};font-size:15px;vertical-align:top;${opt.mono ? `font-family:${MONO};` : ''}">${esc(value)}</td>
      </tr>`).join('');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${C.card};border:1px solid ${C.border};font-family:${FONT};">
    <tr><td style="padding:0;"><img src="cid:${BANNER_CID}" width="600" alt="${esc(org.orgName || org.siteName)}" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
    <tr><td style="padding:28px 32px 8px;">
      <h1 style="margin:0 0 18px;font-size:22px;line-height:1.35;font-weight:700;color:${C.text};">${esc(heading)}</h1>
      ${paragraphs.map((t) => p(esc(t))).join('')}
      ${rows.length ? `${sectionTitle ? `<h2 style="margin:22px 0 8px;font-size:17px;font-weight:700;color:${C.text};">${esc(sectionTitle)}</h2>` : ''}
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">${rowsHtml}</table>` : ''}
      ${after.map((a) => p(`${esc(a.text)}${a.link ? `<a href="${esc(a.link)}" style="color:${C.button};">${esc(a.link)}</a>` : ''}`)).join('')}
      ${button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 18px;"><tr>
        <td style="background:${button.danger ? C.danger : C.button};border-radius:6px;">
          <a href="${esc(button.url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;line-height:1.3;color:#ffffff;text-decoration:none;">${esc(button.text)}</a>
        </td></tr></table>` : ''}
    </td></tr>
    <tr><td style="padding:14px 32px 24px;border-top:1px solid ${C.border};">
      <h6 style="margin:0;font-size:12px;line-height:1.5;font-weight:400;color:${C.faint};">${esc(footerText)}</h6>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;

  const width = Math.max(0, ...rows.filter((r) => !(r[2] || {}).warn).map(([l]) => l.length)) + 1;
  const text = [
    heading,
    '',
    ...paragraphs.flatMap((t) => [t, '']),
    ...(rows.length ? [
      ...(sectionTitle ? [sectionTitle, '-'.repeat(sectionTitle.length)] : []),
      ...rows.map(([label, value, opt = {}]) => (opt.warn ? `WARNING: ${value}` : `${`${label}:`.padEnd(width + 1)} ${value}`)),
      '',
    ] : []),
    ...after.flatMap((a) => [`${a.text}${a.link || ''}`, '']),
    ...(button ? [`${button.text}`, button.url, ''] : []),
    '--',
    footerText,
  ].join('\n');

  return { subject, html, text };
}

function displayName(user) {
  return (user.fullName || '').trim() || user.username;
}

/** "12 November 2026, 09:30 UTC" — explicit about the time zone, since the server's and the reader's can differ. */
function formatDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(d);
  return `${date}, ${time} UTC`;
}

function esc(s) {
  return String(s ?? '').replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[ch]));
}

module.exports = { Mailer, renderEmail, formatDate, escapeHtml: esc };
