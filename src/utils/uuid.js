'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every uid/appId lookup in this codebase ends up as `WHERE col = $1`
 * against a UUID-typed column. Postgres throws a type error for a
 * non-UUID string rather than just finding no rows, and that error was
 * propagating all the way up as an unhandled rejection — crashing the
 * whole server on a single malformed X-App-Id header, no auth required.
 * Callers use this to fail closed (return null / not-found) before ever
 * reaching the database with attacker-controlled input.
 */
function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

module.exports = { isUuid };
