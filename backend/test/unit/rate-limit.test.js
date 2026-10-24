const { createRateLimiter, createAccountRateLimiter, createSoftChallengeSignal } = require('../../src/middleware/rateLimit');
const { getSecurityLimits } = require('../../src/config');

function counterRedis() {
  const counters = new Map();
  return {
    isOpen: true,
    counters,
    async eval(script, { keys, arguments: args }) {
      const counts = keys.map((key) => {
        const count = (counters.get(key) || 0) + 1;
        counters.set(key, count);
        return count;
      });
      if (script.includes('local exceeded = 0')) {
        const exceeded = counts.some((count, index) => count > Number(args[index * 2]));
        return [exceeded ? 1 : 0, ...counts];
      }
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

describe('Redis request limits', () => {
  test('concurrent requests over either IP/account limit receive one generic 429 response', async () => {
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

  test('Redis failures fail closed with service unavailable', async () => {
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

  test('signals a soft challenge without blocking the request', async () => {
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

describe('account messaging rate limits', () => {
  test('defaults match the requested conversation and message caps', () => {
    expect(getSecurityLimits({})).toMatchObject({
      RATE_LIMIT_CONVERSATION_HOURLY_MAX: 10,
      RATE_LIMIT_CONVERSATION_DAILY_MAX: 30,
      RATE_LIMIT_MESSAGE_MINUTE_MAX: 10,
      RATE_LIMIT_MESSAGE_HOURLY_MAX: 60,
    });
  });

  test('enforces both account windows regardless of source IP', async () => {
    const redis = counterRedis();
    const middleware = createAccountRateLimiter({
      category: 'conversation-test',
      windows: [{ name: 'hour', max: 2, windowSeconds: 3600 }, { name: 'day', max: 3, windowSeconds: 86400 }],
      clientProvider: () => redis,
    });
    const results = [];
    for (let index = 0; index < 3; index += 1) {
      const res = response();
      let continued = false;
      await middleware({ ip: `192.0.2.${index}`, user: { id: 'account-1' } }, res, (error) => {
        if (error) throw error;
        continued = true;
      });
      results.push({ status: res.statusCode, continued });
    }
    expect(results).toEqual([
      { status: 200, continued: true },
      { status: 200, continued: true },
      { status: 429, continued: false },
    ]);
  });

  test('requires an authenticated account and fails closed on Redis errors', async () => {
    const unavailable = createAccountRateLimiter({
      category: 'account-failure',
      windows: [{ name: 'hour', max: 2, windowSeconds: 3600 }],
      clientProvider: () => ({ isOpen: true, eval: async () => { throw new Error('private redis failure'); } }),
    });
    let authError;
    await unavailable({}, response(), (error) => { authError = error; });
    expect(authError.statusCode).toBe(403);

    let redisError;
    await unavailable({ user: { id: 'account-1' } }, response(), (error) => { redisError = error; });
    expect(redisError.statusCode).toBe(503);
    expect(redisError.message).not.toContain('private redis failure');
  });
});
