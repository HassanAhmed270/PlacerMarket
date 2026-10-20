/**
 * The only module that imports pg directly. Pool limits and short database
 * timeouts implement the web-process portion of FR-79c. Read and write use
 * the same pool today (FR-79e); query remains a compatibility entry point.
 */
const { Pool } = require('pg');
const { ServiceUnavailableError } = require('./lib/errors');

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: positiveInteger('DB_POOL_MAX', 10),
  connectionTimeoutMillis: positiveInteger('DB_CONNECTION_TIMEOUT_MS', 1000),
  idleTimeoutMillis: positiveInteger('DB_IDLE_TIMEOUT_MS', 30000),
  statement_timeout: positiveInteger('DB_STATEMENT_TIMEOUT_MS', 5000),
  idle_in_transaction_session_timeout: positiveInteger('DB_IDLE_TRANSACTION_TIMEOUT_MS', 10000),
  lock_timeout: positiveInteger('DB_LOCK_TIMEOUT_MS', 1000),
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected error on idle Postgres client', err);
});

function mapAcquireError(error) {
  if (error?.code === 'ETIMEDOUT' || /timeout exceeded when trying to connect/i.test(error?.message || '')) {
    return new ServiceUnavailableError();
  }
  return error;
}

/** FR-79e: read entry point, sharing the web pool until a replica is introduced. */
async function read(text, params = []) {
  try { return await pool.query(text, params); } catch (error) { throw mapAcquireError(error); }
}

/** FR-79e: write entry point, sharing the web pool until a replica is introduced. */
async function write(text, params = []) {
  try { return await pool.query(text, params); } catch (error) { throw mapAcquireError(error); }
}

/** Compatibility entry point for existing services; new code should use read/write. */
async function query(text, params = []) {
  return read(text, params);
}

async function many(text, params = []) {
  const { rows } = await read(text, params);
  return rows;
}

async function one(text, params = []) {
  const { rows } = await read(text, params);
  return rows[0] ?? null;
}

/** Run a callback in one transaction and always release its client. */
async function withTransaction(callback) {
  let client;
  try {
    client = await pool.connect();
  } catch (error) {
    throw mapAcquireError(error);
  }
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    const result = await callback(client);
    await client.query('COMMIT');
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try { await client.query('ROLLBACK'); } catch (_) { /* preserve the original transaction error */ }
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { read, write, query, many, one, withTransaction, pool };
