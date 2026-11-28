const request = require('supertest');
const http = require('node:http');
const { shutdownTimeout, withDeadline, closeWebWithDeadline, closeWorkerWithDeadline } = require('../../src/lib/shutdown');

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
  let pool;
  let setSharedRedisClient;
  let healthRoutes;
  jest.isolateModules(() => {
    ({ pool } = require('../../src/db.service'));
    ({ setSharedRedisClient } = require('../../src/lib/redis'));
    healthRoutes = require('../../src/routes/health.routes');
    app = require('../../src/app');
  });
  return {
    app,
    pool,
    setSharedRedisClient,
    healthRoutes,
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
    const loaded = loadRealApp();
    const spy = jest.spyOn(loaded.pool, 'query');
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
    const loaded = loadRealApp();
    loaded.setSharedRedisClient({ ping: jest.fn().mockResolvedValue('PONG') });
    const spy = jest.spyOn(loaded.pool, 'query').mockRejectedValue(new Error('secret database details'));
    try {
      const res = await request(loaded.app).get('/readyz').set('X-Forwarded-Proto', 'https');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'unavailable' });
    } finally {
      spy.mockRestore();
      loaded.setSharedRedisClient(null);
      loaded.restore();
    }
  }, 15000);

  test('FR-79h: /readyz returns 503 with no detail when Redis is down', async () => {
    const loaded = loadRealApp();
    loaded.setSharedRedisClient({ ping: jest.fn().mockRejectedValue(new Error('secret redis details')) });
    const spy = jest.spyOn(loaded.pool, 'query').mockResolvedValue({ rows: [{ '?column?': 1 }] });
    try {
      const res = await request(loaded.app).get('/readyz').set('X-Forwarded-Proto', 'https');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'unavailable' });
    } finally {
      spy.mockRestore();
      loaded.setSharedRedisClient(null);
      loaded.restore();
    }
  }, 15000);

  test('FR-79h: health routes send no-store', async () => {
    const loaded = loadRealApp();
    loaded.setSharedRedisClient({ ping: jest.fn().mockResolvedValue('PONG') });
    const spy = jest.spyOn(loaded.pool, 'query').mockResolvedValue({ rows: [{ '?column?': 1 }] });
    try {
      const health = await request(loaded.app).get('/healthz');
      const ready = await request(loaded.app).get('/readyz').set('X-Forwarded-Proto', 'https');
      expect(health.headers['cache-control']).toBe('no-store');
      expect(ready.headers['cache-control']).toBe('no-store');
    } finally {
      spy.mockRestore();
      loaded.setSharedRedisClient(null);
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

  test('FR-79h: web shutdown flips real-app readiness to 503 before closing', async () => {
    const loaded = loadRealApp();
    loaded.setSharedRedisClient({ ping: jest.fn().mockResolvedValue('PONG') });
    const poolQuery = jest.spyOn(loaded.pool, 'query').mockResolvedValue({ rows: [{ '?column?': 1 }] });
    let readiness;
    const server = {
      close(callback) {
        request(loaded.app).get('/readyz').then((response) => {
          readiness = response;
          callback();
        }, callback);
      },
      closeIdleConnections: jest.fn(),
      closeAllConnections: jest.fn(),
    };
    try {
      await closeWebWithDeadline({
        server,
        queueClient: { stopProducer: jest.fn().mockResolvedValue(undefined) },
        redis: { stop: jest.fn().mockResolvedValue(undefined) },
        hashPool: { close: jest.fn().mockResolvedValue(undefined) },
        dbPool: { end: jest.fn().mockResolvedValue(undefined) },
        searchPool: { end: jest.fn().mockResolvedValue(undefined) },
        timeoutMs: 100,
        logger: { error: jest.fn() },
        setReadinessUnavailable: () => loaded.healthRoutes.setShuttingDown(true),
      });
      expect(readiness.status).toBe(503);
      expect(readiness.body).toEqual({ status: 'unavailable' });
      expect(poolQuery).not.toHaveBeenCalled();
    } finally {
      poolQuery.mockRestore();
      loaded.setSharedRedisClient(null);
      loaded.healthRoutes.setShuttingDown(false);
      loaded.restore();
    }
  });

  test('FR-79h: web shutdown lets an in-flight request finish and then closes pools', async () => {
    let finishRequest;
    let requestStarted;
    const requestFinished = new Promise((resolve) => { finishRequest = resolve; });
    const started = new Promise((resolve) => { requestStarted = resolve; });
    const server = http.createServer((_req, res) => {
      requestStarted();
      requestFinished.then(() => {
        res.setHeader('Connection', 'close');
        res.end('done');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const response = new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/', headers: { Connection: 'close' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
    await started;
    const dbPool = { end: jest.fn().mockResolvedValue(undefined) };
    const queueClient = { stopProducer: jest.fn().mockResolvedValue(undefined) };
    const redis = { stop: jest.fn().mockResolvedValue(undefined) };
    const hashPool = { close: jest.fn().mockResolvedValue(undefined) };
    const searchPool = { end: jest.fn().mockResolvedValue(undefined) };
    const shutdown = closeWebWithDeadline({
      server,
      queueClient,
      redis,
      hashPool,
      dbPool,
      searchPool,
      timeoutMs: 100,
      logger: { error: jest.fn() },
    });
    finishRequest();
    await shutdown;
    expect(await response).toEqual({ status: 200, body: 'done' });
    expect(queueClient.stopProducer).toHaveBeenCalledTimes(1);
    expect(redis.stop).toHaveBeenCalledTimes(1);
    expect(hashPool.close).toHaveBeenCalledTimes(1);
    expect(dbPool.end).toHaveBeenCalledTimes(1);
    expect(searchPool.end).toHaveBeenCalledTimes(1);
  });

  test('FR-79h: web shutdown past deadline force-closes and exits 1', async () => {
    const server = { close: () => {}, closeIdleConnections: jest.fn(), closeAllConnections: jest.fn() };
    const processRef = { exit: jest.fn() };
    await closeWebWithDeadline({
      server,
      queueClient: { stopProducer: jest.fn().mockResolvedValue(undefined) },
      redis: { stop: jest.fn().mockResolvedValue(undefined) },
      hashPool: { close: jest.fn().mockResolvedValue(undefined) },
      dbPool: { end: jest.fn().mockResolvedValue(undefined) },
      searchPool: { end: jest.fn().mockResolvedValue(undefined) },
      timeoutMs: 5,
      logger: { error: jest.fn() },
      processRef,
    });
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(processRef.exit).toHaveBeenCalledWith(1);
  });

  test('FR-79h: worker shutdown closes queue, redis and database pools', async () => {
    const queue = { stop: jest.fn().mockResolvedValue(undefined) };
    const redis = { stop: jest.fn().mockResolvedValue(undefined) };
    const db = { pool: { end: jest.fn().mockResolvedValue(undefined) }, searchPool: { end: jest.fn().mockResolvedValue(undefined) } };
    await closeWorkerWithDeadline({
      queue,
      stopProducer: jest.fn().mockResolvedValue(undefined),
      redis,
      db,
      timeoutMs: 100,
      logger: { error: jest.fn() },
    });
    expect(queue.stop).toHaveBeenCalledTimes(1);
    expect(redis.stop).toHaveBeenCalledTimes(1);
    expect(db.pool.end).toHaveBeenCalledTimes(1);
    expect(db.searchPool.end).toHaveBeenCalledTimes(1);
  });

  test('FR-79h: worker shutdown past deadline exits 1', async () => {
    const processRef = { exit: jest.fn() };
    await closeWorkerWithDeadline({
      queue: { stop: () => new Promise(() => {}) },
      stopProducer: jest.fn().mockResolvedValue(undefined),
      redis: { stop: jest.fn().mockResolvedValue(undefined) },
      db: { pool: { end: jest.fn() }, searchPool: { end: jest.fn() } },
      timeoutMs: 5,
      logger: { error: jest.fn() },
      processRef,
    });
    expect(processRef.exit).toHaveBeenCalledWith(1);
  });
});
