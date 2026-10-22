jest.mock('../../src/modules/users.service', () => ({
  getAuthenticationPrincipal: jest.fn(),
}));

const users = require('../../src/modules/users.service');
const { requireAuth } = require('../../src/middleware/auth');
const { signAccessToken } = require('../../src/lib/jwt');
const userId = '8406f3cf-7aa7-4a71-9f4a-c9ecda3b2a14';
const secret = 'auth-test-only-secret-with-at-least-32-bytes';

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

describe('FR-10, FR-84, SEC-07: bearer authentication uses current user state', () => {
  const previousSecret = process.env.JWT_ACCESS_SECRET;
  beforeEach(() => {
    process.env.JWT_ACCESS_SECRET = secret;
    users.getAuthenticationPrincipal.mockReset();
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = previousSecret;
  });

  test('FR-84: rejects missing bearer tokens without reading a user row', async () => {
    const res = response();
    await requireAuth({ get: () => undefined, requestId: 'request-1' }, res, jest.fn());
    expect(res.statusCode).toBe(401);
    expect(users.getAuthenticationPrincipal).not.toHaveBeenCalled();
  });

  test('SEC-07: rejects a valid unexpired token when the user is currently suspended', async () => {
    users.getAuthenticationPrincipal.mockResolvedValue({ id: userId, role: 'seller', is_suspended: true });
    const res = response();
    const next = jest.fn();
    await requireAuth({ get: (name) => name === 'authorization' ? `Bearer ${signAccessToken(userId, { secret })}` : undefined, requestId: 'request-2' }, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(users.getAuthenticationPrincipal).toHaveBeenCalledWith(userId);
  });

  test('FR-84: sets the current role from the database after validating the bearer token', async () => {
    users.getAuthenticationPrincipal.mockResolvedValue({ id: userId, role: 'admin', is_suspended: false });
    const req = { get: (name) => name === 'authorization' ? `Bearer ${signAccessToken(userId, { secret })}` : undefined };
    const next = jest.fn();
    await requireAuth(req, response(), next);
    expect(req.user).toEqual({ id: userId, role: 'admin' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('FR-83c: a seller enrollment-only session can reach setup but no other protected route', async () => {
    users.getAuthenticationPrincipal.mockResolvedValue({
      id: userId, role: 'seller', is_suspended: false, enrollment_only: true,
    });
    const token = signAccessToken(userId, { secret, sessionId: '2147b9fc-9971-46ce-9f29-c55471c48345' });
    const blocked = response();
    const blockedNext = jest.fn();
    await requireAuth({
      get: (name) => name === 'authorization' ? `Bearer ${token}` : undefined,
      originalUrl: '/api/users/me/seller-profile', method: 'GET',
    }, blocked, blockedNext);
    expect(blocked.statusCode).toBe(403);
    expect(blockedNext).not.toHaveBeenCalled();

    const allowedNext = jest.fn();
    await requireAuth({
      get: (name) => name === 'authorization' ? `Bearer ${token}` : undefined,
      originalUrl: '/api/users/me/authenticator/enroll', method: 'POST',
    }, response(), allowedNext);
    expect(allowedNext).toHaveBeenCalledTimes(1);
  });

  test('FR-84: ignores cookie tokens and rejects invalid bearer tokens', async () => {
    const res = response();
    await requireAuth({ get: (name) => name === 'cookie' ? `access=${signAccessToken(userId, { secret })}` : undefined }, res, jest.fn());
    expect(res.statusCode).toBe(401);
    const invalid = response();
    await requireAuth({ get: (name) => name === 'authorization' ? 'Bearer invalid' : undefined }, invalid, jest.fn());
    expect(invalid.statusCode).toBe(401);
    expect(users.getAuthenticationPrincipal).not.toHaveBeenCalled();
  });
});
