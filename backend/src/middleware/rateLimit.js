const { createHmac } = require('node:crypto');
const { getSecurityLimits } = require('../config');
const { getSharedRedisClient } = require('../lib/redis');
const { ServiceUnavailableError } = require('../lib/errors');

const INCREMENT_LUA = `
local first = redis.call('INCR', KEYS[1])
if first == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local second = redis.call('INCR', KEYS[2])
if second == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
return { first, second }
`;

const SOFT_SIGNAL_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`;

function digest(value) {
  const secret = process.env.JWT_ACCESS_SECRET || 'non-production-rate-limit-test-key';
  return createHmac('sha256', secret).update(String(value)).digest('hex');
}

function identityFromRequest(req, kind) {
  if (kind === 'ip') return req.ip || req.socket?.remoteAddress || 'unknown';
  if (kind === 'account') {
    if (req.user?.id) return `user:${req.user.id}`;
    const email = req.body?.email;
    return typeof email === 'string' && email.trim() ? `email:${email.trim().toLowerCase()}` : 'account:missing';
  }
  if (kind === 'conversation') return `user:${req.user?.id || 'anonymous'}`;
  return `user:${req.user?.id || 'anonymous'}`;
}

function createRateLimiter({ category, ipMax, accountMax, windowSeconds, clientProvider = getSharedRedisClient }) {
  if (!category || !Number.isSafeInteger(ipMax) || !Number.isSafeInteger(accountMax) || !Number.isSafeInteger(windowSeconds)) {
    throw new TypeError('Rate limiter requires a category and positive integer limits.');
  }
  return async function rateLimit(req, res, next) {
    const client = clientProvider();
    if (!client?.isOpen || typeof client.eval !== 'function') {
      return next(new ServiceUnavailableError('Request protection is temporarily unavailable.'));
    }
    const ipHash = digest(identityFromRequest(req, 'ip'));
    const accountHash = digest(identityFromRequest(req, 'account'));
    const keys = [`pm:rl:{${category}}:ip:${ipHash}`, `pm:rl:{${category}}:account:${accountHash}`];
    try {
      const counts = await client.eval(INCREMENT_LUA, { keys, arguments: [String(windowSeconds)] });
      if (Number(counts[0]) > ipMax || Number(counts[1]) > accountMax) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
      }
      return next();
    } catch {
      return next(new ServiceUnavailableError('Request protection is temporarily unavailable.'));
    }
  };
}

function createSoftChallengeSignal({ threshold, windowSeconds, clientProvider = getSharedRedisClient }) {
  async function evaluate(req) {
    const client = clientProvider();
    if (!client?.isOpen || typeof client.eval !== 'function') {
      throw new ServiceUnavailableError('Request protection is temporarily unavailable.');
    }
    const key = `pm:challenge:ip:${digest(identityFromRequest(req, 'ip'))}`;
    try {
      const count = Number(await client.eval(SOFT_SIGNAL_LUA, { keys: [key], arguments: [String(windowSeconds)] }));
      return count > threshold;
    } catch {
      throw new ServiceUnavailableError('Request protection is temporarily unavailable.');
    }
  }
  const middleware = async (req, _res, next) => {
    try {
      req.challengeSignal = await evaluate(req);
      return next();
    } catch (error) { return next(error); }
  };
  middleware.evaluate = evaluate;
  return middleware;
}

function createConfiguredRateLimiters(env = process.env, clientProvider = getSharedRedisClient) {
  const limits = getSecurityLimits(env);
  const windowSeconds = limits.RATE_LIMIT_WINDOW_SECONDS;
  const make = (category, name) => createRateLimiter({
    category,
    ipMax: limits[`RATE_LIMIT_${name}_IP_MAX`],
    accountMax: limits[`RATE_LIMIT_${name}_ACCOUNT_MAX`],
    windowSeconds,
    clientProvider,
  });
  return Object.freeze({
    login: make('login', 'LOGIN'),
    signup: make('signup', 'SIGNUP'),
    reset: make('reset', 'RESET'),
    offer: make('offer', 'OFFER'),
    message: make('message', 'MESSAGE'),
    security: make('security', 'SECURITY'),
    emailCodeIpSignal: createSoftChallengeSignal({
      threshold: limits.EMAIL_CODE_IP_SOFT_HOURLY_SIGNAL,
      windowSeconds: limits.EMAIL_CODE_IP_SIGNAL_WINDOW_SECONDS,
      clientProvider,
    }),
  });
}

module.exports = { createConfiguredRateLimiters, createRateLimiter, createSoftChallengeSignal };
