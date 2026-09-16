// tests/setup.js
// Builds an in-memory, Postgres-compatible database (via pg-mem) and
// runs the REAL migration files against it -- the same SQL that would
// run against production PostgreSQL. This lets the test suite exercise
// real controller code and real SQL, not a hand-rolled mock of the
// database layer.
const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

function buildTestDb() {
  const db = newDb({ autoCreateForeignKeyIndices: true });

  // pg-mem's pgcrypto stub: gen_random_uuid(). impure:true is required --
  // without it, pg-mem treats the function as cacheable and reuses one
  // result across every row of a multi-row INSERT, which silently
  // produced duplicate-key errors during test development.
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    implementation: () => crypto.randomUUID(),
    impure: true,
  });

  const migrationsDir = path.join(__dirname, '..', 'src', 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
      .replace(/CREATE EXTENSION[^;]*;/gi, ''); // pg-mem doesn't need the real extension
    db.public.none(sql);
  }

  const seedSql = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'seed', 'seed_disciplines.sql'), 'utf8');
  db.public.none(seedSql);

  const { Pool } = db.adapters.createPg();
  return new Pool();
}

const crypto = require('crypto');

module.exports = { buildTestDb };
