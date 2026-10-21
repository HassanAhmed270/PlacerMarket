const request = require('supertest');

// db.service.js constructs a pg Pool at require time but doesn't connect
// until a query actually runs — safe to require the real app here as long
// as the routes under test don't touch the DB.
const app = require('../../src/app');
const users = require('../../src/modules/users.service');
const { setSharedRedisClient } = require('../../src/lib/redis');

const smokeCounters = new Map();
setSharedRedisClient({
  isOpen: true,
  async eval(_script, { keys }) {
    return keys.map((key) => {
      const count = (smokeCounters.get(key) || 0) + 1;
      smokeCounters.set(key, count);
      return count;
    });
  },
});

describe('smoke: app boots and routes respond', () => {
  test('SEC-23: app sets Helmet security headers and CSP (no DB touch)', async () => {
    const res = await request(app).get('/api/catalog/condition-types');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(['brand_new', 'pre_owned', 'custom_made', 'replica']);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('default-src');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test('FR-01, SEC-01, SEC-16: registration rejects client password hashes and accepts only validated fields', async () => {
    const register = jest.spyOn(users, 'registerUser')
      .mockResolvedValueOnce({ id: 'new-user' }).mockResolvedValueOnce(null);
    const verification = jest.spyOn(users, 'requestEmailVerification').mockResolvedValue({ accepted: true });
    const rejected = await request(app).post('/api/users/register').send({ passwordHash: 'client-controlled' });
    expect(rejected.status).toBe(400);
    expect(register).not.toHaveBeenCalled();

    const accepted = await request(app).post('/api/users/register').send({
      name: 'Test Buyer', phone: '+14155550123', email: ' TEST@EXAMPLE.TEST ',
      password: 'long-enough-test-password', extra: 'not-forwarded',
    });
    expect(accepted.status).toBe(400);
    expect(register).not.toHaveBeenCalled();

    const valid = await request(app).post('/api/users/register').send({
      name: 'Test Buyer', phone: '+14155550123', email: ' TEST@EXAMPLE.TEST ',
      password: 'long-enough-test-password',
    });
    expect(valid.status).toBe(202);
    expect(valid.body).toEqual({ message: 'Registration request received.' });
    expect(register).toHaveBeenCalledWith({
      name: 'Test Buyer', phone: '+14155550123', email: 'test@example.test',
      password: 'long-enough-test-password', cityId: null,
    });
    expect(JSON.stringify(valid.body)).not.toContain('password_hash');
    const duplicate = await request(app).post('/api/users/register').send({
      name: 'Test Buyer', phone: '+14155550123', email: ' TEST@EXAMPLE.TEST ',
      password: 'long-enough-test-password',
    });
    expect({ status: duplicate.status, body: duplicate.body }).toEqual({ status: valid.status, body: valid.body });
    expect(register).toHaveBeenCalledTimes(2);
    expect(verification).toHaveBeenCalledTimes(2);
    register.mockRestore();
    verification.mockRestore();
  });

  test('SEC-16: login validates its boundary and does not accept extra fields', async () => {
    const authenticate = jest.spyOn(users, 'authenticate').mockResolvedValue({ token: 'unused-test-token' });
    const res = await request(app).post('/api/users/login').send({
      email: 'buyer@example.test', password: 'long-enough-test-password', role: 'admin',
    });
    expect(res.status).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
    authenticate.mockRestore();
  });

  test('SEC-25: rejects JSON bodies larger than the explicit one-megabyte limit', async () => {
    const res = await request(app).post('/api/users/register').send({ data: 'x'.repeat(1024 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Request body too large' });
  });

  test('POST /api/listings without auth returns 401 (requireAuth middleware)', async () => {
    const res = await request(app).post('/api/listings').send({});
    expect(res.status).toBe(401);
  });

  test('a POST with no body still gives handlers an empty req.body (Express 5 leaves it undefined)', async () => {
    app.post('/__probe', (req, res) => res.json({ reason: req.body.reason ?? null }));
    const res = await request(app).post('/__probe');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reason: null });
  });

  test('a rejected async handler (no wrapper) reaches the error handler with its status', async () => {
    const { NotFoundError } = require('../../src/lib/errors');
    app.get('/__boom', async () => { throw new NotFoundError('order', 'x'); });
    const res = await request(app).get('/__boom');
    expect(res.status).toBe(404);
  });

  test('unknown route falls through to Express 404, not a crash', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
  });
});
