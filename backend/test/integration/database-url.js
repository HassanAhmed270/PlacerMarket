function getTestDatabaseUrl() {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) {
    throw new Error(
      'TEST_DATABASE_URL is required for integration tests. Set it to a disposable PostgreSQL database whose name contains "test".'
    );
  }

  let databaseName;
  try {
    const parsed = new URL(testDatabaseUrl);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('protocol');
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL connection URL.');
  }
  if (!databaseName.toLowerCase().includes('test')) {
    throw new Error(
      `Refusing integration tests: database name "${databaseName}" must contain "test".`
    );
  }

  return testDatabaseUrl;
}

module.exports = getTestDatabaseUrl;
