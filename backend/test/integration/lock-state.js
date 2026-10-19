const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { validateTestDatabaseUrl } = require('./database-url');

function lockStatePath(testDatabaseUrl) {
  const { host, port, databaseName } = validateTestDatabaseUrl(testDatabaseUrl, {
    allowRemote: process.env.TEST_DATABASE_ALLOW_REMOTE === '1',
  });
  const key = crypto.createHash('sha256').update(`${host}:${port}/${databaseName}`).digest('hex').slice(0, 24);
  return path.join(os.tmpdir(), `poshaak-integration-lock-${key}.json`);
}

module.exports = lockStatePath;
