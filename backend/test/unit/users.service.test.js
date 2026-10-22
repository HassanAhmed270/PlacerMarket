jest.mock('../../src/db.service', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../src/lib/passwordHashPool', () => ({ hashPassword: jest.fn(), verifyPassword: jest.fn() }));
jest.mock('../../src/lib/emailCodeDelivery', () => ({
  makeCode: jest.fn(() => '123456'),
  addressDigest: jest.fn(() => 'a'.repeat(64)),
  queueCodeEmail: jest.fn().mockResolvedValue('job'),
  queueEmail: jest.fn().mockResolvedValue('job'),
  reserveAddressSend: jest.fn().mockResolvedValue(undefined),
  emailVerificationLocked: jest.fn().mockResolvedValue(false),
  emailCodeLockedForDigest: jest.fn().mockResolvedValue(false),
  hashCode: jest.fn(() => 'b'.repeat(64)),
  equalHash: jest.fn(() => true),
}));

const db = require('../../src/db.service');
const { hashPassword } = require('../../src/lib/passwordHashPool');
const { verifyPassword } = require('../../src/lib/passwordHashPool');
const emailCode = require('../../src/lib/emailCodeDelivery');
const users = require('../../src/modules/users.service');

describe('FR-02: buyer authentication requires the email-code factor after a valid password', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.withTransaction.mockReset();
    emailCode.reserveAddressSend.mockResolvedValue(undefined);
    verifyPassword.mockResolvedValue(true);
  });

  test('FR-02, FR-83h: valid buyer password returns an internal email-factor challenge and does not issue a session', async () => {
    db.query.mockResolvedValue({ rows: [{
      id: 'user-1', email: 'buyer@example.test', password_hash: '$argon2id$stored',
      role: 'buyer', is_suspended: false,
    }] });
    const result = await users.authenticate({ email: 'buyer@example.test', password: 'valid-password' });
    expect(result).toMatchObject({ challengeRequired: true, factor: 'email', loginAttemptId: expect.any(String), userId: 'user-1', email: 'buyer@example.test' });
    expect(db.withTransaction).not.toHaveBeenCalled();
    expect(emailCode.queueCodeEmail).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('accessToken');
  });
});

describe('FR-09a / SEC-35: payout input validation and encrypted update response', () => {
  const previous = {
    id: process.env.PAYOUT_ENCRYPTION_ACTIVE_KEY_ID,
    keys: process.env.PAYOUT_ENCRYPTION_KEYS_JSON,
  };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PAYOUT_ENCRYPTION_ACTIVE_KEY_ID = 'unit-payout-key';
    process.env.PAYOUT_ENCRYPTION_KEYS_JSON = JSON.stringify({ 'unit-payout-key': Buffer.alloc(32, 19).toString('base64') });
  });
  afterAll(() => {
    if (previous.id === undefined) delete process.env.PAYOUT_ENCRYPTION_ACTIVE_KEY_ID;
    else process.env.PAYOUT_ENCRYPTION_ACTIVE_KEY_ID = previous.id;
    if (previous.keys === undefined) delete process.env.PAYOUT_ENCRYPTION_KEYS_JSON;
    else process.env.PAYOUT_ENCRYPTION_KEYS_JSON = previous.keys;
  });

  test('rejects unsupported fields and malformed method-specific values before database access', async () => {
    await expect(users.updateSellerPayoutMethod('seller-1', {
      method: 'bank_transfer', accountNumber: '12345678', stepUpGrant: 'g'.repeat(43), sessionId: 'session-1',
    })).rejects.toThrow('Payout method must be bank');
    await expect(users.updateSellerPayoutMethod('seller-1', {
      method: 'bank', bankName: 'Bank', accountTitle: 'Name', iban: 'invalid', stepUpGrant: 'g'.repeat(43), sessionId: 'session-1',
    })).rejects.toThrow('valid Pakistani IBAN');
    await expect(users.updateSellerPayoutMethod('seller-1', {
      method: 'jazzcash', walletNumber: '123', accountHolderName: 'Name', stepUpGrant: 'g'.repeat(43), sessionId: 'session-1',
    })).rejects.toThrow('valid Pakistan mobile number');
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('encrypts bank detail payload, consumes the grant and returns masked metadata only', async () => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ user_id: 'seller-1', is_approved: true, role: 'seller', email: 'seller@example.test' }] })
      .mockResolvedValueOnce({ rows: [{ enabled_at: new Date() }] })
      .mockResolvedValueOnce({ rows: [{ id: 'grant-1' }] })
      .mockResolvedValueOnce({ rows: [{ user_id: 'seller-1', payout_method: 'bank', payout_last4: '6702', payout_changed_at: new Date() }] }) };
    db.withTransaction.mockImplementation((work) => work(client));
    const result = await users.updateSellerPayoutMethod('seller-1', {
      method: 'bank', bankName: 'Test Bank', accountTitle: 'Test Seller',
      iban: 'PK36SCBL0000001123456702', stepUpGrant: 'g'.repeat(43), sessionId: 'session-1',
    });
    const storedEnvelope = client.query.mock.calls[3][1][2];
    expect(storedEnvelope).not.toContain('PK36SCBL0000001123456702');
    expect(result).toMatchObject({ sellerId: 'seller-1', method: 'bank', last4: '6702' });
    expect(JSON.stringify(result)).not.toMatch(/Test Bank|Test Seller|PK36SCBL|ciphertext|nonce|authTag/i);
    expect(emailCode.queueEmail).toHaveBeenCalledWith('seller@example.test', 'Your Poshaak payout details changed',
      expect.not.stringContaining('PK36SCBL0000001123456702'), expect.objectContaining({ transaction: client }));
  });
});

describe('FR-66 / FR-83l: seller payout disbursement eligibility', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([
    [{ id_verified: false, authenticator_enabled: true, payout_hold_active: false, payout_details_encrypted: {}, payout_needs_update: false }, 'identity verification'],
    [{ id_verified: true, authenticator_enabled: false, payout_hold_active: false, payout_details_encrypted: {}, payout_needs_update: false }, 'authenticator'],
    [{ id_verified: true, authenticator_enabled: true, payout_hold_active: true, payout_details_encrypted: {}, payout_needs_update: false }, 'paused'],
    [{ id_verified: true, authenticator_enabled: true, payout_hold_active: false, payout_details_encrypted: null, payout_needs_update: false }, 'encrypted payout details'],
    [{ id_verified: true, authenticator_enabled: true, payout_hold_active: false, payout_details_encrypted: {}, payout_needs_update: true }, 'encrypted payout details'],
  ])('blocks disbursement when a required control is missing', async (profile, reason) => {
    db.query.mockResolvedValue({ rows: [profile] });
    await expect(users.assertPayoutAllowed('seller-1')).rejects.toThrow(reason);
  });

  test('allows a verified seller with an enrolled authenticator, current encrypted details, and no hold', async () => {
    db.query.mockResolvedValue({ rows: [{ id_verified: true, authenticator_enabled: true,
      payout_hold_active: false, payout_details_encrypted: { keyId: 'test' }, payout_needs_update: false }] });
    await expect(users.assertPayoutAllowed('seller-1')).resolves.toBe(true);
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
