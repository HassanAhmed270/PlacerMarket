const fs = require('fs');
const path = require('path');
const os = require('os');
const { Pool } = require('pg');
const db = require('../../src/db.service');
const { runMigrations } = require('../../db/migrate');

const databaseUrl = process.env.TEST_DATABASE_URL;
const initialSchema = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '001_initial_schema.sql'), 'utf8');
const schemas = new Set();
const applicationMigrationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poshaak-application-migrations-'));
fs.copyFileSync(
  path.join(__dirname, '..', '..', 'db', 'migrations', '001_initial_schema.sql'),
  path.join(applicationMigrationDir, '001_initial_schema.sql')
);
const authMigrationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poshaak-auth-migrations-'));
fs.copyFileSync(
  path.join(__dirname, '..', '..', 'db', 'migrations', '001_initial_schema.sql'),
  path.join(authMigrationDir, '001_initial_schema.sql')
);
fs.copyFileSync(
  path.join(__dirname, '..', '..', 'db', 'migrations', '003_auth_foundation.sql'),
  path.join(authMigrationDir, '003_auth_foundation.sql')
);
fs.copyFileSync(
  path.join(__dirname, '..', '..', 'db', 'migrations', '004_email_code_purpose.sql'),
  path.join(authMigrationDir, '004_email_code_purpose.sql')
);

function newSchemaName() {
  const name = `migration_probe_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  schemas.add(name);
  return name;
}

async function createSchema(name) {
  await db.query(`CREATE SCHEMA "${name}"`);
}

async function dropSchema(name) {
  await db.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
  schemas.delete(name);
}

afterEach(async () => {
  for (const schema of [...schemas]) await dropSchema(schema);
});

afterAll(() => {
  fs.rmSync(applicationMigrationDir, { recursive: true, force: true });
  fs.rmSync(authMigrationDir, { recursive: true, force: true });
});

describe('FR-79b PostgreSQL migration runner', () => {
  test('FR-84: the auth foundation migration creates sessions, factor, reset, and code tables', async () => {
    const schema = newSchemaName();
    const applied = await runMigrations({ databaseUrl, schema, migrationsDir: authMigrationDir });
    expect(applied).toHaveLength(3);
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = ANY($2::text[]) ORDER BY table_name`,
      [schema, ['auth_sessions', 'email_login_codes', 'password_reset_tokens', 'staff_totp_credentials']]
    );
    expect(rows.map((row) => row.table_name)).toEqual([
      'auth_sessions', 'email_login_codes', 'password_reset_tokens', 'staff_totp_credentials',
    ]);
    const columns = await db.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      [schema, 'users']
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining([
      'email_verified_at', 'password_changed_at',
    ]));
    const codeColumns = await db.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      [schema, 'email_login_codes']
    );
    expect(codeColumns.rows.map((row) => row.column_name)).toContain('purpose');
  });

  test('fresh schema applies its ordered migration once and is idempotent', async () => {
    const schema = newSchemaName();
    const first = await runMigrations({ databaseUrl, schema, migrationsDir: applicationMigrationDir });
    const second = await runMigrations({ databaseUrl, schema, migrationsDir: applicationMigrationDir });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    const { rows } = await db.query(`SELECT count(*)::int AS count FROM "${schema}".schema_migrations`);
    expect(rows[0].count).toBe(1);
  });

  test('existing compatible schema can be baselined without changing application data', async () => {
    const schema = newSchemaName();
    await createSchema(schema);
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${schema}", public`);
        await client.query(initialSchema);
        await client.query("INSERT INTO cities (name) VALUES ('migration baseline preservation probe')");
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }

    await expect(runMigrations({ databaseUrl, schema, migrationsDir: applicationMigrationDir })).rejects.toThrow(/explicit db:migrate:baseline/);
    await runMigrations({ databaseUrl, schema, migrationsDir: applicationMigrationDir, baselineExisting: true });
    const { rows } = await db.query(`SELECT name FROM "${schema}".cities`);
    expect(rows).toEqual([{ name: 'migration baseline preservation probe' }]);
    const history = await db.query(`SELECT name FROM "${schema}".schema_migrations`);
    expect(history.rows).toEqual([{ name: '001_initial_schema' }]);
  });

  test('unrecognized existing schema is refused without changing its rows', async () => {
    const schema = newSchemaName();
    await createSchema(schema);
    await db.query(`CREATE TABLE "${schema}".keep_me (value text)`);
    await db.query(`INSERT INTO "${schema}".keep_me VALUES ('untouched')`);

    await expect(runMigrations({ databaseUrl, schema, migrationsDir: applicationMigrationDir, baselineExisting: true }))
      .rejects.toThrow(/does not match the initial migration/);
    const { rows } = await db.query(`SELECT value FROM "${schema}".keep_me`);
    expect(rows).toEqual([{ value: 'untouched' }]);
    const history = await db.query(
      "SELECT to_regclass($1) AS history", [`${schema}.schema_migrations`]
    );
    expect(history.rows[0].history).toBeNull();
  });

  test('failed migration rolls back and can be retried after the migration is corrected', async () => {
    const schema = newSchemaName();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poshaak-migration-retry-'));
    const migrationPath = path.join(dir, '001_retry.sql');
    try {
      await createSchema(schema);
      fs.writeFileSync(migrationPath, 'CREATE TABLE retry_probe (id integer); SELECT 1 / 0;');
      let migrationError;
      try {
        await runMigrations({ databaseUrl, schema, migrationsDir: dir });
      } catch (error) {
        migrationError = error;
      }
      expect(migrationError).toEqual(expect.objectContaining({
        message: expect.stringMatching(/division by zero/i),
        code: '22012',
      }));

      const afterFailure = await db.query(
        "SELECT to_regclass($1) AS relation", [`${schema}.retry_probe`]
      );
      expect(afterFailure.rows[0].relation).toBeNull();
      const historyAfterFailure = await db.query(
        `SELECT name FROM "${schema}".schema_migrations WHERE name = $1`, ['001_retry']
      );
      expect(historyAfterFailure.rows).toEqual([]);

      fs.writeFileSync(migrationPath, 'CREATE TABLE retry_probe (id integer);');
      await expect(runMigrations({ databaseUrl, schema, migrationsDir: dir })).resolves.toHaveLength(1);
      const afterRetry = await db.query(`SELECT to_regclass($1) AS relation`, [`${schema}.retry_probe`]);
      expect(afterRetry.rows[0].relation).not.toBeNull();
      const historyAfterRetry = await db.query(
        `SELECT name FROM "${schema}".schema_migrations WHERE name = $1`, ['001_retry']
      );
      expect(historyAfterRetry.rows).toEqual([{ name: '001_retry' }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('concurrent migration runners serialize and record the initial migration once', async () => {
    const schema = newSchemaName();
    const results = await Promise.all([
      runMigrations({ databaseUrl, schema, migrationsDir: applicationMigrationDir }),
      runMigrations({ databaseUrl, schema, migrationsDir: applicationMigrationDir }),
    ]);
    const { rows } = await db.query(`SELECT count(*)::int AS count FROM "${schema}".schema_migrations`);
    expect(rows[0].count).toBe(1);
    expect(results.flat()).toHaveLength(1);
  });
});
