'use strict';
const { toProfile, isPasswordExpired } = require('../models/userStore');

const WARNING_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Password expiry is a matter of the clock passing, not an action anyone
 * takes — nothing else in the request path would ever notice it happen,
 * so this has to be polled rather than triggered. Sends each of
 * "Password expiry soon!" / "Password expired" at most once per expiry
 * date (tracked in password_expiry_notices, cleared whenever the
 * password actually changes).
 */
async function runPasswordExpirySweep({ userStore, mailer }) {
  const candidates = await userStore.listWithPasswordExpiry();
  for (const row of candidates) {
    const notice = await userStore.getExpiryNotice(row.uid);
    const profile = toProfile(row);
    const expiresAt = new Date(row.password_expires_at).getTime();
    const now = Date.now();

    if (isPasswordExpired(row)) {
      if (!notice || !notice.expired_sent_at) {
        await mailer.sendPasswordExpired(profile);
        await userStore.markExpiredNotified(row.uid);
      }
      continue;
    }

    const daysLeft = Math.ceil((expiresAt - now) / MS_PER_DAY);
    if (daysLeft <= WARNING_DAYS && (!notice || !notice.expiry_soon_sent_at)) {
      await mailer.sendPasswordExpirySoon(profile, daysLeft);
      await userStore.markExpirySoonNotified(row.uid);
    }
  }
}

module.exports = { runPasswordExpirySweep, WARNING_DAYS };
