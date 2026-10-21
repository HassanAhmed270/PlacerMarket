jest.mock('../../src/middleware/rateLimit', () => ({
  createConfiguredRateLimiters: () => {
    const pass = (_req, _res, next) => { next(); };
    return { login: pass, signup: pass, reset: pass, offer: pass, message: pass, emailCodeIpSignal: pass };
  },
}));

const express = require('express');
const request = require('supertest');
const users = require('../../src/modules/users.service');
const usersRoutes = require('../../src/routes/users.routes');

const app = express();
app.use(express.json());
app.use('/users', usersRoutes);
app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));

describe('FR-83d, SEC-16: email verification route boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(users, 'requestEmailVerification').mockResolvedValue({ accepted: true });
    jest.spyOn(users, 'confirmEmailVerification').mockResolvedValue(false);
  });

  test('FR-83d: verification request uses the same anti-enumeration response', async () => {
    const result = await request(app).post('/users/email/verification/request').send({ email: 'Buyer@Example.test' });
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ message: 'If the address can be verified, instructions will be sent.' });
    expect(users.requestEmailVerification).toHaveBeenCalledWith('Buyer@Example.test');
  });

  test('SEC-16: verification endpoints reject unknown fields and malformed emails', async () => {
    await request(app).post('/users/email/verification/request')
      .send({ email: 'buyer@example.test', password: 'leak' }).expect(400);
    await request(app).post('/users/email/verification/request')
      .send({ email: 'not-an-email' }).expect(400);
    await request(app).post('/users/email/verification/confirm')
      .send({ email: 'buyer@example.test', code: '123456', extra: true }).expect(400);
    expect(users.requestEmailVerification).not.toHaveBeenCalled();
  });

  test('FR-83d: invalid and expired email codes share one generic response', async () => {
    const result = await request(app).post('/users/email/verification/confirm')
      .send({ email: 'buyer@example.test', code: '000001' });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'The verification code is invalid or expired.' });
    expect(users.confirmEmailVerification).toHaveBeenCalledWith('buyer@example.test', '000001');
  });
});
