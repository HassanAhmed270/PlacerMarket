/**
 * db/migrate.js
 *
 * Applies schema.sql to whatever DATABASE_URL points at. Deliberately
 * simple (no migration-history table, no up/down versioning) — this is a
 * single-shot "create everything" script matching the fact that schema.sql
 * itself is one flat file, not a migrations folder. Re-running this against
 * a database that already has the tables WILL fail on the CREATE TABLE
 * statements; drop the database first if you need a clean slate.
 *
 * Usage: npm run db:migrate
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate() {
  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(sql);
    // eslint-disable-next-line no-console
    console.log('schema.sql applied successfully.');
  } finally {
    await pool.end();
  }
}

migrate().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Migration failed:', err.message);
  process.exit(1);
});
