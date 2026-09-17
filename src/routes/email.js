'use strict';
const express = require('express');

module.exports = function emailRoutes({ emailSettingsStore, mailer, userStore, activityLog }) {
  const router = express.Router();

  function actor(req) { return req.session.user.uid; }
  function actorName(req) { return req.session.user.username; }

  router.get('/email-settings', async (req, res) => {
    res.json(await emailSettingsStore.get());
  });

  router.put('/email-settings', express.json(), async (req, res) => {
    try {
      const { enabled, host, port, secure, username, password, fromAddress, fromName } = req.body || {};
      const settings = await emailSettingsStore.update({ enabled, host, port, secure, username, password, fromAddress, fromName });
      await activityLog.add('email', `${actorName(req)} updated the SMTP settings`, actor(req), actorName(req));
      res.json({ ok: true, settings });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/email-settings/test', express.json(), async (req, res) => {
    try {
      const me = await userStore.findByUid(req.session.user.uid);
      const to = req.body?.to || (me && me.email);
      if (!to) throw new Error('No recipient — pass "to", or set an email address on your own account first.');
      const result = await mailer.sendMail({
        to, subject: 'GAM test email',
        html: `<p>This is a test email from GAM, sent by ${req.session.user.username}. If you got this, SMTP is working.</p>`,
      });
      if (!result.sent) return res.status(400).json({ error: `Not sent: ${result.reason}` });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
