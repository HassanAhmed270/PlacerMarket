const getTestDatabaseUrl = require('./database-url');
const testDatabaseUrl = getTestDatabaseUrl();

// db.service.js creates its Pool as soon as it is required by an integration test.
process.env.DATABASE_URL = testDatabaseUrl;

afterAll(async () => {
  // Require only after DATABASE_URL is set above; tests may already have loaded it.
  const servicePool = require('../../src/db.service').pool;
  await servicePool.end();
});
