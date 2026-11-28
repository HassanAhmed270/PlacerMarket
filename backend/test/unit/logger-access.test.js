const express = require('express');
const request = require('supertest');
const { EventEmitter } = require('node:events');
const { logger, safeFields, logLevel } = require('../../src/lib/logger');
const accessLog = require('../../src/middleware/accessLog');
const { createQueueClient } = require('../../src/lib/queue');
const { createRedisClient, setSharedRedisClient } = require('../../src/lib/redis');
const healthRoutes = require('../../src/routes/health.routes');
const { startServer } = require('../../src/server');
const errorHandler = require('../../src/middleware/errorHandler');
const { pool, searchPool } = require('../../src/db.service');

describe('FR-79g, SEC-27: logging redaction and access metadata', () => {
  test('FR-79g: LOG_LEVEL is validated and defaults outside production', () => {
    expect(logLevel({})).toBe('info');
    expect(logLevel({ NODE_ENV: 'test', LOG_LEVEL: 'debug' })).toBe('debug');
    expect(logLevel({ NODE_ENV: 'test', LOG_LEVEL: 'invalid' })).toBe('info');
    expect(() => logLevel({ NODE_ENV: 'production', LOG_LEVEL: 'invalid' })).toThrow(/LOG_LEVEL/);
  });

  test('FR-79g: caller level,time,msg fields cannot override reserved keys', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const output = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      logger.info('safe message', { level: 'evil', time: 'evil', msg: 'evil', status: 200 });
      const parsed = JSON.parse(output.mock.calls[0][0]);
      expect(parsed.level).toBe('info');
      expect(parsed.msg).toBe('safe message');
      expect(parsed.time).toMatch(/T.*Z$/);
    } finally {
      output.mockRestore();
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
  test('FR-79g: real app access logging mount emits route metadata', async () => {
    const keys = ['NODE_ENV', 'TRUST_PROXY_HOPS', 'JWT_ACCESS_SECRET', 'CORS_ORIGINS', 'PAYMENTS_ENABLED', 'PAYMENT_GATEWAY_PROVIDER'];
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.NODE_ENV = 'production';
    process.env.TRUST_PROXY_HOPS = '1';
    process.env.JWT_ACCESS_SECRET = 'j'.repeat(48);
    process.env.CORS_ORIGINS = 'https://poshaak.test';
    process.env.PAYMENTS_ENABLED = '0';
    process.env.PAYMENT_GATEWAY_PROVIDER = 'fake';
    const output = jest.spyOn(console, 'log').mockImplementation(() => {});
    let app;
    jest.isolateModules(() => {
      app = require('../../src/app');
    });
    try {
      await request(app).get('/api/__missing').set('X-Forwarded-Proto', 'https');
      expect(JSON.stringify(output.mock.calls)).toContain('request completed');
      expect(JSON.stringify(output.mock.calls)).not.toContain('__missing');
    } finally {
      output.mockRestore();
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      jest.resetModules();
    }
  }, 15000);
  test('SEC-27: deny-listed keys are redacted at any depth', () => {
    const safe = safeFields({
      outer: {
        password: 'secret',
        nested: { authorization: 'Bearer secret', email: 'buyer@example.test' },
      },
      token: 'step-up-grant',
      body: { phone: '+15551234567' },
    });
    expect(JSON.stringify(safe)).not.toContain('secret');
    expect(JSON.stringify(safe)).not.toContain('buyer@example.test');
    expect(JSON.stringify(safe)).not.toContain('+15551234567');
  });

  test('SEC-27: identity and token fields are redacted while safe codes remain visible', () => {
    const safe = safeFields({
      ip: '203.0.113.10',
      user_agent: 'private-agent',
      name: 'Private Name',
      full_name: 'Private Full Name',
      refresh_token: 'private-refresh-token',
      step_up_grant: 'private-step-up-grant',
      code: 'gateway_unavailable',
    });
    for (const field of ['ip', 'user_agent', 'name', 'full_name', 'refresh_token', 'step_up_grant']) {
      expect(safe[field]).toBe('[redacted]');
    }
    expect(safe.code).toBe('gateway_unavailable');
  });

  test('SEC-27: access log route pattern contains no URL, query, body, header or IP', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const output = jest.spyOn(console, 'log').mockImplementation(() => {});
    const app = express();
    app.use(accessLog);
    app.get('/api/orders/:id', (req, res) => res.status(200).json({ ok: true }));
    await request(app)
      .get('/api/orders/real-id-123?token=secret&email=buyer@example.test')
      .send({ password: 'secret', phone: '+15551234567' });
    const logged = JSON.stringify(output.mock.calls);
    expect(logged).toContain('/api/orders/:id');
    expect(logged).not.toContain('real-id-123');
    expect(logged).not.toContain('secret');
    expect(logged).not.toContain('buyer@example.test');
    expect(logged).not.toContain('+15551234567');
    const entry = JSON.parse(output.mock.calls[0][0]);
    expect(entry.time).toMatch(/T.*Z$/);
    output.mockRestore();
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });

  test('FR-79g: production logger emits valid JSON lines with UTC time', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const output = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      logger.info('safe event', { status: 200 });
      const line = output.mock.calls[0][0];
      const parsed = JSON.parse(line);
      expect(parsed.level).toBe('info');
      expect(parsed.time).toMatch(/T.*Z$/);
    } finally {
      output.mockRestore();
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  test('FR-79g: queue and Redis default loggers emit JSON with UTC time', () => {
    const previous = {
      nodeEnv: process.env.NODE_ENV,
      logLevel: process.env.LOG_LEVEL,
    };
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'info';
    const stdout = jest.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      class FakeBoss extends EventEmitter {}
      const queueClient = createQueueClient({
        connectionString: 'postgres://localhost/test',
        PgBossClass: FakeBoss,
      });
      queueClient.boss.emit('warning', { type: 'test-warning' });
      queueClient.boss.emit('error', { code: 'TEST_QUEUE_ERROR' });

      const redisEvents = new EventEmitter();
      const redis = createRedisClient({
        url: 'redis://localhost:6379',
        clientFactory: () => redisEvents,
      });
      redisEvents.emit('error', { code: 'TEST_REDIS_ERROR' });

      const entries = [
        ...stdout.mock.calls.map(([line]) => JSON.parse(line)),
        ...stderr.mock.calls.map(([line]) => JSON.parse(line)),
      ];
      const beforeDatabaseErrors = stderr.mock.calls.length;
      pool.emit('error', { code: '08006' });
      searchPool.emit('error', { code: '08006' });
      const databaseEntries = stderr.mock.calls.slice(beforeDatabaseErrors).map(([line]) => JSON.parse(line));
      expect(entries.map(({ msg }) => msg)).toEqual(expect.arrayContaining([
        'Queue warning',
        'Queue database error',
        'Redis connection error',
      ]));
      expect(entries.every(({ time }) => /T.*Z$/.test(time))).toBe(true);
      expect(databaseEntries).toHaveLength(2);
      expect(databaseEntries.every(({ time }) => /T.*Z$/.test(time))).toBe(true);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous.nodeEnv;
      if (previous.logLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previous.logLevel;
    }
  });

  test('FR-79g: web startup and shutdown use the production JSON logger', async () => {
    const keys = ['NODE_ENV', 'LOG_LEVEL', 'PORT', 'SHUTDOWN_TIMEOUT_MS'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'info';
    process.env.PORT = '0';
    process.env.SHUTDOWN_TIMEOUT_MS = '1000';
    const stdout = jest.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = jest.spyOn(console, 'error').mockImplementation(() => {});
    let running;
    try {
      running = await startServer({
        loadApp: () => express(),
        dbPool: { end: jest.fn().mockResolvedValue(undefined) },
        queueClient: {
          startProducer: jest.fn().mockResolvedValue(undefined),
          stopProducer: jest.fn().mockResolvedValue(undefined),
        },
        redisFactory: () => ({
          start: jest.fn().mockResolvedValue(undefined),
          stop: jest.fn().mockResolvedValue(undefined),
        }),
        validateJwt: jest.fn(),
        validateConfiguration: jest.fn(),
        validatePaymentsGate: jest.fn().mockResolvedValue(undefined),
        hashPool: { close: jest.fn().mockResolvedValue(undefined) },
        searchPool: { end: jest.fn().mockResolvedValue(undefined) },
      });
      await running.shutdown('test');
      const entries = stdout.mock.calls.map(([line]) => JSON.parse(line));
      expect(entries.map(({ msg }) => msg)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^Poshaak backend listening on port /),
        'Poshaak backend shutting down (test)',
      ]));
      expect(entries.every(({ time }) => /T.*Z$/.test(time))).toBe(true);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      if (running) await running.shutdown('test');
      healthRoutes.setShuttingDown(false);
      setSharedRedisClient(null);
      stdout.mockRestore();
      stderr.mockRestore();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 15000);

  test('FR-79g: production error-handler logs valid JSON with UTC time', async () => {
    const previous = {
      nodeEnv: process.env.NODE_ENV,
      logLevel: process.env.LOG_LEVEL,
    };
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'info';
    const stderr = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = express();
      app.get('/fail', (_req, _res, next) => next(new Error('private error')));
      app.use(errorHandler);
      const response = await request(app).get('/fail');
      expect(response.status).toBe(500);
      const entry = JSON.parse(stderr.mock.calls[0][0]);
      expect(entry).toMatchObject({
        level: 'error',
        msg: 'Request failed',
        time: expect.stringMatching(/T.*Z$/),
      });
      expect(JSON.stringify(entry)).not.toContain('private error');
    } finally {
      stderr.mockRestore();
      if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous.nodeEnv;
      if (previous.logLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previous.logLevel;
    }
  });
});
