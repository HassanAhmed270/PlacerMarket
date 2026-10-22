const { Router } = require('express');
const users = require('../modules/users.service');
const { requireAuth } = require('../middleware/auth');
const { validateRegistration, validateLogin, validateLoginCode, validateStaffLogin, validateResetRequest, validatePasswordReset } = require('../lib/authValidation');
const { createConfiguredRateLimiters } = require('../middleware/rateLimit');
const { createChallengeVerifier } = require('../lib/adapters/challengeVerifier');
const { ValidationError } = require('../lib/errors');
const { parseAllowedOrigins } = require('../middleware/cors');

const limiters = createConfiguredRateLimiters();

const router = Router();
const REFRESH_COOKIE = 'poshaak_refresh';
const REFRESH_COOKIE_PATH = '/api/users/auth/refresh';

function setRefreshCookie(res, refreshToken, maxAgeSeconds) {
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true, secure: true, sameSite: 'strict', path: REFRESH_COOKIE_PATH,
    maxAge: Math.max(0, maxAgeSeconds) * 1000,
  });
  res.set('Cache-Control', 'no-store');
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true, secure: true, sameSite: 'strict', path: REFRESH_COOKIE_PATH,
  });
}

function refreshCookie(req) {
  const pair = String(req.headers.cookie || '').split(';').map((value) => value.trim())
    .find((value) => value.startsWith(`${REFRESH_COOKIE}=`));
  return pair ? pair.slice(REFRESH_COOKIE.length + 1) : null;
}

function assertRefreshOrigin(req) {
  const origin = req.get('origin');
  const allowed = parseAllowedOrigins(process.env.CORS_ORIGINS || '');
  if (!origin || !allowed.has(origin)) throw new ValidationError('Refresh origin is not allowed.');
}

function sendSession(res, session) {
  setRefreshCookie(res, session.refreshToken, session.refreshMaxAge);
  return res.status(200).json({
    accessToken: session.accessToken,
    tokenType: 'Bearer',
    expiresIn: session.accessExpiresIn,
  });
}

router.post('/register', limiters.signup, async (req, res) => {
  const input = validateRegistration(req.body); // FR-01 / SEC-16
  await users.registerUser(input); // SEC-01: only the server hashes passwords.
  try { await users.requestEmailVerification(input.email); }
  catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    // Keep duplicate registrations indistinguishable when an address is cooling down or capped.
  }
  res.status(202).json({ message: 'Registration request received.' });
});

router.post('/login', limiters.login, async (req, res) => {
  const result = await users.authenticate(validateLogin(req.body)); // FR-02 / SEC-16
  if (!result) return res.status(401).json({ error: 'Email or password is incorrect.' });
  if (result.challengeRequired) {
    if (result.factor === 'email') {
      req.challengeSignal = await limiters.emailCodeIpSignal.evaluate(req);
      if (req.challengeSignal) {
        const verifier = req.app.locals.challengeVerifier || createChallengeVerifier({
          adapter: process.env.CHALLENGE_VERIFIER_ADAPTER,
          allowFake: process.env.ALLOW_FAKE_ADAPTERS === 'true',
          production: process.env.NODE_ENV === 'production',
        });
        const verification = await verifier.verify(req.body.challengeToken);
        if (!verification?.verified) {
          return res.status(202).json({ challengeRequired: true, factor: 'email', challenge: true });
        }
      }
      await users.requestLoginEmailCode(result.loginAttemptId, result.userId, result.email);
    }
    return res.status(202).json({
      challengeRequired: true,
      factor: result.factor,
      ...(result.loginAttemptId ? { loginAttemptId: result.loginAttemptId } : {}),
    });
  }
  return res.status(401).json({ error: 'Email or password is incorrect.' });
});

router.post('/login/verify-email-code', limiters.login, async (req, res) => {
  const input = validateLoginCode(req.body);
  const session = await users.completeBuyerLogin(input.loginAttemptId, input.code, input.email);
  if (!session) return res.status(401).json({ error: 'Email or code is incorrect or expired.' });
  return sendSession(res, session);
});

router.post('/login/totp', limiters.login, async (req, res) => {
  const session = await users.authenticateStaffWithTotp(validateStaffLogin(req.body));
  if (!session) return res.status(401).json({ error: 'Email, password, or authenticator code is incorrect.' });
  return sendSession(res, session);
});

router.post('/password/forgot', limiters.reset, async (req, res) => {
  await users.requestPasswordReset(validateResetRequest(req.body).email);
  res.status(202).json({ message: 'If the address can be verified, password reset instructions will be sent.' });
});

router.post('/password/reset', limiters.reset, async (req, res) => {
  const input = validatePasswordReset(req.body);
  const reset = await users.resetPassword(input.token, input.password);
  if (!reset) return res.status(400).json({ error: 'The reset token is invalid or expired.' });
  res.status(200).json({ message: 'Password updated. Please sign in again.' });
});

router.post('/auth/refresh', async (req, res) => {
  assertRefreshOrigin(req);
  const token = refreshCookie(req);
  const session = token ? await users.refreshSession(token) : null;
  if (!session) {
    clearRefreshCookie(res);
    return res.status(401).set('Cache-Control', 'no-store').json({ error: 'Refresh session is invalid or expired.' });
  }
  return sendSession(res, session);
});

router.post('/logout', requireAuth, async (req, res) => {
  await users.revokeSessionFamily(req.user.id, req.authSessionId);
  clearRefreshCookie(res);
  res.status(204).end();
});

router.post('/email/verification/request', limiters.emailCodeIpSignal, async (req, res) => {
  if (Object.keys(req.body).some((key) => !['email', 'challengeToken'].includes(key)) ||
      typeof req.body.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.email)) {
    throw new ValidationError('A valid email address is required.');
  }
  if (req.challengeSignal) {
    const verifier = req.app.locals.challengeVerifier || createChallengeVerifier({
      adapter: process.env.CHALLENGE_VERIFIER_ADAPTER,
      allowFake: process.env.ALLOW_FAKE_ADAPTERS === 'true',
      production: process.env.NODE_ENV === 'production',
    });
    const verification = await verifier.verify(req.body.challengeToken);
    if (!verification?.verified) return res.status(202).json({ message: 'If the address can be verified, instructions will be sent.' });
  }
  await users.requestEmailVerification(req.body.email);
  res.status(202).json({ message: 'If the address can be verified, instructions will be sent.' });
});

router.post('/email/verification/confirm', async (req, res) => {
  if (Object.keys(req.body).some((key) => !['email', 'code'].includes(key))) {
    throw new ValidationError('Invalid verification request.');
  }
  const verified = await users.confirmEmailVerification(req.body.email, req.body.code);
  if (!verified) return res.status(400).json({ error: 'The verification code is invalid or expired.' });
  res.status(200).json({ message: 'Email address verified.' });
});

router.get('/cities', async (req, res) => {
  res.json(await users.listCities()); // FR-04
});

router.post('/seller-applications', requireAuth, async (req, res) => {
  res.status(201).json(await users.submitSellerApplication(req.user.id, req.body)); // FR-06
});

router.get('/me/seller-application', requireAuth, async (req, res) => {
  res.json(await users.getSellerApplicationStatus(req.user.id)); // FR-06, FR-07a
});

router.get('/me/seller-profile', requireAuth, async (req, res) => {
  res.json(await users.getSellerProfile(req.user.id)); // FR-09
});

router.patch('/me/payout-method', requireAuth, async (req, res) => {
  res.json(await users.updateSellerPayoutMethod(req.user.id, req.body)); // FR-09a
});

module.exports = router;
