const express = require('express');
const request = require('supertest');
const metricsMiddleware = require('../../src/middleware/metricsMiddleware');
const { snapshotMetrics, recordRequestStatus, recordQueueFailure } = require('../../src/lib/metrics');

describe('FR-79h: process metrics', () => {
  test('FR-79h: metrics counts requests and status classes', async () => {
    recordRequestStatus(200);
    recordRequestStatus(404);
    recordRequestStatus(503);
    const app = express();
    app.use(metricsMiddleware);
    app.get('/test', (_req, res) => res.status(204).end());
    await request(app).get('/test');
    const snapshot = snapshotMetrics();
    expect(snapshot.scope).toBe('this process since start');
    expect(snapshot.totalRequests).toBeGreaterThan(0);
    expect(snapshot.statusClasses['2xx']).toBeGreaterThan(0);
    expect(snapshot.statusClasses['4xx']).toBeGreaterThan(0);
    expect(snapshot.statusClasses['5xx']).toBeGreaterThan(0);
  });

  test('FR-79h: queue failure increments the failure counter', () => {
    const before = snapshotMetrics().queueFailures;
    recordQueueFailure();
    expect(snapshotMetrics().queueFailures).toBe(before + 1);
  });

  test('FR-79h: the real app counts requests and status classes', async () => {
    const keys = ['NODE_ENV', 'TRUST_PROXY_HOPS', 'JWT_ACCESS_SECRET', 'CORS_ORIGINS', 'PAYMENTS_ENABLED', 'PAYMENT_GATEWAY_PROVIDER'];
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.NODE_ENV = 'production';
    process.env.TRUST_PROXY_HOPS = '1';
    process.env.JWT_ACCESS_SECRET = 'j'.repeat(48);
    process.env.CORS_ORIGINS = 'https://poshaak.test';
    process.env.PAYMENTS_ENABLED = '0';
    process.env.PAYMENT_GATEWAY_PROVIDER = 'fake';
    let app;
    let isolatedMetrics;
    jest.isolateModules(() => {
      app = require('../../src/app');
      isolatedMetrics = require('../../src/lib/metrics');
    });
    try {
      app.get('/__metrics/ok', (_req, res) => res.status(200).json({ ok: true }));
      app.get('/__metrics/boom', () => { throw new Error('forced metrics failure'); });
      const stack = app.router?.stack;
      if (Array.isArray(stack)) {
        const probeIndexes = stack.map((layer, index) =>
          typeof layer.route === 'object' && /^\/__metrics\//.test(layer.route.path) ? index : -1
        ).filter((index) => index >= 0);
        const probes = probeIndexes.reverse().map((index) => stack.splice(index, 1)[0]);
        stack.splice(3, 0, ...probes.reverse());
      }
      const before = isolatedMetrics.snapshotMetrics();
      await request(app).get('/__metrics/ok').set('X-Forwarded-Proto', 'https');
      await request(app).get('/__metrics/missing').set('X-Forwarded-Proto', 'https');
      await request(app).get('/__metrics/boom').set('X-Forwarded-Proto', 'https');
      const after = isolatedMetrics.snapshotMetrics();
      expect(after.totalRequests).toBeGreaterThan(before.totalRequests);
      expect(after.statusClasses['2xx']).toBeGreaterThanOrEqual(before.statusClasses['2xx'] + 1);
      expect(after.statusClasses['4xx']).toBeGreaterThanOrEqual(before.statusClasses['4xx'] + 1);
      expect(after.statusClasses['5xx']).toBeGreaterThanOrEqual(before.statusClasses['5xx'] + 1);
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      jest.resetModules();
    }
  }, 15000);
});
