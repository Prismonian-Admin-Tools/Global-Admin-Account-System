'use strict';

/**
 * Simple fixed-window counter per calling app, kept in memory. Good
 * enough for a single-process deployment; if the GUS is ever scaled out
 * to multiple processes this should move to Redis so the counters are
 * shared. Applied AFTER requireApp, so req.callingApp is always set.
 */
function perAppRateLimit({ maxRequestsPerMinute }) {
  const buckets = new Map(); // appId -> { count, windowStart }

  return (req, res, next) => {
    const appId = req.callingApp && req.callingApp.app_id;
    if (!appId) return next(); // shouldn't happen, requireApp runs first

    const now = Date.now();
    let bucket = buckets.get(appId);
    if (!bucket || now - bucket.windowStart >= 60_000) {
      bucket = { count: 0, windowStart: now };
      buckets.set(appId, bucket);
    }
    bucket.count += 1;

    if (bucket.count > maxRequestsPerMinute) {
      const retryAfterSeconds = Math.ceil((bucket.windowStart + 60_000 - now) / 1000);
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ status: 'rate_limited', retryAfterSeconds });
    }
    next();
  };
}

module.exports = { perAppRateLimit };
