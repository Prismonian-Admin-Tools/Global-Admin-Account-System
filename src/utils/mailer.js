'use strict';
const nodemailer = require('nodemailer');

// Every send goes through here so the rest of the app never has to think
// about whether email is configured: if it isn't (or the user has no
// address on file), sendMail() is a silent, safe no-op instead of an
// exception a login/password-change flow would otherwise have to guard
// against. A transport is built fresh per send from the CURRENT database
// settings, the same "takes effect without a restart" pattern branding
// uses — SMTP is sent rarely enough that this isn't worth pooling.
class Mailer {
  constructor(emailSettingsStore) {
    this.emailSettingsStore = emailSettingsStore;
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

  async sendAccountCreated(user) {
    if (!user.email) return;
    await this.sendMail({
      to: user.email,
      subject: 'Your account was created',
      html: `<p>Hi ${escapeHtml(user.username)},</p>
        <p>An account was created for you. You'll be asked to set your own password the first time you sign in.</p>`,
    });
  }

  async sendPasswordChangeRequired(user) {
    if (!user.email) return;
    await this.sendMail({
      to: user.email,
      subject: 'Password change required',
      html: `<p>Hi ${escapeHtml(user.username)},</p>
        <p>Your password must be changed before you can continue using your account. You'll be prompted for a new one the next time you sign in.</p>`,
    });
  }

  async sendPasswordChanged(user) {
    if (!user.email) return;
    await this.sendMail({
      to: user.email,
      subject: 'Your password was changed',
      html: `<p>Hi ${escapeHtml(user.username)},</p>
        <p>Your account's password was just changed. If this wasn't you, contact a sysadmin right away.</p>`,
    });
  }

  async sendPasswordExpired(user) {
    if (!user.email) return;
    await this.sendMail({
      to: user.email,
      subject: 'Password expired',
      html: `<p>Hi ${escapeHtml(user.username)},</p>
        <p>Your password has expired. You'll need to set a new one the next time you sign in.</p>`,
    });
  }

  async sendPasswordExpirySoon(user, daysLeft) {
    if (!user.email) return;
    await this.sendMail({
      to: user.email,
      subject: 'Password expiry soon!',
      html: `<p>Hi ${escapeHtml(user.username)},</p>
        <p>Your password expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Change it soon to avoid being locked out.</p>`,
    });
  }

  async sendUnknownLogon(user, { ip, appName }) {
    if (!user.email) return;
    await this.sendMail({
      to: user.email,
      subject: 'Unknown logon point',
      html: `<p>Hi ${escapeHtml(user.username)},</p>
        <p>Your account just signed in${appName ? ` to ${escapeHtml(appName)}` : ''} from an address we haven't seen before (${escapeHtml(ip)}). If this wasn't you, contact a sysadmin right away.</p>`,
    });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

module.exports = { Mailer };
