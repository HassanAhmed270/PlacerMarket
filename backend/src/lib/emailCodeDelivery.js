const { createHmac, randomInt, timingSafeEqual } = require('node:crypto');
const queue = require('./queue');
const { getSharedRedisClient } = require('./redis');
const { getSecurityLimits } = require('../config');
const { encryptEmailPayload } = require('./emailQueuePayload');
const { ServiceUnavailableError, ValidationError } = require('./errors');

const RESERVE_CODE_LUA = `
local cooldown = redis.call('EXISTS', KEYS[3])
local hourly = tonumber(redis.call('GET', KEYS[1]) or '0')
local daily = tonumber(redis.call('GET', KEYS[2]) or '0')
if cooldown == 1 or hourly >= tonumber(ARGV[1]) or daily >= tonumber(ARGV[2]) then return 0 end
hourly = redis.call('INCR', KEYS[1])
if hourly == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4])) end
daily = redis.call('INCR', KEYS[2])
if daily == 1 then redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5])) end
redis.call('SET', KEYS[3], '1', 'EX', tonumber(ARGV[3]))
return 1
`;
const FAILED_CODE_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then return -1 end
if ARGV[3] == '0' then return 0 end
local failures = redis.call('INCR', KEYS[1])
if failures == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4])) end
if failures >= tonumber(ARGV[1]) then
  redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[2]))
  return -1
end
return failures
`;

function addressDigest(email) {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new ServiceUnavailableError('Code verification is temporarily unavailable.');
  }
  return createHmac('sha256', secret).update('poshaak-email-address-v1\0').update(email.trim().toLowerCase()).digest('hex');
}

function makeCode() {
  const length = getSecurityLimits().EMAIL_CODE_LENGTH;
  return String(randomInt(0, 10 ** length)).padStart(length, '0');
}

function hashCode(code, secret = process.env.JWT_ACCESS_SECRET) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new ServiceUnavailableError('Code verification is temporarily unavailable.');
  }
  return createHmac('sha256', secret).update(code).digest('hex');
}

function equalHash(actual, expected) {
  const left = Buffer.from(actual || '', 'hex');
  const right = Buffer.from(expected || '', 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

async function reserveAddressSend(email, client = getSharedRedisClient(), limits = getSecurityLimits()) {
  if (!client?.isOpen || typeof client.eval !== 'function') {
    throw new ServiceUnavailableError('Request protection is temporarily unavailable.');
  }
  const digest = addressDigest(email);
  const keyBase = `pm:email-code:{${digest}}`;
  let allowed;
  try {
    allowed = await client.eval(RESERVE_CODE_LUA, {
      keys: [`${keyBase}:hour`, `${keyBase}:day`, `${keyBase}:cooldown`],
      arguments: [
        String(limits.EMAIL_CODE_ADDRESS_HOURLY_MAX),
        String(limits.EMAIL_CODE_ADDRESS_DAILY_MAX),
        String(limits.EMAIL_CODE_RESEND_SECONDS),
        String(limits.EMAIL_CODE_HOURLY_WINDOW_SECONDS),
        String(limits.EMAIL_CODE_DAILY_WINDOW_SECONDS),
      ],
    });
  } catch {
    throw new ServiceUnavailableError('Request protection is temporarily unavailable.');
  }
  if (Number(allowed) !== 1) throw new ValidationError('Please wait before requesting another email code.');
}

async function queueCodeEmail(email, code, { transaction, idempotencyKey } = {}) {
  const encryptedPayload = encryptEmailPayload({
    to: email,
    subject: 'Your Poshaak verification code',
    text: `Your verification code is ${code}. It expires in five minutes.`,
  });
  return queue.enqueue(queue.QUEUES.EMAIL, { encryptedPayload }, {
    idempotencyKey,
    orderingKey: `email-code:${addressDigest(email)}`,
    transaction,
  });
}

async function queueEmail(email, subject, text, { transaction, idempotencyKey } = {}) {
  const encryptedPayload = encryptEmailPayload({ to: email, subject, text });
  return queue.enqueue(queue.QUEUES.EMAIL, { encryptedPayload }, {
    idempotencyKey,
    orderingKey: `email-code:${addressDigest(email)}`,
    transaction,
  });
}

async function emailCodeLockedForDigest(digest, { failed = false, client = getSharedRedisClient(), limits = getSecurityLimits() } = {}) {
  if (!client?.isOpen || typeof client.eval !== 'function') {
    throw new ServiceUnavailableError('Request protection is temporarily unavailable.');
  }
  const base = `pm:email-verify:{${digest}}`;
  try {
    const result = Number(await client.eval(FAILED_CODE_LUA, {
      keys: [`${base}:failures`, `${base}:lock`],
      arguments: [
        String(limits.EMAIL_CODE_FAILURES_HOURLY_LOCK), String(limits.EMAIL_CODE_LOCK_SECONDS),
        failed ? '1' : '0', String(limits.EMAIL_CODE_FAILURE_WINDOW_SECONDS),
      ],
    }));
    return result < 0;
  } catch {
    throw new ServiceUnavailableError('Request protection is temporarily unavailable.');
  }
}

async function emailVerificationLocked(email, options) {
  return emailCodeLockedForDigest(addressDigest(email), options);
}

module.exports = {
  makeCode, addressDigest, queueCodeEmail, queueEmail, reserveAddressSend, emailVerificationLocked, emailCodeLockedForDigest,
  hashCode, equalHash,
};
