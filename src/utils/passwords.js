'use strict';
const bcrypt = require('bcryptjs');

function hash(plaintext) {
  return bcrypt.hashSync(plaintext, 12);
}

function verify(plaintext, hashed) {
  if (!plaintext || !hashed) return false;
  return bcrypt.compareSync(plaintext, hashed);
}

module.exports = { hash, verify };
