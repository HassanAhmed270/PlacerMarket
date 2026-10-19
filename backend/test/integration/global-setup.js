const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const getTestDatabaseUrl = require('./database-url');
const lockStatePath = require('./lock-state');

function waitForLockHolder(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: child.stdout });
    const timeout = setTimeout(() => finish(new Error('Timed out acquiring the integration database lock.')), timeoutMs);
    let settled = false;
    function finish(error, state) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      error ? reject(error) : resolve(state);
    }
    function onExit(code) {
      finish(new Error(code === 2
        ? 'Another integration run already holds the PostgreSQL schema-reset lock for this database.'
        : `Integration lock holder exited before acquiring the lock (exit ${code}).`));
    }
    function onError(error) {
      finish(new Error(`Could not start integration lock holder: ${error.message}`));
    }
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type === 'ready') finish(null, message);
      else if (message.type === 'error') finish(new Error(message.message));
    });
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function releaseLock(state, timeoutMs = 5000) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: state.port, path: '/release', method: 'POST',
      headers: { 'x-lock-token': state.token, connection: 'close' }, timeout: timeoutMs,
    }, (res) => {
      res.resume();
      res.on('end', () => res.statusCode === 200
        ? resolve()
        : reject(new Error(`Integration lock holder refused release (HTTP ${res.statusCode}).`)));
    });
    req.on('timeout', () => req.destroy(new Error('Timed out releasing integration database lock.')));
    req.on('error', reject);
    req.end();
  });
}

async function waitForStateFileRemoval(stateFile, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (fs.existsSync(stateFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !fs.existsSync(stateFile);
}

module.exports = async function globalSetup() {
  // Validate before spawning a process that can connect, and before any SQL runs.
  const testDatabaseUrl = getTestDatabaseUrl();
  const stateFile = lockStatePath(testDatabaseUrl);
  const root = path.join(__dirname, '..', '..');
  const child = spawn(process.execPath, [path.join(__dirname, 'lock-holder.js')], {
    cwd: root,
    env: {
      ...process.env,
      TEST_DATABASE_URL: testDatabaseUrl,
      INTEGRATION_LOCK_STATE_FILE: stateFile,
    },
    stdio: ['ignore', 'pipe', 'ignore', 'ipc'],
    windowsHide: true,
  });
  child.unref();
  child.channel?.unref();
  child.stdout.on('data', () => {}); // waitForLockHolder reads lines; keep the pipe drained afterwards.

  let state;
  try {
    state = await waitForLockHolder(child);
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: testDatabaseUrl });
    try {
      // The lock holder owns a dedicated Client connection and already holds the advisory lock.
      await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await pool.query(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));

      const seed = spawn(process.execPath, [path.join(root, 'db', 'seed.js')], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: testDatabaseUrl },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const seedOutput = await new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        seed.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
        seed.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
        seed.once('error', reject);
        seed.once('exit', (code) => code === 0
          ? resolve(stdout)
          : reject(new Error(`db/seed.js failed (exit ${code}): ${stderr || stdout}`)));
      });
      const { rows } = await pool.query('SELECT version() AS version');
      console.log(`Integration database: ${rows[0].version}`);
      if (!seedOutput.includes('platform_settings seeded:')) {
        throw new Error('db/seed.js exited successfully without its expected completion output.');
      }
    } finally {
      await pool.end();
    }
  } catch (error) {
    try {
      if (state) {
        await releaseLock(state);
        if (!await waitForStateFileRemoval(stateFile)) throw new Error('Lock holder cleanup timed out.');
      }
      else if (child.pid) child.kill('SIGTERM');
    } catch {
      if (child.pid) child.kill('SIGTERM');
      await waitForStateFileRemoval(stateFile);
    }
    throw error;
  }
};
