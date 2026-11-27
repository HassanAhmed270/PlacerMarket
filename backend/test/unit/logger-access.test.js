const express = require('express');
const request = require('supertest');
const { logger, safeFields } = require('../../src/lib/logger');
const accessLog = require('../../src/middleware/accessLog');

describe('FR-79g, SEC-27: logging redaction and access metadata', () => {
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
    output.mockRestore();
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });

  test('FR-79g: production logger emits valid JSON lines with UTC time', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const output = jest.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('safe event', { status: 200 });
    const line = output.mock.calls[0][0];
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe('info');
    expect(parsed.time).toMatch(/T.*Z$/);
    output.mockRestore();
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
});
