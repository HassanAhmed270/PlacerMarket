const { Router } = require('express');
const delivery = require('../modules/delivery.service');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = Router();

router.get('/partners', async (req, res) => {
  res.json(await delivery.listDeliveryPartners()); // FR-40
});

router.post('/partners', requirePermission('delivery_partner.configure'), async (req, res) => {
  res.status(201).json(await delivery.createDeliveryPartner(req.body, req.user.id)); // FR-40a
});

router.patch('/partners/:id/active', requirePermission('delivery_partner.configure'), async (req, res) => {
  res.json(await delivery.setDeliveryPartnerActive(req.params.id, req.body.isActive, req.user.id));
});

// FR-41: MANUAL status entry by ops staff.
router.post('/orders/:id/status', requireAuth, async (req, res) => {
  res.status(201).json(await delivery.logDeliveryStatus(req.params.id, { ...req.body, enteredBy: req.user.id }));
});

router.get('/orders/:id/tracking', requireAuth, async (req, res) => {
  res.json(await delivery.getDeliveryTracking(req.params.id)); // FR-42
});

module.exports = router;
