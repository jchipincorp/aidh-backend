// src/config/db.js
// Real pg Pool for production. Tests substitute this with a pg-mem
// adapter that implements the same interface -- see tests/setup.js.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  // A crashed idle client should not crash the whole process.
  console.error('Unexpected error on idle database client', err);
});

module.exports = pool;
