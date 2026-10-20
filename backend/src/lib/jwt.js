const crypto = require('crypto');

const ISSUER = 'poshaak-api';
const AUDIENCE = 'poshaak-client';
const DEFAULT_ACCESS_TTL_SECONDS = 15 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getJwtConfig(env = process.env) {
  const secret = env.JWT_ACCESS_SECRET;
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('JWT_ACCESS_SECRET must contain at least 32 bytes of externally configured key material.');
  }
  const configuredLifetime = env.JWT_ACCESS_TTL_SECONDS === undefined
    ? DEFAULT_ACCESS_TTL_SECONDS
    : Number(env.JWT_ACCESS_TTL_SECONDS);
  if (!Number.isSafeInteger(configuredLifetime) || configuredLifetime < 1) {
    throw new Error('JWT_ACCESS_TTL_SECONDS must be a positive integer.');
  }
  return { secret, issuer: ISSUER, audience: AUDIENCE, lifetimeSeconds: configuredLifetime };
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signAccessToken(userId, { secret, now = Math.floor(Date.now() / 1000), lifetimeSeconds = DEFAULT_ACCESS_TTL_SECONDS } = {}) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new TypeError('Signing requires at least 32 bytes of key material.');
  }
  if (typeof userId !== 'string' || !UUID.test(userId)) throw new TypeError('A UUID user ID is required.');
  if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 1) throw new TypeError('A positive access-token lifetime is required.');
  const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeJson({ sub: userId, iss: ISSUER, aud: AUDIENCE, iat: now, exp: now + lifetimeSeconds });
  const unsigned = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

function decodePart(value) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded).toString('base64url') !== value) throw new Error();
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new TypeError('Invalid bearer token.');
  }
}

function verifyAccessToken(token, { secret, now = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof token !== 'string' || token.length > 4096) throw new TypeError('Invalid bearer token.');
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('JWT_ACCESS_SECRET must contain at least 32 bytes of externally configured key material.');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) throw new TypeError('Invalid bearer token.');
  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  if (header.alg !== 'HS256' || header.typ !== 'JWT') throw new TypeError('Invalid bearer token.');

  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) throw new TypeError('Invalid bearer token.');
  const provided = Buffer.from(parts[2], 'base64url');
  if (provided.toString('base64url') !== parts[2] || provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new TypeError('Invalid bearer token.');
  }
  if (claims.iss !== ISSUER || claims.aud !== AUDIENCE || !UUID.test(claims.sub || '') ||
      !Number.isSafeInteger(claims.iat) || claims.iat > now + 60 ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= now) {
    throw new TypeError('Invalid bearer token.');
  }
  if (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now)) {
    throw new TypeError('Invalid bearer token.');
  }
  return claims;
}

module.exports = { ISSUER, AUDIENCE, DEFAULT_ACCESS_TTL_SECONDS, getJwtConfig, signAccessToken, verifyAccessToken };
