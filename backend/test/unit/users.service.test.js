jest.mock('../../src/db.service', () => ({ query: jest.fn() }));
jest.mock('../../src/lib/passwordHashPool', () => ({ hashPassword: jest.fn() }));

const db = require('../../src/db.service');
const { hashPassword } = require('../../src/lib/passwordHashPool');
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
