// src/db/seed.js
// Runs seed data (currently: the 18 marketplace disciplines) against a
// real PostgreSQL instance. Usage: DATABASE_URL=postgres://... node src/db/seed.js
//
// Found missing entirely during a real-Postgres verification pass: a
// fresh deployment that only ran `npm run migrate` (the documented
// deploy step) would end up with an empty `disciplines` table -- and
// since createMatch(), listDisciplines(), and case-registry submission
// all depend on at least one row existing there, the entire marketplace
// and case-registry submission flow would be broken out of the box on
// first deploy, silently, with no error at migration time. The test
// suite never caught this because tests/setup.js's pg-mem harness loads
// the seed file itself as a convenience for tests -- migrate.js, the
// actual production deploy script, never did.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function seed(pool) {
  const seedDir = path.join(__dirname, 'seed');
  const files = fs.readdirSync(seedDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    console.log(`Seeding ${file}...`);
    const sql = fs.readFileSync(path.join(seedDir, file), 'utf8');
    await pool.query(sql);
  }
  console.log('All seed data applied.');
}

if (require.main === module) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  seed(pool)
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { seed };
