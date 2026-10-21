jest.mock('../../src/db.service', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../src/lib/passwordHashPool', () => ({ hashPassword: jest.fn() }));
jest.mock('../../src/lib/emailCodeDelivery', () => ({
  makeCode: jest.fn(() => '123456'),
  addressDigest: jest.fn(() => 'a'.repeat(64)),
  queueCodeEmail: jest.fn().mockResolvedValue('job'),
  reserveAddressSend: jest.fn().mockResolvedValue(undefined),
  emailVerificationLocked: jest.fn().mockResolvedValue(false),
  emailCodeLockedForDigest: jest.fn().mockResolvedValue(false),
  hashCode: jest.fn(() => 'b'.repeat(64)),
  equalHash: jest.fn(() => true),
}));

const db = require('../../src/db.service');
const { hashPassword } = require('../../src/lib/passwordHashPool');
const emailCode = require('../../src/lib/emailCodeDelivery');
const users = require('../../src/modules/users.service');

describe('users service incomplete authentication message', () => {
  test('does not duplicate the not-implemented suffix', async () => {
    await expect(users.authenticate({ email: 'seller@example.test', password: 'placeholder' }))
      .rejects.toThrow('authenticate() — required session and 2FA persistence is not implemented yet');
  });
});

describe('FR-01, SEC-01: server-side password hashing at registration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hashPassword.mockResolvedValue('$argon2id$server-generated-hash');
  });

  test('hashes the password before insertion and never returns password_hash', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'user-1', full_name: 'Test', role: 'buyer' }] });
    const user = await users.registerUser({
      name: 'Test', phone: '+14155550123', email: 'test@example.test',
      password: 'long-enough-test-password', cityId: null,
    });
    expect(hashPassword).toHaveBeenCalledWith('long-enough-test-password');
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT DO NOTHING'), [
      'Test', '+14155550123', 'test@example.test', '$argon2id$server-generated-hash', null,
    ]);
    expect(user).not.toHaveProperty('password_hash');
  });

  test('duplicate registration follows the uniform empty-insert path', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await expect(users.registerUser({
      name: 'Test', phone: '+14155550123', email: 'test@example.test',
      password: 'long-enough-test-password', cityId: null,
    })).resolves.toBeNull();
    expect(hashPassword).toHaveBeenCalledTimes(1);
  });
});

describe('FR-83d: email verification is anti-enumerating and queue-backed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.withTransaction.mockReset();
    emailCode.emailVerificationLocked.mockResolvedValue(false);
    emailCode.emailCodeLockedForDigest.mockResolvedValue(false);
    emailCode.equalHash.mockReturnValue(true);
  });

  test('FR-83d: unknown email gets the same accepted result and queued message type', async () => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }) };
    db.withTransaction.mockImplementation((work) => work(client));
    await expect(users.requestEmailVerification('UNKNOWN@Example.test')).resolves.toEqual({ accepted: true });
    expect(emailCode.reserveAddressSend).toHaveBeenCalledWith('unknown@example.test');
    expect(client.query.mock.calls[2][1][1]).toBeNull();
    expect(emailCode.queueCodeEmail).toHaveBeenCalledWith('unknown@example.test', '123456', expect.objectContaining({ transaction: client }));
  });

  test('FR-83d: known email receives an address-bound hashed code without returning it', async () => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }) };
    db.withTransaction.mockImplementation((work) => work(client));
    await expect(users.requestEmailVerification('buyer@example.test')).resolves.toEqual({ accepted: true });
    expect(client.query.mock.calls[2][1][1]).toBe('user-1');
    expect(client.query.mock.calls[2][1][3]).toBe('b'.repeat(64));
    expect(JSON.stringify(emailCode.queueCodeEmail.mock.calls[0])).not.toContain('code_hash');
  });

  test('FR-83d: the third wrong code attempt consumes that code and records an hourly failure', async () => {
    emailCode.equalHash.mockReturnValue(false);
    const client = { query: jest.fn().mockResolvedValueOnce({ rows: [{
      id: 'code-row', user_id: 'user-1', code_hash: 'b'.repeat(64), attempts_used: 2,
      expires_at: new Date(Date.now() + 60_000),
    }] }).mockResolvedValueOnce({ rows: [] }) };
    db.withTransaction.mockImplementation((work) => work(client));
    await expect(users.confirmEmailVerification('buyer@example.test', '123456')).resolves.toBe(false);
    expect(client.query.mock.calls[1][0]).toContain('consumed_at = CASE WHEN');
    expect(client.query.mock.calls[1][1]).toEqual([3, 3, 'code-row']);
    expect(emailCode.emailVerificationLocked).toHaveBeenCalledWith('buyer@example.test', { failed: true });
  });

  test('FR-83d: locked email addresses are checked without querying or disclosing account state', async () => {
    emailCode.emailVerificationLocked.mockResolvedValue(true);
    await expect(users.confirmEmailVerification('buyer@example.test', '123456')).resolves.toBe(false);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('FR-83d: login-factor code persistence includes the specific attempt UUID', async () => {
    const attemptId = '56c323e3-a55a-4edb-8e12-a8db18d197d0';
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }) };
    db.withTransaction.mockImplementation((work) => work(client));
    await expect(users.requestLoginEmailCode(attemptId, 'user-1', 'buyer@example.test'))
      .resolves.toEqual({ accepted: true });
    expect(client.query.mock.calls[2][1]).toEqual([
      attemptId, 'user-1', 'a'.repeat(64), 'b'.repeat(64), 300,
    ]);
  });
});
