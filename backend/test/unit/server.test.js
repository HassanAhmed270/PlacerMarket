const { startServer } = require('../../src/server');

const validSecret = 'a'.repeat(32);

describe('server startup diagnostics', () => {
  let originalJwt;
  let originalRedis;

  beforeEach(() => {
    originalJwt = process.env.JWT_ACCESS_SECRET;
    originalRedis = process.env.REDIS_URL;
    process.env.JWT_ACCESS_SECRET = validSecret;
    process.env.REDIS_URL = 'redis://localhost:6379';
  });

  afterEach(() => {
    if (originalJwt === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = originalJwt;
    if (originalRedis === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedis;
  });

  function dependencies(overrides = {}) {
    const logger = { error: jest.fn(), log: jest.fn() };
    const dbPool = { end: jest.fn().mockResolvedValue(undefined) };
    const redis = { start: jest.fn().mockResolvedValue(undefined), stop: jest.fn().mockResolvedValue(undefined) };
    return {
      logger,
      dbPool,
      redis,
      options: {
        logger,
        dbPool,
        queueClient: { startProducer: jest.fn(), stopProducer: jest.fn() },
        redisFactory: jest.fn(() => redis),
        loadApp: jest.fn(() => ({})),
        ...overrides,
      },
    };
  }

  test('logs the JWT_ACCESS_SECRET validation message without starting Redis', async () => {
    delete process.env.JWT_ACCESS_SECRET;
    const deps = dependencies();

    await expect(startServer(deps.options)).rejects.toThrow('JWT_ACCESS_SECRET must contain at least 32 bytes');

    expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining('JWT_ACCESS_SECRET must contain'));
    expect(deps.redis.start).not.toHaveBeenCalled();
  });

  test('logs the REDIS_URL validation message without exposing other startup details', async () => {
    delete process.env.REDIS_URL;
    const logger = { error: jest.fn(), log: jest.fn() };
    const dbPool = { end: jest.fn().mockResolvedValue(undefined) };

    await expect(startServer({
      logger,
      dbPool,
      queueClient: { startProducer: jest.fn(), stopProducer: jest.fn() },
      loadApp: () => ({}),
    })).rejects.toThrow('REDIS_URL is required');

    expect(logger.error).toHaveBeenCalledWith('REDIS_URL is required to start the Redis client.');
  });

  test('logs the CORS_ORIGINS validation message', async () => {
    const deps = dependencies({ loadApp: () => { throw new Error('CORS_ORIGINS must contain exact HTTP(S) origins without paths or wildcards.'); } });

    await expect(startServer(deps.options)).rejects.toThrow('CORS_ORIGINS must contain exact HTTP(S) origins');

    expect(deps.logger.error).toHaveBeenCalledWith('CORS_ORIGINS must contain exact HTTP(S) origins without paths or wildcards.');
  });

  test('logs only the Redis error code when the Redis connection is unavailable', async () => {
    const logger = { error: jest.fn(), log: jest.fn() };
    const driverError = Object.assign(new Error('connect redis://user:secret@private-host'), { code: 'ECONNREFUSED' });
    const redis = { start: jest.fn().mockRejectedValue(driverError), stop: jest.fn().mockResolvedValue(undefined) };

    await expect(startServer({
      logger,
      dbPool: { end: jest.fn().mockResolvedValue(undefined) },
      queueClient: { startProducer: jest.fn(), stopProducer: jest.fn() },
      redisFactory: () => redis,
      loadApp: () => ({}),
    })).rejects.toBe(driverError);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('Redis unavailable (ECONNREFUSED)');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
  });
});
