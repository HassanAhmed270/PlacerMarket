const { DEFAULTS, getRuntimeConfig } = require('../../src/config');

function validProductionEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://app:strong-db-secret@db.test:5432/poshaak',
    REDIS_URL: 'rediss://cache.test:6380',
    JWT_ACCESS_SECRET: 'j'.repeat(48),
    JWT_ACCESS_TTL_SECONDS: '900',
    CORS_ORIGINS: 'https://poshaak.test',
    EMAIL_SENDER_ADAPTER: 'provider',
    EMAIL_PROVIDER_API_KEY: 'email-provider-secret',
    EMAIL_QUEUE_ENCRYPTION_SECRET: 'email-queue-encryption-secret-material-32bytes',
    CHALLENGE_VERIFIER_ADAPTER: 'provider',
    CHALLENGE_PROVIDER_KEY: 'challenge-provider-secret',
    ...overrides,
  };
}

describe('FR-84c: production configuration validation', () => {
  test('refuses missing production credentials with a clear key-specific message', () => {
    const env = validProductionEnv();
    delete env.DATABASE_URL;
    expect(() => getRuntimeConfig(env)).toThrow('DATABASE_URL is missing');
  });

  test('refuses placeholder credentials and the disposable integration database', () => {
    expect(() => getRuntimeConfig(validProductionEnv({ EMAIL_PROVIDER_API_KEY: 'CHANGE_ME' })))
      .toThrow('EMAIL_PROVIDER_API_KEY is missing');
    expect(() => getRuntimeConfig(validProductionEnv({ EMAIL_QUEUE_ENCRYPTION_SECRET: 'CHANGE_ME' })))
      .toThrow('EMAIL_QUEUE_ENCRYPTION_SECRET is missing');
    expect(() => getRuntimeConfig(validProductionEnv({ DATABASE_URL: 'postgres://user:pass@db.test/testing_only' })))
      .toThrow('cannot target testing_only');
  });

  test('refuses wildcard or empty production CORS origins', () => {
    expect(() => getRuntimeConfig(validProductionEnv({ CORS_ORIGINS: '*' })))
      .toThrow('CORS_ORIGINS must contain exact HTTP(S) origins');
    expect(() => getRuntimeConfig(validProductionEnv({ CORS_ORIGINS: '' })))
      .toThrow('CORS_ORIGINS must contain at least one');
  });

  test('refuses fake adapters and missing provider configuration in production', () => {
    expect(() => getRuntimeConfig(validProductionEnv({ EMAIL_SENDER_ADAPTER: 'fake' })))
      .toThrow('fake credential adapters are forbidden');
    expect(() => getRuntimeConfig(validProductionEnv({ CHALLENGE_VERIFIER_ADAPTER: undefined })))
      .toThrow('production requires configured email and challenge provider adapters');
  });

  test('requires an explicit opt-in before selecting development fakes', () => {
    const env = {
      JWT_ACCESS_SECRET: 'j'.repeat(32), CORS_ORIGINS: 'http://localhost:5173',
      EMAIL_SENDER_ADAPTER: 'fake',
    };
    expect(() => getRuntimeConfig(env)).toThrow('ALLOW_FAKE_ADAPTERS=true');
    expect(getRuntimeConfig({ ...env, ALLOW_FAKE_ADAPTERS: 'true' }).allowFakeAdapters).toBe(true);
  });

  test('loads approved FR-83d values and configurable FR-84b settings', () => {
    const config = getRuntimeConfig({
      JWT_ACCESS_SECRET: 'j'.repeat(32),
      CORS_ORIGINS: 'http://localhost:5173',
      EMAIL_CODE_RESEND_SECONDS: '75',
      PASSWORD_HASH_MAX_CONCURRENCY: '2',
      RATE_LIMIT_LOGIN_ACCOUNT_MAX: '8',
    });
    expect(config.limits).toMatchObject({
      EMAIL_CODE_LENGTH: 6,
      EMAIL_CODE_TTL_SECONDS: 300,
      EMAIL_CODE_MAX_ATTEMPTS: 3,
      EMAIL_CODE_RESEND_SECONDS: 75,
      EMAIL_CODE_ADDRESS_HOURLY_MAX: 5,
      EMAIL_CODE_ADDRESS_DAILY_MAX: 10,
      EMAIL_CODE_IP_SOFT_HOURLY_SIGNAL: 30,
      EMAIL_CODE_FAILURES_HOURLY_LOCK: 10,
      EMAIL_CODE_FAILURE_WINDOW_SECONDS: 3600,
      EMAIL_CODE_LOCK_SECONDS: 900,
      EMAIL_CODE_HOURLY_WINDOW_SECONDS: 3600,
      EMAIL_CODE_DAILY_WINDOW_SECONDS: 86400,
      PASSWORD_HASH_MAX_CONCURRENCY: 2,
      RATE_LIMIT_LOGIN_ACCOUNT_MAX: 8,
    });
    expect(DEFAULTS.ARGON2_MEMORY_KIB).toBeGreaterThan(0);
  });

  test('rejects invalid configured limits', () => {
    expect(() => getRuntimeConfig({
      JWT_ACCESS_SECRET: 'j'.repeat(32), CORS_ORIGINS: 'http://localhost:5173',
      EMAIL_CODE_MAX_ATTEMPTS: '0',
    })).toThrow('EMAIL_CODE_MAX_ATTEMPTS must be a positive integer');
  });
});
