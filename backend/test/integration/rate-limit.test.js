const { randomUUID } = require('node:crypto');
const express = require('express');
const request = require('supertest');
const { createClient } = require('redis');
const { createRateLimiter } = require('../../src/middleware/rateLimit');
const { reserveAddressSend } = require('../../src/lib/emailCodeDelivery');

const redisUrl = process.env.TEST_REDIS_URL;
const suite = redisUrl ? describe : describe.skip;

suite('SEC-08: real Redis request-limit counters', () => {
  let client;
  let app;

  beforeAll(async () => {
    const url = new URL(redisUrl);
    if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname) {
      throw new Error('TEST_REDIS_URL must be a valid redis:// or rediss:// URL.');
    }
    if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname) && process.env.TEST_REDIS_ALLOW_REMOTE !== '1') {
      throw new Error('TEST_REDIS_URL must target localhost unless TEST_REDIS_ALLOW_REMOTE=1 is explicit.');
    }
    client = createClient({ url: redisUrl });
    await client.connect();
    app = express();
    app.use(express.json());
    app.post('/limited', createRateLimiter({
      category: `integration-${randomUUID()}`,
      ipMax: 5,
      accountMax: 3,
      windowSeconds: 60,
      clientProvider: () => client,
    }), (_req, res) => res.status(204).end());
  });

  afterAll(async () => {
    if (client?.isOpen) await client.quit();
  });

  test('SEC-08: concurrent requests share atomic per-IP and per-account limits', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () =>
      request(app).post('/limited').set('x-forwarded-for', '198.51.100.81').send({ email: 'Redis-Test@example.test' })));
    expect(responses.filter((response) => response.status === 204)).toHaveLength(3);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(5);
    expect(responses.every((response) => [204, 429].includes(response.status))).toBe(true);
  });

  test('SEC-08, FR-83d: concurrent email-code sends enforce the per-address cap atomically', async () => {
    const previousJwtSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'integration-test-secret-material-at-least-32-bytes';
    const email = `redis-${randomUUID()}@example.test`;
    const limits = {
      EMAIL_CODE_ADDRESS_HOURLY_MAX: 3,
      EMAIL_CODE_ADDRESS_DAILY_MAX: 10,
      EMAIL_CODE_RESEND_SECONDS: 60,
      EMAIL_CODE_HOURLY_WINDOW_SECONDS: 3600,
      EMAIL_CODE_DAILY_WINDOW_SECONDS: 86400,
    };
    try {
      const results = await Promise.all(Array.from({ length: 8 }, async () => {
        try { await reserveAddressSend(email, client, limits); return true; }
        catch { return false; }
      }));
      expect(results.filter(Boolean)).toHaveLength(3);
      expect(results.filter((result) => !result)).toHaveLength(5);
    } finally {
      if (previousJwtSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = previousJwtSecret;
    }
  });
});
