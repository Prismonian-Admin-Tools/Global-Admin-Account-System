'use strict';
const crypto = require('crypto');

// ---- similarity: two different metrics for two different jobs ----
//
// diceSimilarity compares two PLAINTEXT strings (e.g. a candidate
// password against a static banned word like "password") — used by the
// notSimilarTo rule below.
//
// simhash64 / simhashSimilarity compare a candidate password against a
// FINGERPRINT of a password we no longer have in plaintext (a retired
// password from history) — see password_simhash in migration 004.

function bigrams(str) {
  const s = str.toLowerCase();
  if (s.length < 2) return [s];
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** Sørensen–Dice coefficient over character bigrams, 0 (nothing alike) to 1 (identical). */
function diceSimilarity(a, b) {
  if (a === b) return 1;
  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);
  if (!bigramsA.length || !bigramsB.length) return 0;
  const counts = new Map();
  for (const bg of bigramsA) counts.set(bg, (counts.get(bg) || 0) + 1);
  let matches = 0;
  for (const bg of bigramsB) {
    const remaining = counts.get(bg) || 0;
    if (remaining > 0) { matches++; counts.set(bg, remaining - 1); }
  }
  return (2 * matches) / (bigramsA.length + bigramsB.length);
}

/**
 * 64-bit SimHash of a password's character-frequency histogram (weighted
 * per-character voting, not per-bigram), as a 16-char hex string. Lossy
 * by design — see migration 004's comment on password_simhash.
 *
 * Deliberately character-multiset based rather than order-based: "your
 * password can't be GoRams753%! one day and RamsGo766!% the next" is a
 * case where the letters and symbols are the exact same characters
 * rearranged and only the digits changed — two passwords like that share
 * almost the same character histogram even though a position-by-position
 * or bigram comparison would see them as quite different. This also
 * means it's coarse on short passwords (there just isn't much histogram
 * to compare), so treat the threshold as an estimate, not a certainty.
 */
function simhash64(password) {
  const counts = new Map();
  for (const ch of password.toLowerCase()) counts.set(ch, (counts.get(ch) || 0) + 1);
  const weights = new Array(64).fill(0);
  for (const [ch, count] of counts) {
    const digest = crypto.createHash('sha256').update(ch, 'utf8').digest();
    for (let bit = 0; bit < 64; bit++) {
      const byte = digest[Math.floor(bit / 8)];
      const isSet = (byte >> (bit % 8)) & 1;
      weights[bit] += isSet ? count : -count;
    }
  }
  let hex = '';
  for (let nibbleStart = 0; nibbleStart < 64; nibbleStart += 4) {
    let nibble = 0;
    for (let b = 0; b < 4; b++) {
      if (weights[nibbleStart + b] > 0) nibble |= (1 << b);
    }
    hex += nibble.toString(16);
  }
  return hex;
}

function hammingDistanceHex(hexA, hexB) {
  let distance = 0;
  for (let i = 0; i < hexA.length; i++) {
    let x = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    while (x) { distance += x & 1; x >>= 1; }
  }
  return distance;
}

/** 0 (nothing alike) to 1 (identical fingerprints) — an estimate, not an exact answer, since SimHash is lossy. */
function simhashSimilarity(hexA, hexB) {
  if (!hexA || !hexB) return 0;
  return 1 - hammingDistanceHex(hexA, hexB) / 64;
}

// ---- charset counters, used by the minCount rule type ----
const CHARSETS = {
  symbols: (ch) => !/[A-Za-z0-9\s]/.test(ch),
  numbers: (ch) => /[0-9]/.test(ch),
  letters: (ch) => /[A-Za-z]/.test(ch),
  uppercase: (ch) => /[A-Z]/.test(ch),
  lowercase: (ch) => /[a-z]/.test(ch),
};

function countMatching(password, charset) {
  const test = CHARSETS[charset];
  if (!test) throw new Error(`Unknown charset "${charset}"`);
  let n = 0;
  for (const ch of password) if (test(ch)) n++;
  return n;
}

// ---- rule types — add a new one here to make it available to every
// rule instance an admin creates through the UI/CLI, no other code
// changes needed. Each evaluate() returns null (passes) or a failure message. ----
const RULE_TYPES = {
  minLength: {
    evaluate(password, params, label) {
      const min = params.min || 8;
      if (password.length < min) return label;
      return null;
    },
  },
  minCount: {
    evaluate(password, params, label) {
      const min = params.min || 1;
      if (countMatching(password, params.charset) < min) return label;
      return null;
    },
  },
  noYears: {
    evaluate(password, params, label) {
      const minYear = params.minYear ?? 1900;
      const maxYear = params.maxYear ?? 2099;
      const found = password.match(/\d{4}/g) || [];
      for (const match of found) {
        const year = parseInt(match, 10);
        if (year >= minYear && year <= maxYear) return label;
      }
      return null;
    },
  },
  noSpaces: {
    evaluate(password, params, label) {
      return /\s/.test(password) ? label : null;
    },
  },
  notSimilarTo: {
    evaluate(password, params, label) {
      const threshold = params.threshold ?? 0.7;
      const values = params.values || [];
      for (const value of values) {
        if (diceSimilarity(password.toLowerCase(), String(value).toLowerCase()) >= threshold) return label;
      }
      return null;
    },
  },
};

/** Runs every enabled rule against a candidate password. Returns { ok, failures: [label, ...] }. */
function evaluatePassword(password, rules) {
  const failures = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const ruleType = RULE_TYPES[rule.type];
    if (!ruleType) continue; // an unknown/removed rule type shouldn't hard-fail every password
    const failure = ruleType.evaluate(password, rule.params || {}, rule.label);
    if (failure) failures.push(failure);
  }
  return { ok: failures.length === 0, failures };
}

// Fixed by spec, not one of the configurable rule instances above: a new
// password is rejected if it's this similar to either of the user's last
// two (now-retired) passwords.
const HISTORY_SIMILARITY_THRESHOLD = 0.7;

module.exports = { RULE_TYPES, evaluatePassword, diceSimilarity, simhash64, simhashSimilarity, HISTORY_SIMILARITY_THRESHOLD };
