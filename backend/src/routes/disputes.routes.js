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

function noStore(_req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  return next();
}

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

router.post('/:id/evidence', async (req, res) => {
  res.status(201).json(await disputes.addDisputeEvidence(req.params.id, req.user.id, req.body)); // FR-43c
});

router.get('/:id/party-evidence', async (req, res) => {
  res.json(await disputes.getPartyDisputeEvidence(req.params.id, req.user.id)); // FR-43c
});

router.post('/:id/withdraw', async (req, res) => {
  res.json(await disputes.withdrawDispute(req.params.id, req.user.id, {
    clearPayoutHold: payout.clearPayoutHoldForIssue,
    hasOpenOtherPayoutIssue: chargebacks.hasOpenPayoutIssue,
  })); // FR-43
});

router.get('/', noStore, requirePermission('dispute.review'), async (req, res) => {
  const page = await disputes.getDisputeQueue(req.query, {
    getBusinessDate: sellerPayouts.getBusinessDate,
  });
  res.set('X-Next-Before', page.nextBefore || '');
  res.json(page.disputes); // FR-44, FR-56
});

router.get('/:id/evidence', noStore, requirePermission('dispute.review'), async (req, res) => {
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
