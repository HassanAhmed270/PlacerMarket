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
    STAFF_TOTP_ENCRYPTION_SECRET: 'staff-totp-encryption-key-material-at-least-32bytes',
    PAYOUT_ENCRYPTION_ACTIVE_KEY_ID: '2026-01',
    PAYOUT_ENCRYPTION_KEYS_JSON: JSON.stringify({ '2026-01': Buffer.alloc(32, 7).toString('base64') }),
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

  test('FR-79f: production requires a valid active payout encryption key', () => {
    expect(getRuntimeConfig(validProductionEnv()).payoutKeyProvider.activeKeyId).toBe('2026-01');
    expect(() => getRuntimeConfig(validProductionEnv({ PAYOUT_ENCRYPTION_ACTIVE_KEY_ID: 'missing' })))
      .toThrow('PAYOUT_ENCRYPTION_ACTIVE_KEY_ID');
    expect(() => getRuntimeConfig(validProductionEnv({ PAYOUT_ENCRYPTION_KEYS_JSON: 'CHANGE_ME' })))
      .toThrow('PAYOUT_ENCRYPTION_KEYS_JSON');
    expect(() => getRuntimeConfig(validProductionEnv({ PAYOUT_ENCRYPTION_KEYS_JSON: JSON.stringify({ k: 'c2hvcnQ=' }) })))
      .toThrow('exactly 32 bytes');
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
    expect(() => getRuntimeConfig(validProductionEnv({ DEV_FAKES: '1' })))
      .toThrow('fake credential adapters are forbidden');
  });

  test('requires an explicit opt-in before selecting development fakes', () => {
    const env = {
      JWT_ACCESS_SECRET: 'j'.repeat(32), CORS_ORIGINS: 'http://localhost:5173',
      EMAIL_SENDER_ADAPTER: 'fake',
    };
    expect(() => getRuntimeConfig(env)).toThrow('ALLOW_FAKE_ADAPTERS=true');
    expect(getRuntimeConfig({ ...env, ALLOW_FAKE_ADAPTERS: 'true' }).allowFakeAdapters).toBe(true);
  });

  test('Stage 8 DEV_FAKES opt-in enables development adapters but production rejects it', () => {
    const env = { JWT_ACCESS_SECRET: 'j'.repeat(32), CORS_ORIGINS: 'http://localhost:5173',
      EMAIL_SENDER_ADAPTER: 'fake', DEV_FAKES: '1' };
    expect(getRuntimeConfig(env).allowFakeAdapters).toBe(true);
    expect(() => getRuntimeConfig(validProductionEnv({ DEV_FAKES: '1' })))
      .toThrow('fake credential adapters are forbidden in production');
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

  test('FR-84c: reset expiry is configurable and staff TOTP key is required in production', () => {
    const config = getRuntimeConfig({
      ...validProductionEnv(),
      PASSWORD_RESET_TTL_SECONDS: '900',
    });
    expect(config.limits.PASSWORD_RESET_TTL_SECONDS).toBe(900);
    expect(() => getRuntimeConfig(validProductionEnv({ STAFF_TOTP_ENCRYPTION_SECRET: undefined })))
      .toThrow('STAFF_TOTP_ENCRYPTION_SECRET is missing');
  });

  test('rejects invalid configured limits', () => {
    expect(() => getRuntimeConfig({
      JWT_ACCESS_SECRET: 'j'.repeat(32), CORS_ORIGINS: 'http://localhost:5173',
      EMAIL_CODE_MAX_ATTEMPTS: '0',
    })).toThrow('EMAIL_CODE_MAX_ATTEMPTS must be a positive integer');
    expect(() => getRuntimeConfig({ JWT_ACCESS_SECRET: 'j'.repeat(32), STEP_UP_GRANT_TTL_SECONDS: '901' }))
      .toThrow('STEP_UP_GRANT_TTL_SECONDS must not exceed 900');
  });
});
