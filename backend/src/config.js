const { getJwtConfig } = require('./lib/jwt');
const { parseAllowedOrigins } = require('./middleware/cors');

const DEFAULTS = Object.freeze({
  EMAIL_CODE_LENGTH: 6,
  EMAIL_CODE_TTL_SECONDS: 300,
  EMAIL_CODE_MAX_ATTEMPTS: 3,
  EMAIL_CODE_RESEND_SECONDS: 60,
  EMAIL_CODE_ADDRESS_HOURLY_MAX: 5,
  EMAIL_CODE_ADDRESS_DAILY_MAX: 10,
  EMAIL_CODE_IP_SOFT_HOURLY_SIGNAL: 30,
  EMAIL_CODE_FAILURES_HOURLY_LOCK: 10,
  EMAIL_CODE_LOCK_SECONDS: 900,
  PASSWORD_HASH_MAX_CONCURRENCY: 4,
  ARGON2_MEMORY_KIB: 65536,
  ARGON2_TIME_COST: 3,
  ARGON2_PARALLELISM: 1,
  RATE_LIMIT_WINDOW_SECONDS: 3600,
  RATE_LIMIT_LOGIN_IP_MAX: 30,
  RATE_LIMIT_LOGIN_ACCOUNT_MAX: 10,
  RATE_LIMIT_SIGNUP_IP_MAX: 5,
  RATE_LIMIT_SIGNUP_ACCOUNT_MAX: 3,
  RATE_LIMIT_RESET_IP_MAX: 10,
  RATE_LIMIT_RESET_ACCOUNT_MAX: 5,
  RATE_LIMIT_OFFER_IP_MAX: 60,
  RATE_LIMIT_OFFER_ACCOUNT_MAX: 30,
  RATE_LIMIT_MESSAGE_IP_MAX: 120,
  RATE_LIMIT_MESSAGE_ACCOUNT_MAX: 60,
});

const PLACEHOLDER = /(?:CHANGE_ME|CHANGE-ME|YOUR[_ -]?|EXAMPLE|PASSWORD|REPLACE[_ -]?ME)/i;

function positiveInteger(env, key, fallback = DEFAULTS[key]) {
  const raw = env[key];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Configuration error: ${key} must be a positive integer.`);
  }
  return value;
}

function assertCredential(env, key, { minimumBytes = 1 } = {}) {
  const value = env[key];
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < minimumBytes || PLACEHOLDER.test(value)) {
    throw new Error(`Configuration error: ${key} is missing, too short, or still a placeholder.`);
  }
}

function assertUrl(env, key, protocols) {
  assertCredential(env, key);
  let parsed;
  try { parsed = new URL(env[key]); }
  catch { throw new Error(`Configuration error: ${key} must be a valid URL.`); }
  if (!protocols.includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`Configuration error: ${key} must use ${protocols.join(' or ')} and include a host.`);
  }
  return parsed;
}

function getSecurityLimits(env = process.env) {
  const limits = {};
  for (const key of Object.keys(DEFAULTS)) limits[key] = positiveInteger(env, key);
  return Object.freeze(limits);
}

function getRuntimeConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const jwt = getJwtConfig(env);
  const origins = parseAllowedOrigins(env.CORS_ORIGINS || '');
  if (production && origins.size === 0) {
    throw new Error('Configuration error: CORS_ORIGINS must contain at least one allowed origin in production.');
  }

  let database = null;
  let redis = null;
  if (production) {
    database = assertUrl(env, 'DATABASE_URL', ['postgres:', 'postgresql:']);
    if (database.pathname.toLowerCase().includes('testing_only')) {
      throw new Error('Configuration error: DATABASE_URL cannot target testing_only in production.');
    }
    assertCredential(env, 'JWT_ACCESS_SECRET', { minimumBytes: 32 });
    redis = assertUrl(env, 'REDIS_URL', ['redis:', 'rediss:']);
    assertCredential(env, 'EMAIL_PROVIDER_API_KEY');
    assertCredential(env, 'CHALLENGE_PROVIDER_KEY');
    if (env.EMAIL_SENDER_ADAPTER === 'fake' || env.CHALLENGE_VERIFIER_ADAPTER === 'fake' || env.ALLOW_FAKE_ADAPTERS === 'true') {
      throw new Error('Configuration error: fake credential adapters are forbidden in production.');
    }
    if (env.EMAIL_SENDER_ADAPTER !== 'provider' || env.CHALLENGE_VERIFIER_ADAPTER !== 'provider') {
      throw new Error('Configuration error: production requires configured email and challenge provider adapters.');
    }
  } else {
    const selectedFake = env.EMAIL_SENDER_ADAPTER === 'fake' || env.CHALLENGE_VERIFIER_ADAPTER === 'fake';
    if (selectedFake && env.ALLOW_FAKE_ADAPTERS !== 'true') {
      throw new Error('Configuration error: fake adapters require ALLOW_FAKE_ADAPTERS=true outside production.');
    }
  }

  const limits = getSecurityLimits(env);
  const jwtConfig = { ...jwt };
  return Object.freeze({
    production,
    port: positiveInteger(env, 'PORT', 3000),
    jwt: jwtConfig,
    corsOrigins: origins,
    databaseUrl: production ? database.href : env.DATABASE_URL,
    redisUrl: production ? redis.href : env.REDIS_URL,
    limits: Object.freeze(limits),
    emailAdapter: env.EMAIL_SENDER_ADAPTER || null,
    challengeAdapter: env.CHALLENGE_VERIFIER_ADAPTER || null,
    allowFakeAdapters: !production && env.ALLOW_FAKE_ADAPTERS === 'true',
  });
}

module.exports = { DEFAULTS, getSecurityLimits, getRuntimeConfig };
