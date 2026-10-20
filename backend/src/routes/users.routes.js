const { Router } = require('express');
const users = require('../modules/users.service');
const { requireAuth } = require('../middleware/auth');
const { NotImplementedError } = require('../lib/errors');

const router = Router();

router.post('/register', async (req, res) => {
  // FR-01 / SEC-01: keep registration closed until the approved Argon2id
  // implementation and the remaining FR-84b/auth-persistence requirements are in place.
  throw new NotImplementedError('FR-01 registration pending server-side password hashing');
});

router.post('/login', async (req, res) => {
  res.json(await users.authenticate(req.body)); // FR-02
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
