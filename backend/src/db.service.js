/**
 * db.service.js
 *
 * The ONLY file in this backend that imports `pg` directly. Every
 * modules/*.service.js file gets its database access through the two
 * functions exported here (`query` and `withTransaction`) — never by
 * requiring `pg` itself.
 *
 * This file owns no business logic and no domain knowledge. If you find
 * yourself adding an `if (table === 'orders')` branch here, that logic
 * belongs in the owning module's service file instead.
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Individual PG* env vars also work as a fallback via the pg library's
  // own defaults if DATABASE_URL isn't set — left unconfigured here on
  // purpose so ops can choose either style.
});

pool.on('error', (err) => {
  // A background/idle client error should not crash the process, but it
  // must not be swallowed silently either.
  // eslint-disable-next-line no-console
  console.error('Unexpected error on idle Postgres client', err);
});

/**
 * Run a single parameterized query.
 * @param {string} text - SQL with $1, $2... placeholders
 * @param {Array<any>} params
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params = []) {
  return pool.query(text, params);
}

/**
 * Run a query and return all rows (an array, possibly empty).
 * @returns {Promise<any[]>}
 */
async function many(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

/**
 * Run a query and return the first row, or null when there is none. A missing
 * row is NOT turned into an error here — call sites throw their own
 * NotFoundError so the message names the entity.
 * @returns {Promise<any | null>}
 */
async function one(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows[0] ?? null;
}

/**
 * Run a callback inside a single transaction. The callback receives a
 * client whose `.query(text, params)` participates in the transaction.
 * Commits on success, rolls back and rethrows on any error.
 *
 * Use this for anything that touches more than one table where partial
 * writes would leave the data inconsistent (e.g. accepting an offer +
 * creating the order + updating the listing status all need to succeed
 * or fail together).
 *
 * @param {(client: import('pg').PoolClient) => Promise<any>} callback
 */
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, many, one, withTransaction, pool };
