'use strict';
const express = require('express');

function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.join(',');
  const lines = rows.map((r) => columns.map((c) => esc(r[c])).join(','));
  return [header, ...lines].join('\n');
}

module.exports = function activityRoutes({ activityLog, failedLoginStore }) {
  const router = express.Router();

  function parseFilters(req) {
    return {
      limit: req.query.limit,
      category: req.query.category || null,
      actor: req.query.actor || null,
      from: req.query.from || null,
      to: req.query.to || null,
    };
  }

  router.get('/activity', async (req, res) => {
    res.json(await activityLog.list(parseFilters(req)));
  });

  router.get('/activity/categories', async (req, res) => {
    res.json(await activityLog.categories());
  });

  router.get('/activity/export', async (req, res) => {
    const rows = await activityLog.list({ ...parseFilters(req), limit: 5000 });
    const csv = toCsv(rows, ['created_at', 'category', 'actor_username', 'message']);
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="gus-activity-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  });

  router.get('/failed-logins', async (req, res) => {
    res.json(await failedLoginStore.list(50));
  });

  return router;
};
