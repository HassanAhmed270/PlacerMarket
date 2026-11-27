const request = require('supertest');
const { pool } = require('../../src/db.service');
const { setSharedRedisClient } = require('../../src/lib/redis');
const { shutdownTimeout, withDeadline } = require('../../src/lib/shutdown');

function loadRealApp() {
  const keys = ['NODE_ENV', 'TRUST_PROXY_HOPS', 'JWT_ACCESS_SECRET', 'CORS_ORIGINS', 'PAYMENTS_ENABLED', 'PAYMENT_GATEWAY_PROVIDER'];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = 'production';
  process.env.TRUST_PROXY_HOPS = '1';
  process.env.JWT_ACCESS_SECRET = 'j'.repeat(48);
  process.env.CORS_ORIGINS = 'https://poshaak.test';
  process.env.PAYMENTS_ENABLED = '0';
  process.env.PAYMENT_GATEWAY_PROVIDER = 'fake';
  let app;
  jest.isolateModules(() => {
    app = require('../../src/app');
  });
  return {
    app,
    restore() {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      jest.resetModules();
    },
  };
}

describe('FR-79h: health and graceful shutdown', () => {
  test('FR-79h: /healthz returns 200 without touching the database', async () => {
    const spy = jest.spyOn(pool, 'query');
    const loaded = loadRealApp();
    try {
      const res = await request(loaded.app).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      loaded.restore();
    }
  }, 15000);

  test('FR-79h: plain-HTTP /healthz is exempt while /api returns 400', async () => {
    const loaded = loadRealApp();
    try {
      const health = await request(loaded.app).get('/healthz');
      const api = await request(loaded.app).get('/api/__missing');
      expect(health.status).toBe(200);
      expect(api.status).toBe(400);
      expect(api.body).toEqual({ error: 'HTTPS required' });
    } finally {
      loaded.restore();
    }
  }, 15000);

  test('FR-79h: /readyz returns 503 with no detail when database is down', async () => {
    setSharedRedisClient({ ping: jest.fn().mockResolvedValue('PONG') });
    const spy = jest.spyOn(pool, 'query').mockRejectedValue(new Error('secret database details'));
    const loaded = loadRealApp();
    try {
      const res = await request(loaded.app).get('/readyz').set('X-Forwarded-Proto', 'https');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'unavailable' });
    } finally {
      spy.mockRestore();
      setSharedRedisClient(null);
      loaded.restore();
    }
  }, 15000);

  test('FR-79h: /readyz returns 503 with no detail when Redis is down', async () => {
    setSharedRedisClient({ ping: jest.fn().mockRejectedValue(new Error('secret redis details')) });
    const spy = jest.spyOn(pool, 'query').mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const loaded = loadRealApp();
    try {
      const res = await request(loaded.app).get('/readyz').set('X-Forwarded-Proto', 'https');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'unavailable' });
    } finally {
      spy.mockRestore();
      setSharedRedisClient(null);
      loaded.restore();
    }
  }, 15000);

  test('FR-79h: health routes send no-store', async () => {
    setSharedRedisClient({ ping: jest.fn().mockResolvedValue('PONG') });
    const spy = jest.spyOn(pool, 'query').mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const loaded = loadRealApp();
    try {
      const health = await request(loaded.app).get('/healthz');
      const ready = await request(loaded.app).get('/readyz').set('X-Forwarded-Proto', 'https');
      expect(health.headers['cache-control']).toBe('no-store');
      expect(ready.headers['cache-control']).toBe('no-store');
    } finally {
      spy.mockRestore();
      setSharedRedisClient(null);
      loaded.restore();
    }
  }, 15000);

  test('FR-79h: SHUTDOWN_TIMEOUT_MS rejects non-positive values', () => {
    expect(() => shutdownTimeout({ SHUTDOWN_TIMEOUT_MS: '0' })).toThrow(/SHUTDOWN_TIMEOUT_MS/);
  });

  test('FR-79h: shutdown deadline exits non-zero past the deadline', async () => {
    const processRef = { exitCode: undefined };
    const logger = { error: jest.fn() };
    await withDeadline(() => new Promise(() => {}), 5, logger, processRef);
    expect(processRef.exitCode).toBe(1);
  });
});
