const { sslOptionFor, urlFor } = require('../../src/lib/databaseConnection');
const { getRuntimeConfig } = require('../../src/config');

describe('FR-79g: database TLS and role URLs', () => {
  test('FR-79g: production refuses startup without DATABASE_SSL=verify-full', () => {
    expect(() => getRuntimeConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://db.test/poshaak',
      DATABASE_SSL: 'disable',
      CORS_ORIGINS: 'https://poshaak.test',
      JWT_ACCESS_SECRET: 'j'.repeat(48),
      REDIS_URL: 'rediss://cache.test',
      EMAIL_SENDER_ADAPTER: 'provider',
      EMAIL_PROVIDER_API_KEY: 'email-key',
      EMAIL_QUEUE_ENCRYPTION_SECRET: 'email-queue-secret-material-at-least-32bytes',
      STAFF_TOTP_ENCRYPTION_SECRET: 'staff-totp-secret-material-at-least-32bytes',
      PAYOUT_ENCRYPTION_ACTIVE_KEY_ID: '2026-01',
      PAYOUT_ENCRYPTION_KEYS_JSON: JSON.stringify({ '2026-01': Buffer.alloc(32, 7).toString('base64') }),
      MEDIA_SIGNING_SECRET: 'media-signing-secret-material-at-least-32bytes',
      CHALLENGE_VERIFIER_ADAPTER: 'provider',
      CHALLENGE_PROVIDER_KEY: 'challenge-key',
    })).toThrow(/DATABASE_SSL/);
  });

  test('FR-79g: verify-full builds an ssl option with rejectUnauthorized true', () => {
    expect(sslOptionFor({ DATABASE_SSL: 'verify-full', DATABASE_CA_CERT: 'CA PEM' }))
      .toEqual({ rejectUnauthorized: true, ca: 'CA PEM' });
  });

  test('FR-79g: worker and migrator URLs fall back to DATABASE_URL', () => {
    const env = { DATABASE_URL: 'postgres://primary.test/poshaak' };
    expect(urlFor('worker', env)).toBe(env.DATABASE_URL);
    expect(urlFor('migrator', env)).toBe(env.DATABASE_URL);
  });

  test('FR-79g: queue URL precedence is unchanged', () => {
    const env = {
      QUEUE_DATABASE_URL: 'postgres://queue.test/poshaak',
      DATABASE_URL_WORKER: 'postgres://worker.test/poshaak',
      DATABASE_URL: 'postgres://web.test/poshaak',
    };
    expect(env.QUEUE_DATABASE_URL || env.DATABASE_URL_WORKER || env.DATABASE_URL)
      .toBe(env.QUEUE_DATABASE_URL);
  });

  test('SEC-37: error messages never contain a connection string', () => {
    expect(() => getRuntimeConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://hidden-user:hidden-password@db.test/poshaak',
    })).not.toThrow(/postgres:\/\/|hidden-password/);
  });
});
