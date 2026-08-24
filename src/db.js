'use strict';
const { Pool } = require('pg');

let pool = null;

function initPool(dbConfig) {
  pool = new Pool({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.name,
    user: dbConfig.user,
    password: dbConfig.password,
    ssl: dbConfig.ssl ? { rejectUnauthorized: false } : false,
  });
  return pool;
}

function getPool() {
  if (!pool) throw new Error('DB pool not initialized — call initPool() first');
  return pool;
}

module.exports = { initPool, getPool };
