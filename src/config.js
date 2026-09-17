'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const CONFIG_PATH = process.env.GUS_CONFIG || path.join(__dirname, '..', 'config', 'config.yml');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const cfg = yaml.load(raw);
  const root = path.join(__dirname, '..');
  cfg.avatars.directory = path.resolve(root, cfg.avatars.directory);
  cfg.activity.file = path.resolve(root, cfg.activity.file);
  cfg.failedLogins.file = path.resolve(root, cfg.failedLogins.file);
  // Required separately from sessionSecret — see config.yml.example.
  // Deliberately not defaulted to sessionSecret: that's exactly the
  // key-reuse this field exists to end.
  if (!cfg.server || !cfg.server.encryptionKey) {
    throw new Error(
      'config.server.encryptionKey is required (signs nothing — encrypts the SMTP password, MFA secrets, and the ' +
      'OIDC signing key at rest). Add a random value to config.yml; see config.yml.example.'
    );
  }
  return cfg;
}

module.exports = { loadConfig, CONFIG_PATH };
