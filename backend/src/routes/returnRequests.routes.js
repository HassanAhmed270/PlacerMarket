const { Router } = require('express');
const returnRequests = require('../modules/returnRequests.service');
const disputes = require('../modules/disputes.service');
const { requireAuth } = require('../middleware/auth');
const { createConfiguredRateLimiters } = require('../middleware/rateLimit');

const router = Router();
const limiters = createConfiguredRateLimiters();

function noStore(_req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  return next();
}

router.use(requireAuth, noStore);

router.post('/orders/:orderId', limiters.payments, async (req, res) => {
  res.status(201).json(await returnRequests.fileReturnRequest(
    req.params.orderId,
    req.user.id,
    req.body,
    { hasOpenDispute: disputes.hasOpenDisputeInTransaction }
  )); // FR-43
});

router.post('/:returnId/respond', limiters.payments, async (req, res) => {
  res.json(await returnRequests.respondToReturnRequest(
    req.params.returnId,
    req.user.id,
    req.body
  )); // FR-43
});

module.exports = router;
