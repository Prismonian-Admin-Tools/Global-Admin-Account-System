'use strict';
const bcrypt = require('bcryptjs');

function hash(plaintext) {
  return bcrypt.hashSync(plaintext, 12);
}

function verify(plaintext, hashed) {
  if (!plaintext || !hashed) return false;
  return bcrypt.compareSync(plaintext, hashed);
}

// A known-username wrong-password check runs a real bcrypt compare
// (~100ms+ at cost 12); an unknown-username check that skips straight to
// "no" returns near-instantly. That gap lets an attacker distinguish
// valid from invalid usernames by timing alone. Computed once, at
// startup, so checking against it costs the same as a real compare
// without hashing something on every request.
const DUMMY_HASH = bcrypt.hashSync('gam-timing-safety-dummy-password', 12);

/** Burns the same time a real verify() would, for the "user not found" path — see DUMMY_HASH above. */
function verifyDummy() {
  bcrypt.compareSync('irrelevant', DUMMY_HASH);
}

module.exports = { hash, verify, verifyDummy };
