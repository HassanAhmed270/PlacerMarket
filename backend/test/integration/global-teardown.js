const fs = require('fs');
const getTestDatabaseUrl = require('./database-url');
const lockStatePath = require('./lock-state');

module.exports = async function globalTeardown() {
  const stateFile = lockStatePath(getTestDatabaseUrl());
  if (!fs.existsSync(stateFile)) {
    throw new Error('Integration lock state is missing; refusing to report teardown as successful.');
  }

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const http = require('http');
  await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: state.port, path: '/release', method: 'POST',
      headers: { 'x-lock-token': state.token, connection: 'close' }, timeout: 5000,
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

  const deadline = Date.now() + 5000;
  while (fs.existsSync(stateFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (fs.existsSync(stateFile)) {
    throw new Error('Integration lock holder did not confirm release before teardown timeout.');
  }
};
