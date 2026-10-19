const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const getTestDatabaseUrl = require('./database-url');

let client;
let server;
let stateFile;
let token;
let shuttingDown = false;

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function release() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (client) {
    try {
      await client.end();
    } catch {
      // Closing the connection releases a session advisory lock even if shutdown reports an error.
    }
  }
  if (stateFile && token) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (state.token === token) fs.unlinkSync(stateFile);
    } catch {
      // It may already have been removed by setup failure cleanup.
    }
  }
  emit({ type: 'released' });
  process.exit(0);
}

async function main() {
  const testDatabaseUrl = getTestDatabaseUrl();
  stateFile = process.env.INTEGRATION_LOCK_STATE_FILE;
  if (!stateFile) throw new Error('Integration lock state path was not provided.');

  const digest = crypto.createHash('sha256').update('poshaak-integration-schema-reset').digest();
  const lockKey1 = digest.readInt32BE(0);
  const lockKey2 = digest.readInt32BE(4);
  const { Client } = require('pg');
  client = new Client({ connectionString: testDatabaseUrl });
  await client.connect();
  const result = await client.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [lockKey1, lockKey2]);
  if (!result.rows[0].locked) {
    emit({ type: 'error', message: 'Another integration run already holds the PostgreSQL schema-reset lock for this database.' });
    await client.end();
    process.exitCode = 2;
    return;
  }

  token = crypto.randomBytes(32).toString('hex');
  server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/release' || req.headers['x-lock-token'] !== token) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"released":true}');
    await release();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, port, token }), { mode: 0o600 });
  process.on('SIGTERM', release);
  process.on('SIGINT', release);
  process.on('disconnect', release);
  emit({ type: 'ready', port, token });
}

main().catch(async (error) => {
  emit({ type: 'error', message: error.message });
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (client) {
    try {
      await client.end();
    } catch {
      // Keep the original setup error as the useful failure.
    }
  }
  process.exitCode = 1;
});
