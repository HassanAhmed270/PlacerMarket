const { Router } = require('express');
const reservations = require('../modules/reservations.service');
const { requireAuth } = require('../middleware/auth');

const router = Router();

function requirePaymentsEnabled(_req, res, next) {
  if (process.env.PAYMENTS_ENABLED !== '1') {
    return res.status(503).json({
      error: 'Payments are currently disabled.',
      code: 'payments_disabled',
    });
  }
  return next();
}

router.post('/:listingId/buy', requirePaymentsEnabled, requireAuth, async (req, res) => {
  const result = await reservations.buyListing(req.params.listingId, req.user.id, req.body);
  res.status(201).json(result);
});

module.exports = router;
