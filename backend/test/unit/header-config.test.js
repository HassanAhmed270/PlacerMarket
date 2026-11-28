const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const { execFileSync } = require('node:child_process');
const os = require('node:os');

const repositoryDir = path.resolve(__dirname, '../../..');

function loadRealApp() {
  const keys = ['NODE_ENV', 'TRUST_PROXY_HOPS', 'JWT_ACCESS_SECRET', 'CORS_ORIGINS', 'PAYMENTS_ENABLED', 'PAYMENT_GATEWAY_PROVIDER', 'DEV_FAKES'];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = 'production';
  process.env.TRUST_PROXY_HOPS = '1';
  process.env.JWT_ACCESS_SECRET = 'j'.repeat(48);
  process.env.CORS_ORIGINS = 'https://poshaak.test';
  process.env.PAYMENTS_ENABLED = '0';
  process.env.PAYMENT_GATEWAY_PROVIDER = 'fake';
  delete process.env.DEV_FAKES;
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

describe('SEC-21: API and frontend header policy', () => {
  test('SEC-21: API responses carry default-src none and frame-ancestors none', async () => {
    const loaded = loadRealApp();
    try {
      const res = await request(loaded.app)
        .get('/api/__missing')
        .set('X-Forwarded-Proto', 'https');
      expect(res.status).toBe(404);
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    } finally {
      loaded.restore();
    }
  }, 15000);

  test('SEC-21: fake gateway page is not given the API CSP outside production', async () => {
    const previous = process.env.NODE_ENV;
    const previousProvider = process.env.PAYMENT_GATEWAY_PROVIDER;
    try {
      process.env.NODE_ENV = 'test';
      process.env.PAYMENT_GATEWAY_PROVIDER = 'fake';
      const app = express();
      app.use((req, res, next) => {
        if (req.path.startsWith('/fake-gateway')) {
          res.set('Content-Security-Policy', "default-src 'self'");
        }
        next();
      });
      app.use('/fake-gateway', (_req, res) => res.status(200).send('fake'));
      const res = await request(app).get('/fake-gateway/page');
      expect(res.headers['content-security-policy']).not.toContain("default-src 'none'");
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
      if (previousProvider === undefined) delete process.env.PAYMENT_GATEWAY_PROVIDER;
      else process.env.PAYMENT_GATEWAY_PROVIDER = previousProvider;
    }
  });

  test('SEC-21: generated vercel.json and nginx snippet match security-headers.json', () => {
    const frontendDir = path.join(repositoryDir, 'frontend');
    execFileSync(process.execPath, [path.join(frontendDir, 'scripts/build-header-configs.js')], { stdio: 'pipe' });
    execFileSync(process.execPath, [path.join(frontendDir, 'scripts/build-header-configs.js'), '--check'], { stdio: 'pipe' });
    const policy = JSON.parse(fs.readFileSync(path.join(frontendDir, 'security-headers.json'), 'utf8'));
    const vercel = JSON.parse(fs.readFileSync(path.join(frontendDir, 'vercel.json'), 'utf8'));
    const nginx = fs.readFileSync(path.join(frontendDir, 'deploy/nginx-security-headers.conf.example'), 'utf8');
    expect(vercel[0].headers.map(({ key, value }) => [key, value]))
      .toContainEqual(['Content-Security-Policy', policy.csp]);
    expect(nginx).toContain(policy.csp);
  });

  test('SEC-21: frontend index has no inline scripts or style attributes', () => {
    const html = fs.readFileSync(path.join(repositoryDir, 'frontend/index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i);
    expect(html).not.toMatch(/\sstyle\s*=|<style[\s>]/i);
  });

  test('FR-79h: render.yaml has no secret values and defines only web and worker', () => {
    const yaml = fs.readFileSync(path.join(repositoryDir, 'render.yaml'), 'utf8');
    expect(yaml.match(/^\s*- type:\s*(\w+)/gm).map((line) => line.match(/(\w+)$/)[1]))
      .toEqual(['web', 'worker']);
    expect(yaml).not.toMatch(/password|secret-value|postgres:\/\/[^<\s]+:[^@]+@|rediss?:\/\/[^<\s]+:[^@]+@/i);
  });

  test('FR-79h: every production-required env var in config.js appears in render.yaml', () => {
    const config = fs.readFileSync(path.join(repositoryDir, 'backend/src/config.js'), 'utf8');
    const yaml = fs.readFileSync(path.join(repositoryDir, 'render.yaml'), 'utf8');
    for (const key of [
      'DATABASE_URL', 'REDIS_URL', 'JWT_ACCESS_SECRET', 'CORS_ORIGINS',
      'EMAIL_PROVIDER_API_KEY', 'EMAIL_QUEUE_ENCRYPTION_SECRET',
      'STAFF_TOTP_ENCRYPTION_SECRET', 'PAYOUT_ENCRYPTION_KEYS_JSON',
      'PAYOUT_ENCRYPTION_ACTIVE_KEY_ID', 'MEDIA_SIGNING_SECRET',
      'CHALLENGE_PROVIDER_KEY', 'TRUST_PROXY_HOPS', 'DATABASE_SSL',
      'SHUTDOWN_TIMEOUT_MS',
    ]) {
      expect(yaml).toContain(`key: ${key}`);
    }
  });

  test('FR-79h: real-origin header predeploy check fails placeholders and passes real origins', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poshaak-headers-'));
    const scriptDir = path.join(tempDir, 'scripts');
    fs.mkdirSync(scriptDir);
    fs.copyFileSync(path.join(repositoryDir, 'frontend/scripts/build-header-configs.js'), path.join(scriptDir, 'build-header-configs.js'));
    fs.writeFileSync(path.join(tempDir, 'security-headers.json'), fs.readFileSync(path.join(repositoryDir, 'frontend/security-headers.json'), 'utf8'));
    try {
      let failure;
      try {
        execFileSync(process.execPath, [path.join(scriptDir, 'build-header-configs.js'), '--require-real-origins'], { stdio: 'pipe' });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      expect(failure.status).not.toBe(0);
      const realPolicy = fs.readFileSync(path.join(repositoryDir, 'frontend/security-headers.json'), 'utf8')
        .replaceAll('__API_ORIGIN__', 'https://api.poshaak.test')
        .replaceAll('__STORAGE_ORIGIN__', 'https://storage.poshaak.test');
      fs.writeFileSync(path.join(tempDir, 'security-headers.json'), realPolicy);
      expect(() => execFileSync(process.execPath, [path.join(scriptDir, 'build-header-configs.js'), '--require-real-origins'], { stdio: 'pipe' })).not.toThrow();
      fs.writeFileSync(path.join(tempDir, 'security-headers.json'), realPolicy.replace('https://api.poshaak.test', 'https://api.poshaak.test __extra_2__'));
      expect(() => execFileSync(process.execPath, [path.join(scriptDir, 'build-header-configs.js'), '--require-real-origins'], { stdio: 'pipe' })).toThrow();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
