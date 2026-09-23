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

  // pg-mem implements very few native SQL functions (its own error
  // message says so) -- TRIM(text) is standard, real-Postgres-supported
  // SQL (used in caseRegistry.controller.js's practitioner display-name
  // COALESCE), but pg-mem doesn't ship it. Registered here, the same way
  // gen_random_uuid is above, so the actual application SQL can stay
  // standard/correct rather than being rewritten around a test-harness
  // gap real Postgres doesn't have (confirmed via
  // scripts/verify-real-postgres.js, which needs no such workaround).
  db.public.registerFunction({
    name: 'trim',
    args: ['text'],
    returns: 'text',
    implementation: (s) => (s == null ? null : String(s).trim()),
  });

  // Same pg-mem gap as trim above -- NULLIF(a, b) is standard SQL
  // (returns NULL when a = b, else a), used alongside TRIM/COALESCE in
  // the same practitioner display-name expression.
  db.public.registerFunction({
    name: 'nullif',
    args: ['text', 'text'],
    returns: 'text',
    implementation: (a, b) => (a === b ? null : a),
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
