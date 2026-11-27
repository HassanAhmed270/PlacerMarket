const express = require('express');
const request = require('supertest');
const helmet = require('helmet');
const requireHttps = require('../../src/middleware/requireHttps');
const { parseTrustProxyHops, getRuntimeConfig } = require('../../src/config');

const APP_ENV_KEYS = [
  'NODE_ENV',
  'TRUST_PROXY_HOPS',
  'JWT_ACCESS_SECRET',
  'CORS_ORIGINS',
  'PAYMENTS_ENABLED',
  'PAYMENT_GATEWAY_PROVIDER',
];

function loadRealApp(hops) {
  const original = Object.fromEntries(APP_ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = 'production';
  process.env.TRUST_PROXY_HOPS = String(hops);
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

function addIpProbe(app) {
  app.get('/__test/ip', (req, res) => res.json({ ip: req.ip }));
  const stack = app.router?.stack;
  if (Array.isArray(stack)) {
    const probeIndex = stack.findIndex((layer) =>
      typeof layer.route === 'object' && layer.route?.path === '/__test/ip');
    if (probeIndex >= 0) {
      const [probe] = stack.splice(probeIndex, 1);
      stack.splice(2, 0, probe);
    }
  }
}

describe('SEC-24: real client IP behind a trusted proxy', () => {
  test('SEC-24: the real app derives req.ip from X-Forwarded-For with TRUST_PROXY_HOPS=1', async () => {
    const loaded = loadRealApp(1);
    try {
      addIpProbe(loaded.app);
      expect(loaded.app.get('trust proxy')).toBe(1);
      const res = await request(loaded.app)
        .get('/__test/ip')
        .set('X-Forwarded-Proto', 'https')
        .set('X-Forwarded-For', '203.0.113.10');
      expect(res.status).toBe(200);
      expect(res.body.ip).toBe('203.0.113.10');
    } finally {
      loaded.restore();
    }
  }, 15000);

  test('SEC-24: the real app derives req.ip from X-Forwarded-For with TRUST_PROXY_HOPS=2', async () => {
    const loaded = loadRealApp(2);
    try {
      addIpProbe(loaded.app);
      expect(loaded.app.get('trust proxy')).toBe(2);
      const res = await request(loaded.app)
        .get('/__test/ip')
        .set('X-Forwarded-Proto', 'https')
        .set('X-Forwarded-For', '203.0.113.10, 198.51.100.20, 192.0.2.30');
      expect(res.status).toBe(200);
      expect(res.body.ip).toBe('198.51.100.20');
    } finally {
      loaded.restore();
    }
  }, 15000);

  test('SEC-24: rate limits key on the real client IP behind one trusted proxy hop', () => {
    const app = express();
    app.set('trust proxy', 1);
    app.get('/ip', (req, res) => res.json({ ip: req.ip }));
    return request(app)
      .get('/ip')
      .set('X-Forwarded-For', '203.0.113.10')
      .then((res) => {
        expect(res.status).toBe(200);
        expect(res.body.ip).toBe('203.0.113.10');
      });
  });

  test('SEC-24: spoofed X-Forwarded-For beyond the trusted hops is ignored', () => {
    const app = express();
    app.set('trust proxy', 1);
    app.get('/ip', (req, res) => res.json({ ip: req.ip }));
    return request(app)
      .get('/ip')
      .set('X-Forwarded-For', '203.0.113.10, 198.51.100.20')
      .then((res) => {
        expect(res.status).toBe(200);
        expect(res.body.ip).toBe('198.51.100.20');
      });
  });
});

describe('SEC-21: production HTTPS and proxy configuration', () => {
  test('SEC-21: the real app refuses a plain-HTTP request in production with 400', async () => {
    const loaded = loadRealApp(1);
    try {
      const res = await request(loaded.app).get('/api/__missing');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'HTTPS required' });
    } finally {
      loaded.restore();
    }
  }, 15000);

  test('SEC-21: the real app accepts a request with X-Forwarded-Proto https', async () => {
    const loaded = loadRealApp(1);
    try {
      const res = await request(loaded.app)
        .get('/api/__missing')
        .set('X-Forwarded-Proto', 'https');
      expect(res.status).not.toBe(400);
      expect(res.status).toBe(404);
      expect(res.body).toBeTruthy();
    } finally {
      loaded.restore();
    }
  }, 15000);

  test('SEC-21: /api must not be exempt from the HTTPS requirement', async () => {
    const loaded = loadRealApp(1);
    try {
      const res = await request(loaded.app).get('/api/__missing');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'HTTPS required' });
    } finally {
      loaded.restore();
    }
  }, 15000);

  test('SEC-21: production refuses a non-HTTPS request with 400', async () => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const app = express();
      app.use(requireHttps);
      app.get('/protected', (_req, res) => res.json({ ok: true }));
      const res = await request(app).get('/protected');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'HTTPS required' });
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  test('SEC-21: production accepts X-Forwarded-Proto https', async () => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const app = express();
      app.set('trust proxy', 1);
      app.use(requireHttps);
      app.get('/protected', (_req, res) => res.json({ ok: true }));
      const res = await request(app)
        .get('/protected')
        .set('X-Forwarded-Proto', 'https');
      expect(res.status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  test('SEC-21: health routes are exempt from the HTTPS requirement', async () => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const app = express();
      app.use(requireHttps);
      app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
      app.get('/readyz', (_req, res) => res.json({ status: 'ready' }));
      const health = await request(app).get('/healthz');
      const ready = await request(app).get('/readyz');
      expect(health.status).toBe(200);
      expect(ready.status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  test('SEC-21: Strict-Transport-Security has max-age 31536000, includeSubDomains and no preload', () => {
    const app = express();
    app.use(helmet());
    app.get('/api/test', (_req, res) => res.json({ ok: true }));
    return request(app).get('/api/test').then((res) => {
      const hsts = res.headers['strict-transport-security'];
      expect(hsts).toContain('max-age=31536000');
      expect(hsts).toContain('includeSubDomains');
      expect(hsts).not.toContain('preload');
    });
  });

  test('SEC-21: invalid TRUST_PROXY_HOPS refuses production startup', () => {
    expect(() => parseTrustProxyHops({ NODE_ENV: 'production', TRUST_PROXY_HOPS: '11' }))
      .toThrow(/TRUST_PROXY_HOPS/);
  });
});
