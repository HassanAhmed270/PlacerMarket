const { createRateLimiter, createSoftChallengeSignal } = require('../../src/middleware/rateLimit');

function counterRedis() {
  const counters = new Map();
  return {
    isOpen: true,
    counters,
    async eval(_script, { keys }) {
      const counts = keys.map((key) => {
        const count = (counters.get(key) || 0) + 1;
        counters.set(key, count);
        return count;
      });
      return keys.length === 1 ? counts[0] : counts;
    },
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('SEC-08: Redis request limits are per IP and account', () => {
  test('SEC-08: concurrent requests over either limit receive one generic 429 response', async () => {
    const redis = counterRedis();
    const middleware = createRateLimiter({
      category: 'test-login', ipMax: 5, accountMax: 3, windowSeconds: 3600,
      clientProvider: () => redis,
    });
    const outcomes = await Promise.all(Array.from({ length: 8 }, async () => {
      const res = response();
      let nextCalled = false;
      await middleware({ ip: '203.0.113.4', body: { email: 'Buyer@Example.test' } }, res, (error) => {
        if (error) throw error;
        nextCalled = true;
      });
      return { status: res.statusCode, nextCalled, body: res.body };
    }));
    expect(outcomes.filter((item) => item.status === 200)).toHaveLength(3);
    expect(outcomes.filter((item) => item.status === 429)).toHaveLength(5);
    expect(outcomes.filter((item) => item.status === 429).every((item) => item.body.error === 'Too many requests. Please try again later.')).toBe(true);
  });

  test('SEC-08: Redis failures fail closed with service unavailable', async () => {
    const middleware = createRateLimiter({
      category: 'test-fail', ipMax: 5, accountMax: 3, windowSeconds: 3600,
      clientProvider: () => ({ isOpen: true, eval: async () => { throw new Error('private redis failure'); } }),
    });
    const res = response();
    let caught;
    await middleware({ ip: '203.0.113.4', body: {} }, res, (error) => { caught = error; });
    expect(caught.statusCode).toBe(503);
    expect(caught.message).not.toContain('private redis failure');
  });

  test('FR-84b: the soft challenge threshold signals challenge without blocking the request', async () => {
    const redis = counterRedis();
    const signal = createSoftChallengeSignal({
      threshold: 2, windowSeconds: 3600, clientProvider: () => redis,
    });
    const req = { ip: '203.0.113.4' };
    for (let index = 0; index < 3; index += 1) {
      let continued = false;
      await signal(req, response(), (error) => { if (error) throw error; continued = true; });
      expect(continued).toBe(true);
    }
    expect(req.challengeSignal).toBe(true);
  });
});
