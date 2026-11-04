const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn(async () => ({
  query: (...a) => mockClientQuery(...a),
  release: (...a) => mockRelease(...a),
}));
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: (...a) => mockQuery(...a),
    connect: (...a) => mockConnect(...a),
    on: jest.fn(),
  })),
}));
const db = require('../../src/db.service');
const { Pool } = require('pg');
const { ValidationError } = require('../../src/lib/errors');
const constructedPoolConfig = Pool.mock.calls[0]?.[0];

beforeEach(() => jest.clearAllMocks());

describe('db.service helpers', () => {
  test('FR-79c: pool has bounded size and short connection, statement, idle, and lock timeouts', () => {
    expect(constructedPoolConfig).toEqual(expect.objectContaining({
      max: 10, connectionTimeoutMillis: 1000, idleTimeoutMillis: 30000,
      statement_timeout: 5000, idle_in_transaction_session_timeout: 10000, lock_timeout: 1000,
    }));
  });

  test('FR-79e: read and write entry points use the current shared pool', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    await expect(db.read('SELECT 1')).resolves.toEqual({ rows: [{ id: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await expect(db.write('UPDATE t SET x = 1')).resolves.toEqual({ rows: [], rowCount: 1 });
  });

  test('FR-79c: pool acquisition timeout becomes a 503 service error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'));
    await expect(db.read('SELECT 1')).rejects.toMatchObject({
      name: 'ServiceUnavailableError', statusCode: 503,
      message: 'Database connection is temporarily unavailable',
    });
  });

  test('query passes the full result through', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    await expect(db.query('SELECT 1', [])).resolves.toEqual({ rows: [{ id: 1 }], rowCount: 1 });
  });

  test('many returns every row as an array', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });
    await expect(db.many('SELECT id FROM t')).resolves.toEqual([{ id: 1 }, { id: 2 }]);
  });

  test('one returns the first row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });
    await expect(db.one('SELECT id FROM t WHERE id = $1', [1])).resolves.toEqual({ id: 1 });
  });

  test('one returns null (not an error) when nothing matches', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(db.one('SELECT id FROM t WHERE id = $1', [9])).resolves.toBeNull();
  });
});

describe('db.withTransaction', () => {
  test('commits and returns the callback result, releasing the client once', async () => {
    const result = await db.withTransaction(async (client) => { await client.query('UPDATE t SET x = 1'); return 'done'; });
    expect(result).toBe('done');
    expect(mockClientQuery.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'UPDATE t SET x = 1', 'COMMIT']);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test('rolls back, rethrows the original error and still releases the client', async () => {
    await expect(db.withTransaction(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(mockClientQuery.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'ROLLBACK']);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

describe('db.withTransactionRetry', () => {
  function makeClient(callbackError) {
    const query = jest.fn(async (sql) => {
      if (sql === 'WORK' && callbackError) throw callbackError;
      return { rows: [] };
    });
    return { query, release: jest.fn() };
  }

  test.each(['55P03', '40P01', '40001'])('retries twice on PostgreSQL error %s in new transactions', async (code) => {
    const delays = [];
    const timeout = jest.spyOn(global, 'setTimeout').mockImplementation((callback, delay) => {
      delays.push(delay);
      callback();
      return 0;
    });
    const error = Object.assign(new Error('transaction failed'), { code });
    const clients = [makeClient(error), makeClient(error), makeClient(null)];
    clients.forEach((client) => mockConnect.mockResolvedValueOnce(client));
    const callbackClients = [];

    try {
      const result = await db.withTransactionRetry(async (client) => {
        callbackClients.push(client);
        await client.query('WORK');
        return 'committed';
      }, { retries: 2 });
      expect(result).toBe('committed');
      expect(callbackClients).toEqual(clients);
      expect(mockConnect).toHaveBeenCalledTimes(3);
      expect(clients.map((client) => client.release.mock.calls.length)).toEqual([1, 1, 1]);
      expect(delays).toHaveLength(2);
      expect(delays.every((delay) => delay >= 50 && delay <= 150)).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  test.each([
    ['unique violation', Object.assign(new Error('unique violation'), { code: '23505' })],
    ['validation error', new ValidationError('invalid input')],
  ])('does not retry a %s', async (_label, error) => {
    const client = makeClient(error);
    mockConnect.mockResolvedValueOnce(client);
    await expect(db.withTransactionRetry((transaction) => transaction.query('WORK')))
      .rejects.toBe(error);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  test('gives up after two retries and preserves the original error', async () => {
    const error = Object.assign(new Error('deadlock'), { code: '40P01' });
    [makeClient(error), makeClient(error), makeClient(error)]
      .forEach((client) => mockConnect.mockResolvedValueOnce(client));
    await expect(db.withTransactionRetry((client) => client.query('WORK'), { retries: 2 }))
      .rejects.toBe(error);
    expect(mockConnect).toHaveBeenCalledTimes(3);
  });
});
