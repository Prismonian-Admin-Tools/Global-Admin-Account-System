'use strict';

/**
 * Printed immediately before a command writes a live secret (an app
 * secret, a temporary password) to stdout. There's no way to reveal a
 * one-time secret to the operator without SOME output channel, but
 * stdout specifically risks long-term retention if this command is ever
 * run under a process supervisor, container orchestrator, or CI system
 * that captures it into persistent logs — this makes that risk visible
 * at the moment it matters instead of leaving it undocumented.
 */
function warnSecretOutput() {
  console.log('⚠  The next line(s) contain a secret that will not be shown again.');
  console.log('   Do not run this command where stdout is captured by a log aggregator, CI system, or process supervisor.');
}

module.exports = { warnSecretOutput };
