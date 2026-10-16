const { Router } = require('express');
const settlement = require('../modules/settlement.service');
const { requirePermission } = require('../middleware/auth');

const router = Router();

router.get('/orders/:id', requirePermission('user.suspend'), async (req, res) => {
  // Admin-only stand-in gate again (see payout.routes.js note) — settlement
  // records are financial, should not be Moderator-visible without an
  // explicit decision to include them in FR-05a's Moderator scope.
  const record = await settlement.getSettlementRecord(req.params.id); // FR-49
  if (!record) return res.status(404).json({ error: 'No settlement record for this order yet' });
  res.json(record);
});

router.post('/orders/:id/initiate-payout', requirePermission('user.suspend'), async (req, res) => {
  res.json(await settlement.initiateSellerPayout(req.params.id, req.user.id)); // FR-48
});

router.patch('/commission', requirePermission('fee.configure'), async (req, res) => {
  res.json(await settlement.adjustCommissionPercent(req.body.percent, req.user.id)); // FR-50, Admin-only
});

module.exports = router;
