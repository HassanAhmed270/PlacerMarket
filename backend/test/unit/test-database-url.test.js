jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(),
}));
jest.mock('pg', () => ({ Pool: jest.fn(), Client: jest.fn() }));

const childProcess = require('child_process');
const pg = require('pg');
const globalSetup = require('../integration/global-setup');
const databaseUrl = require('../integration/database-url');
const { validateTestDatabaseUrl } = databaseUrl;

describe('test database URL validation', () => {
  test.each([
    [undefined, /required and cannot be empty/],
    ['', /required and cannot be empty/],
    ['not a URL', /valid postgres/],
    ['https://localhost/app_test', /protocol must be postgres/],
    ['postgres://localhost/%ZZ', /valid postgres/],
  ])('rejects unset, empty, malformed, or unsupported URL %p', (url, error) => {
    expect(() => validateTestDatabaseUrl(url)).toThrow(error);
  });

  test.each(['app', 'poshaak_prod', 'latest', 'contest'])('rejects unsafe database name %s', (name) => {
    expect(() => validateTestDatabaseUrl(`postgres://localhost/${name}`)).toThrow(/database name/);
  });

  test.each(['poshaak_test', 'app_test', 'test_app'])('accepts local test database name %s', (name) => {
    expect(validateTestDatabaseUrl(`postgres://localhost/${name}`).databaseName).toBe(name);
  });

  test('does not treat username "test" as a test database name', () => {
    expect(() => validateTestDatabaseUrl('postgres://test@localhost/app')).toThrow(/database name/);
  });

  test('rejects a remote host unless the explicit override is enabled', () => {
    const url = 'postgres://user@db.example.invalid/app_test';
    expect(() => validateTestDatabaseUrl(url)).toThrow(/TEST_DATABASE_ALLOW_REMOTE=1/);
    expect(validateTestDatabaseUrl(url, { allowRemote: true }).host).toBe('db.example.invalid');
  });

  test('getter permits a remote test database only when TEST_DATABASE_ALLOW_REMOTE is exactly 1', () => {
    const previousUrl = process.env.TEST_DATABASE_URL;
    const previousRemote = process.env.TEST_DATABASE_ALLOW_REMOTE;
    process.env.TEST_DATABASE_URL = 'postgres://user@db.example.invalid/app_test';
    try {
      process.env.TEST_DATABASE_ALLOW_REMOTE = 'true';
      expect(() => databaseUrl.getTestDatabaseUrl()).toThrow(/TEST_DATABASE_ALLOW_REMOTE=1/);
      process.env.TEST_DATABASE_ALLOW_REMOTE = '1';
      expect(databaseUrl.getTestDatabaseUrl()).toBe(process.env.TEST_DATABASE_URL);
    } finally {
      if (previousUrl === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = previousUrl;
      if (previousRemote === undefined) delete process.env.TEST_DATABASE_ALLOW_REMOTE;
      else process.env.TEST_DATABASE_ALLOW_REMOTE = previousRemote;
    }
  });

  test('decodes percent-encoded database names before checking the name', () => {
    expect(validateTestDatabaseUrl('postgres://localhost/poshaak%5Ftest').databaseName).toBe('poshaak_test');
  });

  test.each([
    ['postgres://localhost/app_test', 'localhost'],
    ['postgres://127.0.0.1/app_test', '127.0.0.1'],
    ['postgres://[::1]/app_test', '::1'],
  ])('parses local loopback host in %s', (url, expectedHost) => {
    expect(validateTestDatabaseUrl(url).host).toBe(expectedHost);
  });

  test('global setup rejects an unsafe URL before spawning a lock holder or creating a pool', async () => {
    const previous = process.env.TEST_DATABASE_URL;
    const previousRemote = process.env.TEST_DATABASE_ALLOW_REMOTE;
    process.env.TEST_DATABASE_URL = 'postgres://test@localhost/contest';
    delete process.env.TEST_DATABASE_ALLOW_REMOTE;
    childProcess.spawn.mockClear();
    pg.Pool.mockClear();
    pg.Client.mockClear();
    try {
      await expect(globalSetup()).rejects.toThrow(/database name/);
      expect(childProcess.spawn).not.toHaveBeenCalled();
      expect(pg.Pool).not.toHaveBeenCalled();
      expect(pg.Client).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = previous;
      if (previousRemote === undefined) delete process.env.TEST_DATABASE_ALLOW_REMOTE;
      else process.env.TEST_DATABASE_ALLOW_REMOTE = previousRemote;
    }
  });
});
