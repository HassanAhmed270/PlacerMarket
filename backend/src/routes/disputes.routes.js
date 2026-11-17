const { Router } = require('express');
const disputes = require('../modules/disputes.service');
const payout = require('../modules/payout.service');
const sellerPayouts = require('../modules/sellerPayouts.service');
const returnRequests = require('../modules/returnRequests.service');
const chargebacks = require('../modules/chargebacks.service');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { createConfiguredRateLimiters } = require('../middleware/rateLimit');

const router = Router();
const limiters = createConfiguredRateLimiters();
router.use(requireAuth);

router.post('/orders/:id', async (req, res) => {
  res.status(201).json(await disputes.fileDispute(req.params.id, req.user.id, req.body, {
    getOrderPayoutStatus: sellerPayouts.getOrderPayoutStatus,
    pausePayoutHold: payout.pausePayoutHoldForDispute,
    hasOpenReturnRequest: returnRequests.hasOpenReturnRequest,
  })); // FR-43
});

router.post('/:id/counter-evidence', async (req, res) => {
  res.json(await disputes.submitCounterEvidence(req.params.id, req.user.id, req.body)); // FR-43c
});

router.get('/', requirePermission('dispute.review'), async (req, res) => {
  res.json(await disputes.getDisputeQueue(req.query)); // FR-44
});

router.get('/:id/evidence', requirePermission('dispute.review'), async (req, res) => {
  res.json(await disputes.getDisputeEvidence(req.params.id));
});

router.post('/:id/resolve', requirePermission('dispute.resolve'), limiters.adminOps, async (req, res) => {
  res.json(await disputes.resolveDispute(req.params.id, {
    ...req.body,
    resolvedBy: req.user.id,
    sessionId: req.authSessionId,
  }, {
    failInitiatedPayoutForDispute: sellerPayouts.failInitiatedPayoutForDispute,
    hasOpenOtherPayoutIssue: chargebacks.hasOpenPayoutIssue,
  })); // FR-45
});

module.exports = router;
