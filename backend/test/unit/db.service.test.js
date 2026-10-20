const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: (...a) => mockQuery(...a),
    connect: async () => ({ query: (...a) => mockClientQuery(...a), release: (...a) => mockRelease(...a) }),
    on: jest.fn(),
  })),
}));
const db = require('../../src/db.service');
const { Pool } = require('pg');
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
