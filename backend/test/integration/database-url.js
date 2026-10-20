const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const TEST_DATABASE_NAME = /(^|[_-])test($|[_-])/i;
const OWNER_APPROVED_TEST_DATABASE_NAME = 'testing_only';

function isSafeTestDatabaseName(name) {
  return name === OWNER_APPROVED_TEST_DATABASE_NAME || TEST_DATABASE_NAME.test(name);
}

function validateTestDatabaseUrl(value, { allowRemote = false } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('TEST_DATABASE_URL is required and cannot be empty.');
  }

  let parsed;
  let databaseName;
  try {
    parsed = new URL(value);
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid postgres:// or postgresql:// URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('TEST_DATABASE_URL protocol must be postgres:// or postgresql://.');
  }

  const forbiddenParameters = new Set(['host', 'hostaddr', 'dbname', 'database', 'port', 'user', 'password']);
  for (const name of parsed.searchParams.keys()) {
    if (forbiddenParameters.has(name.toLowerCase())) {
      throw new Error(`TEST_DATABASE_URL query parameter "${name}" is not allowed.`);
    }
  }

  if (!isSafeTestDatabaseName(databaseName)) {
    throw new Error(
      'TEST_DATABASE_URL database name must be testing_only or contain "test" as a complete underscore- or hyphen-delimited token.'
    );
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!LOCAL_HOSTS.has(host) && !allowRemote) {
    throw new Error(
      'TEST_DATABASE_URL must use localhost, 127.0.0.1, or ::1; set TEST_DATABASE_ALLOW_REMOTE=1 to explicitly allow a remote test database.'
    );
  }

  return { url: value, databaseName, host, port: parsed.port || '5432' };
}

function getTestDatabaseUrl() {
  return validateTestDatabaseUrl(process.env.TEST_DATABASE_URL, {
    allowRemote: process.env.TEST_DATABASE_ALLOW_REMOTE === '1',
  }).url;
}

module.exports = getTestDatabaseUrl;
module.exports.getTestDatabaseUrl = getTestDatabaseUrl;
module.exports.validateTestDatabaseUrl = validateTestDatabaseUrl;
module.exports.isSafeTestDatabaseName = isSafeTestDatabaseName;
