const {
  getJwtConfig, signAccessToken, verifyAccessToken, ISSUER, AUDIENCE,
} = require('../../src/lib/jwt');

const secret = 'unit-test-only-secret-with-at-least-32-bytes';
const subject = '8406f3cf-7aa7-4a71-9f4a-c9ecda3b2a14';

describe('FR-84, SEC-02, SEC-03: access-token validation', () => {
  test('FR-84, SEC-03: accepts a valid HS256 token with issuer, audience, subject and expiry', () => {
    const token = signAccessToken(subject, { secret, now: 1000, lifetimeSeconds: 900 });
    expect(verifyAccessToken(token, { secret, now: 1001 })).toMatchObject({
      sub: subject, iss: ISSUER, aud: AUDIENCE, iat: 1000, exp: 1900,
    });
  });

  test('SEC-02: rejects missing or short external signing secrets', () => {
    expect(() => getJwtConfig({})).toThrow(/at least 32 bytes/);
    expect(() => getJwtConfig({ JWT_ACCESS_SECRET: 'short' })).toThrow(/at least 32 bytes/);
  });

  test('SEC-03: rejects expired, tampered, malformed, wrong-audience and wrong-algorithm tokens', () => {
    const token = signAccessToken(subject, { secret, now: 1000, lifetimeSeconds: 10 });
    expect(() => verifyAccessToken(token, { secret, now: 1010 })).toThrow(/Invalid bearer token/);
    const alteredSignature = `${token.slice(0, token.lastIndexOf('.') + 2)}${token[token.lastIndexOf('.') + 1] === 'A' ? 'B' : 'A'}${token.slice(token.lastIndexOf('.') + 3)}`;
    expect(() => verifyAccessToken(alteredSignature, { secret, now: 1001 })).toThrow(/Invalid bearer token/);
    expect(() => verifyAccessToken('not.a.jwt', { secret })).toThrow(/Invalid bearer token/);

    const [header, payload, signature] = token.split('.');
    const wrongAudience = Buffer.from(JSON.stringify({ sub: subject, iss: ISSUER, aud: 'other', iat: 1000, exp: 2000 })).toString('base64url');
    const wrongAudSignature = require('crypto').createHmac('sha256', secret).update(`${header}.${wrongAudience}`).digest('base64url');
    expect(() => verifyAccessToken(`${header}.${wrongAudience}.${wrongAudSignature}`, { secret, now: 1001 })).toThrow(/Invalid bearer token/);

    const wrongHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const wrongAlgSignature = require('crypto').createHmac('sha256', secret).update(`${wrongHeader}.${payload}`).digest('base64url');
    expect(() => verifyAccessToken(`${wrongHeader}.${payload}.${wrongAlgSignature}`, { secret, now: 1001 })).toThrow(/Invalid bearer token/);
  });
});
