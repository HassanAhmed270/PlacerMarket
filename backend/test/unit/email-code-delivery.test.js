jest.mock('../../src/db.service', () => ({ withTransaction: jest.fn() }));
jest.mock('../../src/lib/queue', () => ({
  QUEUES: { EMAIL: 'email' },
  enqueue: jest.fn().mockResolvedValue('job-id'),
}));

const queue = require('../../src/lib/queue');
const { encryptEmailPayload, decryptEmailPayload } = require('../../src/lib/emailQueuePayload');
const { hashCode, equalHash, reserveAddressSend, emailVerificationLocked } = require('../../src/lib/emailCodeDelivery');

const secret = 'test-secret-material-that-is-at-least-32-bytes';

describe('FR-83d: email-code safety and delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EMAIL_QUEUE_ENCRYPTION_SECRET = secret;
    process.env.JWT_ACCESS_SECRET = secret;
  });

  test('FR-83d: queued email payload encrypts the six-digit code at rest', () => {
    const encrypted = encryptEmailPayload({ to: 'buyer@example.test', subject: 'Code', text: '123456' }, secret);
    expect(JSON.stringify(encrypted)).not.toContain('123456');
    expect(decryptEmailPayload(encrypted, secret)).toEqual({
      to: 'buyer@example.test', subject: 'Code', text: '123456',
    });
    expect(() => decryptEmailPayload({ ...encrypted, ciphertext: 'AA' }, secret)).toThrow();
  });

  test('FR-83d: codes are keyed hashes and compare without exposing the code', () => {
    const hashed = hashCode('004291', secret);
    expect(hashed).not.toContain('004291');
    expect(equalHash(hashed, hashCode('004291', secret))).toBe(true);
    expect(equalHash(hashed, hashCode('004292', secret))).toBe(false);
  });

  test('FR-83d: resend cooldown and per-address hourly/daily caps use atomic Redis reservation', async () => {
    const redis = { isOpen: true, eval: jest.fn().mockResolvedValue(1) };
    await reserveAddressSend('Buyer@Example.test', redis);
    expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining('redis.call'), expect.objectContaining({
      keys: expect.arrayContaining([expect.stringContaining(':hour'), expect.stringContaining(':day'), expect.stringContaining(':cooldown')]),
      arguments: ['5', '10', '60', '3600', '86400'],
    }));
  });

  test('FR-83d: rejected reservation sends no code', async () => {
    const redis = { isOpen: true, eval: jest.fn().mockResolvedValue(0) };
    await expect(reserveAddressSend('buyer@example.test', redis)).rejects.toMatchObject({ statusCode: 400 });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  test('FR-83d: ten failures per configured hour set a fifteen-minute email lock', async () => {
    const redis = { isOpen: true, eval: jest.fn().mockResolvedValue(-1) };
    await expect(emailVerificationLocked('buyer@example.test', { failed: true, client: redis }))
      .resolves.toBe(true);
    expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('SET', KEYS[2]"), expect.objectContaining({
      arguments: ['10', '900', '1', '3600'],
    }));
  });
});
