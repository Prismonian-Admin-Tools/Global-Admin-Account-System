'use strict';
// Minimal migration runner — good enough for a handful of hand-written
// .sql files. No down-migrations by design: this is a young project,
// schema changes go forward.
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../config');
const { initPool } = require('../db');

async function run() {
  const cfg = loadConfig();
  const pool = initPool(cfg.database);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const dir = __dirname;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const { rows } = await pool.query('SELECT 1 FROM _migrations WHERE filename = $1', [file]);
    if (rows.length) {
      console.log(`skip  ${file} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`apply ${file}`);
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  }

  console.log('Migrations up to date.');
  await pool.end();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
