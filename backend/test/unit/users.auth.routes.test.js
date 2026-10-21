jest.mock('../../src/middleware/rateLimit', () => ({
  createConfiguredRateLimiters: () => {
    const pass = (_req, _res, next) => { next(); };
    return { login: pass, signup: pass, reset: pass, offer: pass, message: pass, emailCodeIpSignal: Object.assign(pass, { evaluate: jest.fn().mockResolvedValue(false) }) };
  },
}));

const express = require('express');
const request = require('supertest');
const users = require('../../src/modules/users.service');
const { signAccessToken } = require('../../src/lib/jwt');
const usersRoutes = require('../../src/routes/users.routes');

const app = express();
app.use(express.json());
app.use('/api/users', usersRoutes);
app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));

const secret = 'auth-route-test-secret-material-that-is-longer-than-32-bytes';
const userId = '30d35349-8c53-4e44-8235-dbb0a4a5f873';
const sessionId = '2147b9fc-9971-46ce-9f29-c55471c48345';
const session = {
  accessToken: 'test-access-token', refreshToken: 'r'.repeat(43),
  refreshMaxAge: 600, accessExpiresIn: 900,
};

describe('FR-84: login and refresh tokens use the approved transport boundaries', () => {
  beforeEach(() => {
    process.env.JWT_ACCESS_SECRET = secret;
    process.env.CORS_ORIGINS = 'https://poshaak.test';
    jest.spyOn(users, 'authenticate').mockResolvedValue({ challengeRequired: true, factor: 'email', loginAttemptId: sessionId, userId, email: 'buyer@example.test' });
    jest.spyOn(users, 'requestLoginEmailCode').mockResolvedValue({ accepted: true });
    jest.spyOn(users, 'requestPasswordReset').mockResolvedValue({ accepted: true });
    jest.spyOn(users, 'resetPassword').mockResolvedValue(true);
    jest.spyOn(users, 'completeBuyerLogin').mockResolvedValue(session);
    jest.spyOn(users, 'authenticateStaffWithTotp').mockResolvedValue(session);
    jest.spyOn(users, 'refreshSession').mockResolvedValue(session);
    jest.spyOn(users, 'revokeSessionFamily').mockResolvedValue(undefined);
    jest.spyOn(users, 'getAuthenticationPrincipal').mockResolvedValue({ id: userId, role: 'buyer', is_suspended: false });
  });

  afterEach(() => jest.restoreAllMocks());

  test('FR-02, FR-83h: buyer password starts email second-factor challenge without issuing a token', async () => {
    const response = await request(app).post('/api/users/login')
      .send({ email: 'buyer@example.test', password: 'long-enough-test-password' });
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ challengeRequired: true, factor: 'email', loginAttemptId: sessionId });
    expect(response.body).not.toHaveProperty('accessToken');
    expect(users.requestLoginEmailCode).toHaveBeenCalledWith(sessionId, userId, 'buyer@example.test');
  });

  test('FR-84, SEC-04/05: refresh requires an allowlisted Origin and a scoped secure cookie', async () => {
    const blocked = await request(app).post('/api/users/auth/refresh').set('Cookie', `poshaak_refresh=${session.refreshToken}`);
    expect(blocked.status).toBe(400);
    expect(users.refreshSession).not.toHaveBeenCalled();

    const rotated = await request(app).post('/api/users/auth/refresh')
      .set('Origin', 'https://poshaak.test')
      .set('Cookie', `poshaak_refresh=${session.refreshToken}`);
    expect(rotated.status).toBe(200);
    expect(rotated.body).toEqual({ accessToken: session.accessToken, tokenType: 'Bearer', expiresIn: 900 });
    expect(rotated.headers['set-cookie'][0]).toContain('HttpOnly; Secure; SameSite=Strict');
    expect(rotated.headers['set-cookie'][0]).toContain('Path=/api/users/auth/refresh');
    expect(rotated.headers['cache-control']).toBe('no-store');
    expect(users.refreshSession).toHaveBeenCalledWith(session.refreshToken);
  });

  test('FR-84: logout uses the bearer session and revokes its family', async () => {
    const token = signAccessToken(userId, { secret, sessionId });
    const response = await request(app).post('/api/users/logout').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(204);
    expect(users.revokeSessionFamily).toHaveBeenCalledWith(userId, sessionId);
    expect(response.headers['set-cookie'][0]).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  });

  test('FR-83g, SEC-16: forgot-password validates its body and always returns the uniform accepted response', async () => {
    const invalid = await request(app).post('/api/users/password/forgot').send({ email: 'buyer@example.test', userId });
    expect(invalid.status).toBe(400);
    const accepted = await request(app).post('/api/users/password/forgot').send({ email: 'buyer@example.test' });
    expect(accepted.status).toBe(202);
    expect(accepted.body).toEqual({ message: 'If the address can be verified, password reset instructions will be sent.' });
    expect(users.requestPasswordReset).toHaveBeenCalledWith('buyer@example.test');
  });

  test('FR-83g, SEC-16: reset-password accepts only a bounded token and validated password', async () => {
    const rejected = await request(app).post('/api/users/password/reset')
      .send({ token: 't'.repeat(43), password: 'replacement-password-2026', role: 'admin' });
    expect(rejected.status).toBe(400);
    const accepted = await request(app).post('/api/users/password/reset')
      .send({ token: 't'.repeat(43), password: 'replacement-password-2026' });
    expect(accepted.status).toBe(200);
    expect(users.resetPassword).toHaveBeenCalledWith('t'.repeat(43), 'replacement-password-2026');
  });
});
