// src/db/migrate.js
// Runs all migrations in order against a real PostgreSQL instance.
// Usage: DATABASE_URL=postgres://... node src/db/migrate.js
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate(pool) {
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    console.log(`Applying ${file}...`);
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await pool.query(sql);
  }
  console.log('All migrations applied.');

  // Real-world note: after migrations run, the application's own
  // database role should have its privileges revoked and re-granted
  // deliberately -- in particular, REVOKE UPDATE, DELETE ON audit_log
  // FROM the app role, so the insert-only guarantee in
  // AIDH_Database_Design.docx Section 7 is enforced by the database
  // itself, not only by application code discipline.
}

if (require.main === module) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  migrate(pool)
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { migrate };
