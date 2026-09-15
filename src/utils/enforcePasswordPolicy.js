'use strict';
const { evaluatePassword, simhash64, simhashSimilarity, HISTORY_SIMILARITY_THRESHOLD } = require('./passwordPolicy');

/**
 * The one place both self-service password-change routes (apiV1's
 * /change-password and the frontend's PUT /account/password) call before
 * accepting a new password. Deliberately NOT called from userStore.
 * resetPassword() itself, from routes/users.js's admin reset, or from
 * the CLI — that's what makes policy and history checks "bypassed when
 * changing someone's password from console" true by construction rather
 * than by a special-cased flag.
 *
 * Throws a plain Error with a user-facing message on the first violation
 * found; callers already funnel Error.message into a 400 response.
 */
async function enforcePasswordPolicy({ passwordPolicyStore, userStore, uid, password }) {
  const rules = await passwordPolicyStore.listEnabled();
  const { ok, failures } = evaluatePassword(password, rules);
  if (!ok) throw new Error(`Password does not meet requirements: ${failures.join('; ')}`);

  const candidateFingerprint = simhash64(password);
  const priorFingerprints = await userStore.getPasswordFingerprints(uid);
  for (const fingerprint of priorFingerprints) {
    if (simhashSimilarity(candidateFingerprint, fingerprint) >= HISTORY_SIMILARITY_THRESHOLD) {
      throw new Error('This password is too similar to one of your last two passwords. Choose something more different.');
    }
  }
}

module.exports = { enforcePasswordPolicy };
