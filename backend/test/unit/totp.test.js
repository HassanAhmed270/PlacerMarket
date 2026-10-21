const {
  generateTotpSecret, generateTotpCode, encryptStaffTotpSecret, decryptStaffTotpSecret, verifyTotpCode,
} = require('../../src/lib/totp');

describe('FR-83h: staff authenticator credentials use encrypted TOTP and RFC-compatible codes', () => {
  const key = 'test-staff-totp-encryption-key-material-over-32-bytes';

  test('FR-83h: generated TOTP secrets are base32 and AES-GCM encrypted at rest', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    const stored = encryptStaffTotpSecret(secret, { encryptionSecret: key });
    expect(stored.encryptedSecret.toString()).not.toContain(secret);
    expect(decryptStaffTotpSecret({
      encrypted_secret: stored.encryptedSecret,
      nonce: stored.nonce,
      auth_tag: stored.authTag,
    }, key)).toBe(secret);
    expect(() => decryptStaffTotpSecret({
      encrypted_secret: stored.encryptedSecret, nonce: stored.nonce, auth_tag: Buffer.alloc(16),
    }, key)).toThrow();
  });

  test('FR-83h: TOTP verification matches the published SHA-1 six-digit test vector', () => {
    expect(verifyTotpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '287082', { now: 59000, window: 0 })).toBe(true);
    expect(verifyTotpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '287083', { now: 59000, window: 0 })).toBe(false);
    expect(generateTotpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000)).toBe('287082');
  });
});
