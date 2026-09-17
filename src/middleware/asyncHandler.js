'use strict';

/**
 * Express 4 doesn't forward a rejected promise from an async handler to
 * error middleware on its own — most POST/PUT/PATCH/DELETE routes in this
 * app wrap themselves in their own try/catch, but the plain read-only GET
 * handlers mostly didn't, so a thrown error (a DB hiccup, a malformed
 * query param) left that one request hanging with no response instead of
 * a clean 500. Wrapping with this wires them into the global error
 * handler in server.js the same way a synchronous throw already would be.
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { asyncHandler };
