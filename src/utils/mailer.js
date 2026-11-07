'use strict';
const nodemailer = require('nodemailer');

// Every send goes through here so the rest of the app never has to think
// about whether email is configured: if it isn't (or the user has no
// address on file), sendMail() is a silent, safe no-op instead of an
// exception a login/password-change flow would otherwise have to guard
// against. A transport is built fresh per send from the CURRENT database
// settings, the same "takes effect without a restart" pattern branding
// uses — SMTP is sent rarely enough that this isn't worth pooling.
//
// Every notification is built by renderEmail() below: one branded HTML
// layout (table-based with inline styles, since that's what email clients
// actually render) plus a real plain-text version, not tag-stripped HTML.
class Mailer {
  /**
   * siteSettingsStore: optional — supplies the site name (and logo) shown
   * in emails, so a rename in Branding shows up without a restart.
   * publicUrl: optional — Passport's public address, for sign-in buttons.
   */
  constructor(emailSettingsStore, { siteSettingsStore = null, publicUrl = null } = {}) {
    this.emailSettingsStore = emailSettingsStore;
    this.siteSettingsStore = siteSettingsStore;
    this.publicUrl = publicUrl ? String(publicUrl).replace(/\/+$/, '') : null;
  }

  async sendMail({ to, subject, html, text }) {
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
      });
      return { sent: true };
    } catch (err) {
      console.error(`Failed to send email "${subject}" to ${to}:`, err.message);
      return { sent: false, reason: 'send-failed' };
    }
  }

  /** Site name + logo URL for the email header. Never throws — falls back to "Passport". */
  async branding() {
    let siteName = 'Passport';
    let logoUrl = null;
    if (this.siteSettingsStore) {
      try {
        const s = await this.siteSettingsStore.get();
        if (s && s.siteName) siteName = s.siteName;
        if (s && s.logoExt && this.publicUrl) logoUrl = `${this.publicUrl}/branding/logo.${s.logoExt}`;
      } catch (err) {
        console.error('Could not load branding for email:', err.message);
      }
    }
    return { siteName, logoUrl };
  }

  /** Builds a notification from structured content and sends it. */
  async sendNotification(user, content) {
    if (!user.email) return { sent: false, reason: 'no-recipient-address' };
    const brand = await this.branding();
    const { subject, html, text } = renderEmail({ ...content, brand, signInUrl: this.publicUrl, recipient: user });
    return this.sendMail({ to: user.email, subject, html, text });
  }

  /** Settings check from the Email page / `email send-test`, in the same layout as real notifications. */
  async sendTest(to, { sentBy = null } = {}) {
    const brand = await this.branding();
    const { subject, html, text } = renderEmail({
      subject: `${brand.siteName} test email`,
      preheader: 'Your email settings are working.',
      heading: 'Email is working',
      intro: [`If you can read this, ${brand.siteName} can send email with its current settings. Account notifications (new accounts, password changes, expiry reminders and new sign-in alerts) will be delivered like this one.`],
      details: [['Sent to', to], ['Sent', formatDate(new Date())], ...(sentBy ? [['Sent by', sentBy]] : [])],
      footerReason: 'You\'re receiving this because someone sent a test message from the email settings.',
      brand, signInUrl: null, recipient: { username: 'there' },
    });
    return this.sendMail({ to, subject, html, text });
  }

  /**
   * password: the password the account was created with, included so the
   * new user can actually sign in. Labelled "temporary" whenever the
   * account must change it at first sign-in (every account except a
   * Provider/trustedInstaller one, see userStore.create()).
   */
  async sendAccountCreated(user, { password = null } = {}) {
    const temporary = user.mustChangePassword !== false;
    const details = [
      ['Username', user.username, { mono: true }],
      ...(password ? [[temporary ? 'Temporary password' : 'Password', password, { mono: true, strong: true }]] : []),
      ...(user.fullName ? [['Name', user.fullName]] : []),
      ['Email', user.email],
    ];
    const steps = [
      `Sign in${this.publicUrl ? ` at ${this.publicUrl}` : ''} with the username and ${temporary ? 'temporary ' : ''}password above.`,
      ...(temporary ? ['You\'ll be asked to choose a new password of your own straight away — the temporary one stops working once you do.'] : []),
      ...(user.needsOnboarding ? ['A short setup will walk you through adding your name and profile picture.'] : []),
    ];
    return this.sendNotification(user, {
      subject: 'Your account is ready',
      preheader: `Your username is ${user.username}.`,
      heading: 'Welcome aboard',
      intro: [`An account has been created for you. Here are your sign-in details:`],
      details,
      stepsTitle: 'Getting started',
      steps,
      button: 'Sign in',
      notice: password
        ? `Keep this email private${temporary ? ' and change your password at first sign-in' : ''}. ${'Never share your password — an administrator will never ask you for it.'}`
        : null,
      footerReason: 'You\'re receiving this because an administrator created an account for this email address. If you weren\'t expecting it, let your administrator know.',
    });
  }

  async sendPasswordChangeRequired(user) {
    return this.sendNotification(user, {
      subject: 'Action needed: change your password',
      preheader: 'You\'ll be asked for a new password the next time you sign in.',
      heading: 'Please change your password',
      intro: ['An administrator has asked you to change your password.'],
      details: [['Username', user.username, { mono: true }], ['Requested', formatDate(new Date())]],
      stepsTitle: 'What happens next',
      steps: [
        'The next time you sign in, you\'ll be asked to choose a new password before you can continue.',
        'Your current password still works until then, but only to get you to that step.',
      ],
      button: 'Sign in and change it',
      footerReason: 'You\'re receiving this because a password change was required on your account.',
    });
  }

  /** changedBy: 'self' (the user changed it themselves) or 'admin' (an administrator reset it). */
  async sendPasswordChanged(user, { changedBy = 'self' } = {}) {
    const byAdmin = changedBy === 'admin';
    return this.sendNotification(user, {
      subject: 'Your password was changed',
      preheader: byAdmin ? 'An administrator reset your password.' : 'Your password was just changed.',
      heading: 'Your password was changed',
      intro: [byAdmin
        ? 'An administrator has reset the password on your account.'
        : 'The password on your account was just changed.'],
      details: [
        ['Username', user.username, { mono: true }],
        ['Changed', formatDate(new Date())],
        ['Changed by', byAdmin ? 'An administrator' : 'You'],
        ...(byAdmin && user.mustChangePassword ? [['Next sign-in', 'You\'ll be asked to choose a new password']] : []),
      ],
      notice: byAdmin
        ? 'Your administrator will give you the new password. Any apps you were signed in to have been signed out.'
        : 'If you didn\'t make this change, contact your administrator immediately — someone else may have access to your account.',
      noticeTone: byAdmin ? 'info' : 'warning',
      button: 'Sign in',
      footerReason: 'You\'re receiving this security notice because your account\'s password changed.',
    });
  }

  async sendPasswordExpired(user) {
    return this.sendNotification(user, {
      subject: 'Your password has expired',
      preheader: 'Choose a new password the next time you sign in.',
      heading: 'Your password has expired',
      intro: ['Your password has reached its expiry date.'],
      details: [
        ['Username', user.username, { mono: true }],
        ...(user.passwordExpiresAt ? [['Expired', formatDate(user.passwordExpiresAt)]] : []),
      ],
      stepsTitle: 'What to do',
      steps: [
        'Sign in with your current password.',
        'You\'ll be asked to choose a new one before you can continue.',
      ],
      button: 'Sign in and update it',
      footerReason: 'You\'re receiving this because your account\'s password expired.',
    });
  }

  async sendPasswordExpirySoon(user, daysLeft) {
    const when = daysLeft <= 0 ? 'today' : `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
    return this.sendNotification(user, {
      subject: `Your password expires ${when}`,
      preheader: `Change it before it expires to avoid interruption.`,
      heading: `Your password expires ${when}`,
      intro: ['Change your password before it expires to avoid being interrupted at sign-in.'],
      details: [
        ['Username', user.username, { mono: true }],
        ...(user.passwordExpiresAt ? [['Expires', formatDate(user.passwordExpiresAt)]] : []),
        ['Time left', daysLeft <= 0 ? 'Less than a day' : `${daysLeft} day${daysLeft === 1 ? '' : 's'}`],
      ],
      stepsTitle: 'How to change it',
      steps: ['Sign in and open My Account.', 'Choose Change password and enter a new one.'],
      button: 'Change password',
      footerReason: 'You\'re receiving this reminder because your account\'s password has an expiry date.',
    });
  }

  async sendUnknownLogon(user, { ip, appName }) {
    return this.sendNotification(user, {
      subject: 'New sign-in to your account',
      preheader: `Signed in from ${ip}${appName ? ` to ${appName}` : ''}.`,
      heading: 'New sign-in from an unfamiliar address',
      intro: ['Your account just signed in from an address it hasn\'t used before.'],
      details: [
        ['Username', user.username, { mono: true }],
        ['When', formatDate(new Date())],
        ['IP address', ip, { mono: true }],
        ...(appName ? [['Signed in to', appName]] : []),
      ],
      notice: 'If this was you — say, on a new device or network — you don\'t need to do anything. If it wasn\'t, sign in, change your password right away and use Sign out everywhere in My Account, then tell your administrator.',
      noticeTone: 'warning',
      button: 'Review my account',
      footerReason: 'You\'re receiving this security notice because of a sign-in to your account.',
    });
  }
}

/* ---------------- rendering ---------------- */

const COLORS = {
  page: '#f2f4f7', card: '#ffffff', text: '#1f2933', dim: '#52606d', faint: '#7b8794',
  border: '#e4e7eb', accent: '#0e8fa3', detailBg: '#f7f9fb',
  warnBg: '#fff7e6', warnBorder: '#f0b429', infoBg: '#eaf6f8', infoBorder: '#0e8fa3',
};
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

function renderEmail({ subject, preheader, heading, intro = [], details = [], stepsTitle, steps = [], button, notice, noticeTone = 'info', footerReason, brand, signInUrl, recipient }) {
  const c = COLORS;
  const name = (recipient.fullName || '').trim().split(/\s+/)[0] || recipient.username;

  const detailRows = details.map(([label, value, opt = {}]) => `
    <tr>
      <td style="padding:8px 0;color:${c.dim};font-size:13px;width:150px;vertical-align:top;">${escapeHtml(label)}</td>
      <td style="padding:8px 0;color:${c.text};font-size:14px;vertical-align:top;${opt.mono ? `font-family:${MONO};` : ''}${opt.strong ? 'font-weight:700;font-size:16px;letter-spacing:.5px;' : ''}">${escapeHtml(value)}</td>
    </tr>`).join('');

  const tone = noticeTone === 'warning' ? [c.warnBg, c.warnBorder] : [c.infoBg, c.infoBorder];

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${c.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader || '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${c.page};">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:${FONT};">
    <tr><td style="padding:0 4px 16px;font-size:18px;font-weight:700;color:${c.text};">
      ${brand.logoUrl ? `<img src="${escapeHtml(brand.logoUrl)}" alt="" height="28" style="height:28px;vertical-align:middle;margin-right:8px;border:0;">` : ''}<span style="vertical-align:middle;">${escapeHtml(brand.siteName)}</span>
    </td></tr>
    <tr><td style="background:${c.card};border:1px solid ${c.border};border-top:4px solid ${c.accent};border-radius:8px;padding:28px 28px 24px;">
      <h1 style="margin:0 0 16px;font-size:21px;line-height:1.3;color:${c.text};">${escapeHtml(heading)}</h1>
      <p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:${c.text};">Hi ${escapeHtml(name)},</p>
      ${intro.map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:${c.text};">${escapeHtml(p)}</p>`).join('')}
      ${details.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;background:${c.detailBg};border:1px solid ${c.border};border-radius:6px;"><tr><td style="padding:8px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${detailRows}</table>
      </td></tr></table>` : ''}
      ${steps.length ? `${stepsTitle ? `<p style="margin:20px 0 8px;font-size:14px;font-weight:700;color:${c.text};">${escapeHtml(stepsTitle)}</p>` : ''}
        <ol style="margin:0 0 12px;padding-left:20px;font-size:14px;line-height:1.6;color:${c.text};">${steps.map((s) => `<li style="margin:0 0 4px;">${escapeHtml(s)}</li>`).join('')}</ol>` : ''}
      ${button && signInUrl ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 8px;"><tr><td style="background:${c.accent};border-radius:6px;">
        <a href="${escapeHtml(signInUrl)}" style="display:inline-block;padding:11px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(button)}</a>
      </td></tr></table>
      <p style="margin:0 0 4px;font-size:12px;color:${c.faint};">Or open <a href="${escapeHtml(signInUrl)}" style="color:${c.accent};">${escapeHtml(signInUrl)}</a></p>` : ''}
      ${notice ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0;"><tr>
        <td style="background:${tone[0]};border-left:4px solid ${tone[1]};border-radius:4px;padding:12px 14px;font-size:13px;line-height:1.5;color:${c.text};">${escapeHtml(notice)}</td>
      </tr></table>` : ''}
    </td></tr>
    <tr><td style="padding:16px 8px 0;font-size:12px;line-height:1.5;color:${c.faint};">
      ${footerReason ? `${escapeHtml(footerReason)}<br>` : ''}This is an automated message from ${escapeHtml(brand.siteName)} — replies aren't monitored.
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;

  const width = Math.max(0, ...details.map(([label]) => label.length)) + 2;
  const text = [
    brand.siteName,
    '',
    heading,
    '='.repeat(Math.min(heading.length, 60)),
    '',
    `Hi ${name},`,
    '',
    ...intro.flatMap((p) => [p, '']),
    ...(details.length ? [...details.map(([label, value]) => `  ${`${label}:`.padEnd(width)} ${value}`), ''] : []),
    ...(steps.length ? [...(stepsTitle ? [stepsTitle] : []), ...steps.map((s, i) => `  ${i + 1}. ${s}`), ''] : []),
    ...(button && signInUrl ? [`${button}: ${signInUrl}`, ''] : []),
    ...(notice ? [`NOTE: ${notice}`, ''] : []),
    '--',
    ...(footerReason ? [footerReason] : []),
    `This is an automated message from ${brand.siteName}; replies aren't monitored.`,
  ].join('\n');

  return { subject, html, text };
}

/** "7 Nov 2026, 14:03 UTC" — explicit about the time zone, since the server's and the reader's can differ. */
function formatDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
  }).format(d)} UTC`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[ch]));
}

module.exports = { Mailer, renderEmail, formatDate, escapeHtml };
