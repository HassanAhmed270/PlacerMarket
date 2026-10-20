const { createRedisClient } = require('../../src/lib/redis');

describe('FR-77: Redis process connection lifecycle', () => {
  test('FR-77: startup validates configuration, connects, and checks Redis readiness', async () => {
    const client = {
      isOpen: false,
      on: jest.fn(),
      connect: jest.fn(async () => { client.isOpen = true; }),
      ping: jest.fn().mockResolvedValue('PONG'),
      quit: jest.fn(async () => { client.isOpen = false; }),
    };
    const redis = createRedisClient({ url: 'redis://localhost:6379', clientFactory: jest.fn(() => client) });

    await redis.start();
    await redis.stop();

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.ping).toHaveBeenCalledTimes(1);
    expect(client.quit).toHaveBeenCalledTimes(1);
  });

  test('FR-77: Redis connection requires a redis or rediss URL', () => {
    expect(() => createRedisClient({ url: '' })).toThrow('REDIS_URL is required');
    expect(() => createRedisClient({ url: 'http://localhost:6379' })).toThrow('redis:// or rediss://');
  });
});
