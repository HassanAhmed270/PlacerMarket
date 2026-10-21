const { Router } = require('express');
const users = require('../modules/users.service');
const { requireAuth } = require('../middleware/auth');
const { validateRegistration, validateLogin } = require('../lib/authValidation');
const { createConfiguredRateLimiters } = require('../middleware/rateLimit');

const limiters = createConfiguredRateLimiters();

const router = Router();

router.post('/register', limiters.signup, async (req, res) => {
  const input = validateRegistration(req.body); // FR-01 / SEC-16
  await users.registerUser(input); // SEC-01: only the server hashes passwords.
  res.status(202).json({ message: 'Registration request received.' });
});

router.post('/login', limiters.login, async (req, res) => {
  res.json(await users.authenticate(validateLogin(req.body))); // FR-02 / SEC-16
});

router.get('/cities', async (req, res) => {
  res.json(await users.listCities()); // FR-04
});

router.post('/seller-applications', requireAuth, async (req, res) => {
  res.status(201).json(await users.submitSellerApplication(req.user.id, req.body)); // FR-06
});

router.get('/me/seller-profile', requireAuth, async (req, res) => {
  res.json(await users.getSellerProfile(req.user.id)); // FR-09
});

router.patch('/me/payout-method', requireAuth, async (req, res) => {
  res.json(await users.updateSellerPayoutMethod(req.user.id, req.body)); // FR-09a
});

module.exports = router;
