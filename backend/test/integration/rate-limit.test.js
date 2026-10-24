const { randomUUID } = require('node:crypto');
const express = require('express');
const request = require('supertest');
const { createClient } = require('redis');
const { createRateLimiter, createAccountRateLimiter } = require('../../src/middleware/rateLimit');
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

  test('conversation Redis limits allow exactly 10 per hour and 30 per day per account', async () => {
    async function exercise(name, windows, count, allowed) {
      const limitedApp = express();
      const userId = randomUUID();
      limitedApp.use((req, _res, next) => { req.user = { id: userId }; next(); });
      limitedApp.post('/limited', createAccountRateLimiter({
        category: `conversation-${name}-${randomUUID()}`,
        windows,
        clientProvider: () => client,
      }), (_req, res) => res.status(204).end());
      const responses = await Promise.all(Array.from({ length: count }, (_, index) =>
        request(limitedApp).post('/limited').set('x-forwarded-for', `198.51.100.${index + 1}`)));
      expect(responses.filter((response) => response.status === 204)).toHaveLength(allowed);
      expect(responses.filter((response) => response.status === 429)).toHaveLength(count - allowed);
    }

    await exercise('hour', [
      { name: 'hour', max: 10, windowSeconds: 3600 },
      { name: 'day', max: 30, windowSeconds: 86400 },
    ], 11, 10);
    await exercise('day', [
      { name: 'hour', max: 100, windowSeconds: 3600 },
      { name: 'day', max: 30, windowSeconds: 86400 },
    ], 31, 30);
  });

  test('message Redis limits allow exactly 10 per minute and 60 per hour per account', async () => {
    async function exercise(name, windows, count, allowed) {
      const limitedApp = express();
      const userId = randomUUID();
      limitedApp.use((req, _res, next) => { req.user = { id: userId }; next(); });
      limitedApp.post('/limited', createAccountRateLimiter({
        category: `message-${name}-${randomUUID()}`,
        windows,
        clientProvider: () => client,
      }), (_req, res) => res.status(204).end());
      const responses = await Promise.all(Array.from({ length: count }, (_, index) =>
        request(limitedApp).post('/limited').set('x-forwarded-for', `203.0.113.${index + 1}`)));
      expect(responses.filter((response) => response.status === 204)).toHaveLength(allowed);
      expect(responses.filter((response) => response.status === 429)).toHaveLength(count - allowed);
    }

    await exercise('minute', [
      { name: 'minute', max: 10, windowSeconds: 60 },
      { name: 'hour', max: 60, windowSeconds: 3600 },
    ], 11, 10);
    await exercise('hour', [
      { name: 'minute', max: 100, windowSeconds: 60 },
      { name: 'hour', max: 60, windowSeconds: 3600 },
    ], 61, 60);
  });

  test('FR-83f: concurrent authenticator and step-up requests share the security action limit', async () => {
    const securityApp = express();
    securityApp.use(express.json());
    securityApp.use((req, _res, next) => { req.user = { id: 'seller-security-test' }; next(); });
    securityApp.post('/security', createRateLimiter({
      category: `security-${randomUUID()}`,
      ipMax: 8,
      accountMax: 3,
      windowSeconds: 60,
      clientProvider: () => client,
    }), (_req, res) => res.status(204).end());
    const responses = await Promise.all(Array.from({ length: 7 }, () =>
      request(securityApp).post('/security').set('x-forwarded-for', '198.51.100.82').send({ action: 'step-up' })));
    expect(responses.filter((response) => response.status === 204)).toHaveLength(3);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(4);
  });

  test('SEC-08, FR-83d: concurrent email-code sends with a cooldown allow exactly one burst send', async () => {
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
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.filter((result) => !result)).toHaveLength(7);
    } finally {
      if (previousJwtSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = previousJwtSecret;
    }
  });

  test('SEC-08, FR-83d: sequential email-code sends enforce the per-address cap after cooldowns', async () => {
    const previousJwtSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'integration-test-secret-material-at-least-32-bytes';
    const email = `redis-${randomUUID()}@example.test`;
    const limits = {
      EMAIL_CODE_ADDRESS_HOURLY_MAX: 3,
      EMAIL_CODE_ADDRESS_DAILY_MAX: 10,
      EMAIL_CODE_RESEND_SECONDS: 1,
      EMAIL_CODE_HOURLY_WINDOW_SECONDS: 3600,
      EMAIL_CODE_DAILY_WINDOW_SECONDS: 86400,
    };
    try {
      const results = [];
      for (let index = 0; index < 4; index += 1) {
        try { await reserveAddressSend(email, client, limits); results.push('ok'); }
        catch { results.push('refused'); }
        if (index < 3) await new Promise((resolve) => setTimeout(resolve, 1100));
      }
      expect(results).toEqual(['ok', 'ok', 'ok', 'refused']);
    } finally {
      if (previousJwtSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = previousJwtSecret;
    }
  });
});
