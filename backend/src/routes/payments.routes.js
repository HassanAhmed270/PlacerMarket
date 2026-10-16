const { Router } = require('express');
const payments = require('../modules/payments.service');
const { requireAuth } = require('../middleware/auth');

const router = Router();
router.use(requireAuth); // ops/courier-facing, not public

router.get('/orders/:id/expected-amount', async (req, res) => {
  res.json(await payments.getExpectedCollectionAmount(req.params.id)); // FR-37
});

router.post('/orders/:id/confirm-collection', async (req, res) => {
  res.json(await payments.confirmCodCollection(req.params.id, { ...req.body, collectedBy: req.user.id })); // FR-38
});

router.post('/orders/:id/reconcile', async (req, res) => {
  res.json(await payments.reconcileCashRemittance(req.params.id, { reconciledBy: req.user.id, note: req.body.note })); // FR-41a
});

module.exports = router;
