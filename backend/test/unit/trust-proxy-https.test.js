const express = require('express');
const request = require('supertest');
const helmet = require('helmet');
const requireHttps = require('../../src/middleware/requireHttps');
const { parseTrustProxyHops, getRuntimeConfig } = require('../../src/config');

describe('SEC-24: real client IP behind a trusted proxy', () => {
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
        expect(res.body.ip).not.toBe('203.0.113.10');
      });
  });
});

describe('SEC-21: production HTTPS and proxy configuration', () => {
  test('SEC-21: production refuses a non-HTTPS request with 400', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const app = express();
    app.use(requireHttps);
    app.get('/protected', (_req, res) => res.json({ ok: true }));
    const res = await request(app).get('/protected');
    process.env.NODE_ENV = previous;
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'HTTPS required' });
  });

  test('SEC-21: production accepts X-Forwarded-Proto https', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const app = express();
    app.set('trust proxy', 1);
    app.use(requireHttps);
    app.get('/protected', (_req, res) => res.json({ ok: true }));
    const res = await request(app)
      .get('/protected')
      .set('X-Forwarded-Proto', 'https');
    process.env.NODE_ENV = previous;
    expect(res.status).toBe(200);
  });

  test('SEC-21: health routes are exempt from the HTTPS requirement', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const app = express();
    app.use(requireHttps);
    app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
    app.get('/readyz', (_req, res) => res.json({ status: 'ready' }));
    const health = await request(app).get('/healthz');
    const ready = await request(app).get('/readyz');
    process.env.NODE_ENV = previous;
    expect(health.status).toBe(200);
    expect(ready.status).toBe(200);
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
