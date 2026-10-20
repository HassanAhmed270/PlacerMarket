/**
 * FR-79b: apply ordered, versioned PostgreSQL migrations as a separate deploy step.
 * Existing schema.sql databases must be explicitly baselined after the structural
 * compatibility check; normal migration runs never overwrite or reset them.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATIONS_TABLE = 'schema_migrations';
const INITIAL_MIGRATION = '001_initial_schema.sql';

function parseInitialSchema(sql) {
  const tables = new Map();
  const tablePattern = /CREATE\s+TABLE\s+([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)^[ \t]*\);/gim;
  for (const match of sql.matchAll(tablePattern)) {
    const columns = [];
    for (const line of match[2].split(/\r?\n/)) {
      const column = line.match(/^\s*(?!(?:KEY|PRIMARY|UNIQUE|FOREIGN|EXCLUDE|CONSTRAINT|CHECK)\b)([a-z_][a-z0-9_]*)\s+[A-Z]/i);
      if (column) columns.push(column[1].toLowerCase());
    }
    tables.set(match[1].toLowerCase(), columns);
  }

  const enums = new Map();
  const enumPattern = /CREATE\s+TYPE\s+([a-z_][a-z0-9_]*)\s+AS\s+ENUM\s*\(([^)]*)\)/gim;
  for (const match of sql.matchAll(enumPattern)) {
    enums.set(match[1].toLowerCase(), [...match[2].matchAll(/'((?:''|[^'])*)'/g)].map((value) => value[1].replace(/''/g, "'")));
  }
  return { tables, enums };
}

async function getSchemaState(pool, schema) {
  const { rows: historyRows } = await pool.query(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [`${quoteIdentifier(schema)}.${quoteIdentifier(MIGRATIONS_TABLE)}`]
  );
  const historyExists = historyRows[0].exists;
  let appliedCount = 0;
  if (historyExists) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM ${quoteIdentifier(schema)}.${quoteIdentifier(MIGRATIONS_TABLE)}`
    );
    appliedCount = rows[0].count;
  }

  const { rows: relationRows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
         AND c.oid <> COALESCE(to_regclass($2)::oid, 0)
         AND NOT EXISTS (
           SELECT 1 FROM pg_depend d
           WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
             AND d.refclassid = 'pg_class'::regclass AND d.refobjid = to_regclass($2)
             AND d.deptype IN ('a', 'i')
         )
     ) AS has_relations`,
    [schema, `${quoteIdentifier(schema)}.${quoteIdentifier(MIGRATIONS_TABLE)}`]
  );
  const { rows: enumRows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1 AND t.typtype IN ('e', 'd')
     ) AS has_types`,
    [schema]
  );
  return {
    historyExists,
    appliedCount,
    hasApplicationObjects: relationRows[0].has_relations || enumRows[0].has_types,
  };
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

async function assertInitialSchemaCompatible(pool, schema) {
  const initialSql = fs.readFileSync(path.join(MIGRATIONS_DIR, INITIAL_MIGRATION), 'utf8');
  const expected = parseInitialSchema(initialSql);
  const { rows: columns } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1`,
    [schema]
  );
  const actualColumns = new Map();
  for (const { table_name: tableName, column_name: columnName } of columns) {
    if (!actualColumns.has(tableName)) actualColumns.set(tableName, new Set());
    actualColumns.get(tableName).add(columnName);
  }

  const missing = [];
  for (const [tableName, expectedColumns] of expected.tables) {
    const actual = actualColumns.get(tableName);
    if (!actual) missing.push(`${tableName} (table)`);
    else for (const column of expectedColumns) if (!actual.has(column)) missing.push(`${tableName}.${column}`);
  }

  const { rows: enumLabels } = await pool.query(
    `SELECT t.typname AS type_name, e.enumlabel AS enum_label
     FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     JOIN pg_enum e ON e.enumtypid = t.oid WHERE n.nspname = $1`, [schema]
  );
  const actualEnums = new Map();
  for (const { type_name: typeName, enum_label: enumLabel } of enumLabels) {
    if (!actualEnums.has(typeName)) actualEnums.set(typeName, new Set());
    actualEnums.get(typeName).add(enumLabel);
  }
  for (const [enumName, values] of expected.enums) {
    const actual = actualEnums.get(enumName);
    if (!actual) missing.push(`${enumName} (enum)`);
    else for (const value of values) if (!actual.has(value)) missing.push(`${enumName}.${value}`);
  }

  if (missing.length) {
    throw new Error(
      `Existing database does not match the initial migration; refusing to baseline. Missing: ${missing.slice(0, 8).join(', ')}`
    );
  }
}

async function inspectDatabase(databaseUrl, schema = 'public') {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for database migrations.');
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 1000 });
  try {
    return { pool, state: await getSchemaState(pool, schema) };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

async function runMigrations({
  databaseUrl = process.env.DATABASE_URL,
  migrationsDir = MIGRATIONS_DIR,
  schema = 'public',
  baselineExisting = false,
} = {}) {
  const { pool, state } = await inspectDatabase(databaseUrl, schema);
  try {
    if (baselineExisting) {
      if (state.historyExists) throw new Error('Cannot baseline a database that already has migration history.');
      if (!state.hasApplicationObjects) throw new Error('Cannot baseline an empty database; run ordinary migrations.');
      await assertInitialSchemaCompatible(pool, schema);
    } else if (!state.historyExists && state.hasApplicationObjects) {
      throw new Error(
        'Database has an existing schema but no migration history. No changes were made. After verifying compatibility, run the explicit db:migrate:baseline command once.'
      );
    } else if (state.historyExists && state.appliedCount === 0 && state.hasApplicationObjects) {
      throw new Error('Database has application objects but empty migration history. Inspect and reconcile it before retrying.');
    }
  } finally {
    await pool.end();
  }

  const { runner } = await import('node-pg-migrate');
  return runner({
    databaseUrl: {
      connectionString: databaseUrl,
      connectionTimeoutMillis: 1000,
      statement_timeout: 5000,
      idle_in_transaction_session_timeout: 10000,
      lock_timeout: 1000,
    },
    dir: migrationsDir,
    migrationsTable: MIGRATIONS_TABLE,
    migrationsSchema: schema,
    schema,
    createSchema: true,
    createMigrationsSchema: true,
    direction: 'up',
    checkOrder: true,
    singleTransaction: true,
    advisoryLockMode: 'wait',
    count: baselineExisting ? 1 : undefined,
    fake: baselineExisting,
    verbose: false,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const baselineExisting = args.includes('--baseline-existing');
  const unknown = args.filter((arg) => arg !== '--baseline-existing');
  if (unknown.length) throw new Error(`Unknown migration option: ${unknown[0]}`);
  const result = await runMigrations({ baselineExisting });
  // eslint-disable-next-line no-console
  console.log(baselineExisting
    ? 'Existing schema baseline recorded without changing application data.'
    : `Migrations complete (${result.length} applied).`);
}

if (require.main === module) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseInitialSchema, getSchemaState, assertInitialSchemaCompatible, runMigrations };
