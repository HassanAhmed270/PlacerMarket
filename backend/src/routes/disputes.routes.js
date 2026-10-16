const { Router } = require('express');
const disputes = require('../modules/disputes.service');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = Router();
router.use(requireAuth);

router.post('/orders/:id', async (req, res) => {
  res.status(201).json(await disputes.fileDispute(req.params.id, req.user.id, req.body)); // FR-43
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

router.post('/:id/resolve', requirePermission('dispute.resolve'), async (req, res) => {
  // FR-45a guard lives inside disputes.service.resolveDispute() — will
  // throw NotYetSpecifiedError(501) on any partial-refund attempt.
  res.json(await disputes.resolveDispute(req.params.id, { ...req.body, resolvedBy: req.user.id })); // FR-45
});

module.exports = router;
