jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(),
}));
jest.mock('pg', () => ({ Pool: jest.fn(), Client: jest.fn() }));

const childProcess = require('child_process');
const pg = require('pg');
const { PassThrough } = require('stream');
const http = require('http');
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

  test.each([
    'postgres://localhost/app_test?host=prod.example.com',
    'postgres://localhost/app_test?port=5432',
    'postgres://localhost/app_test?dbname=app_test',
    'postgres://localhost/app_test?HOST=prod.example.com',
    'postgres://localhost/app_test?DaTaBaSe=app_test',
  ])('rejects driver connection override in %s', (url) => {
    expect(() => validateTestDatabaseUrl(url)).toThrow(/query parameter.*not allowed/i);
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

  test.each([
    ['postgres://test@localhost/contest', /database name/],
    ['postgres://localhost/app_test?host=prod.example.com', /query parameter/],
    ['postgres://localhost/app_test?PORT=5432', /query parameter/],
    ['postgres://localhost/app_test?dbname=app_test', /query parameter/],
  ])('global setup rejects unsafe URL %s before spawning a lock holder or creating a pool', async (url, error) => {
    const previous = process.env.TEST_DATABASE_URL;
    const previousRemote = process.env.TEST_DATABASE_ALLOW_REMOTE;
    process.env.TEST_DATABASE_URL = url;
    delete process.env.TEST_DATABASE_ALLOW_REMOTE;
    childProcess.spawn.mockClear();
    pg.Pool.mockClear();
    pg.Client.mockClear();
    try {
      await expect(globalSetup()).rejects.toThrow(error);
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

  test('global setup checks the connected database before issuing destructive SQL', async () => {
    const previous = process.env.TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL = 'postgres://localhost/app_test';
    const stdout = new PassThrough();
    const child = Object.assign(new (require('events').EventEmitter)(), {
      stdout, channel: { unref: jest.fn() }, pid: 123, unref: jest.fn(), kill: jest.fn(),
    });
    childProcess.spawn.mockReturnValueOnce(child);
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ database_name: 'production' }] }), end: jest.fn() };
    pg.Pool.mockImplementationOnce(() => pool);
    const request = { on: jest.fn().mockReturnThis(), end: jest.fn(() => {
      const response = new (require('events').EventEmitter)();
      response.statusCode = 200;
      response.resume = jest.fn();
      process.nextTick(() => { httpRequestCallback(response); response.emit('end'); });
    }) };
    let httpRequestCallback;
    const originalRequest = http.request;
    http.request = jest.fn((_options, callback) => { httpRequestCallback = callback; return request; });
    try {
      setImmediate(() => stdout.write('{"type":"ready","port":32123,"token":"fixture"}\n'));
      await expect(globalSetup()).rejects.toThrow(/Connected database name failed/);
      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(pool.query.mock.calls[0][0]).toBe('SELECT current_database() AS database_name');
      expect(pool.query.mock.calls[0][0]).not.toMatch(/DROP|CREATE SCHEMA/i);
      expect(pool.end).toHaveBeenCalled();
    } finally {
      http.request = originalRequest;
      if (previous === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = previous;
    }
  });
});
