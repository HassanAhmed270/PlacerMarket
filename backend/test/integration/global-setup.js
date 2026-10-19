const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const getTestDatabaseUrl = require('./database-url');

module.exports = async function globalSetup() {
  const testDatabaseUrl = getTestDatabaseUrl();
  const root = path.join(__dirname, '..', '..');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.query(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));

    const seed = spawnSync(process.execPath, [path.join(root, 'db', 'seed.js')], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: testDatabaseUrl },
      encoding: 'utf8',
    });
    if (seed.error || seed.status !== 0) {
      throw new Error(
        `db/seed.js failed (exit ${seed.status}): ${seed.error?.message || seed.stderr || seed.stdout}`
      );
    }

    const { rows } = await pool.query('SELECT version() AS version');
    console.log(`Integration database: ${rows[0].version}`);
  } finally {
    await pool.end();
  }
};
