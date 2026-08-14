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
  return cfg;
}

module.exports = { loadConfig, CONFIG_PATH };
