const { Router } = require('express');
const delivery = require('../modules/delivery.service');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { hasPermission } = require('../lib/roles');
const { ValidationError } = require('../lib/errors');
const { createConfiguredRateLimiters } = require('../middleware/rateLimit');

const router = Router();
const adminRouter = Router();
const limiters = createConfiguredRateLimiters();

function noStore(_req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  return next();
}

router.get('/partners', async (req, res) => {
  res.json(await delivery.listDeliveryPartners()); // FR-40
});

router.post('/partners', requirePermission('delivery_partner.configure'), async (req, res) => {
  res.status(201).json(await delivery.createDeliveryPartner(req.body, req.user.id)); // FR-40a
});

router.patch('/partners/:id/active', requirePermission('delivery_partner.configure'), async (req, res) => {
  res.json(await delivery.setDeliveryPartnerActive(req.params.id, req.body.isActive, req.user.id));
});

// FR-41: legacy manual status entry is Admin-only.
router.post('/orders/:id/status', requireAuth, requirePermission('order.log_delivery_status'), async (req, res) => {
  res.status(201).json(await delivery.logDeliveryStatus(req.params.id, { ...req.body, enteredBy: req.user.id }));
});

router.get('/orders/:id/tracking', requireAuth, noStore, async (req, res) => {
  const canViewAll = hasPermission(req.user.role, 'order.mark_handover');
  res.json(await delivery.getDeliveryTracking(req.params.id, req.user.id, canViewAll)); // FR-42
});

adminRouter.patch('/orders/:orderId/delivery', noStore, requirePermission('order.mark_handover'), limiters.adminOps, async (req, res) => {
  res.json(await delivery.recordAdminHandover(req.params.orderId, req.body, req.user.id)); // FR-72
});

adminRouter.post('/orders/:orderId/delivered', noStore, requirePermission('order.mark_delivered'), limiters.adminOps, async (req, res) => {
  res.json(await delivery.markOrderDelivered(req.params.orderId, req.body, req.user.id)); // FR-68
});

adminRouter.get('/order-exceptions', noStore, requirePermission('order.mark_handover'), limiters.adminOps, async (req, res) => {
  res.json(await delivery.listOrderExceptions(req.query)); // FR-72e
});

adminRouter.post(
  '/order-exceptions/:exceptionId/resolve',
  noStore,
  requirePermission('order.resolve_exception'),
  limiters.adminOps,
  async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
        Object.keys(req.body).some((key) => key !== 'resolutionNote')) {
      throw new ValidationError('Only resolutionNote is accepted.');
    }
    res.json(await delivery.resolveOrderException(req.params.exceptionId, {
      resolvedBy: req.user.id,
      resolutionNote: req.body.resolutionNote,
    })); // FR-72e
  }
);

module.exports = router;
module.exports.adminRouter = adminRouter;
