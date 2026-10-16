const { Router } = require('express');
const admin = require('../modules/admin.service');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = Router();
router.use(requireAuth);
// Permission checks live HERE, per route (rules.md Section 5) — admin.service.js
// does not check roles. Every route below must carry its own requirePermission();
// test/unit/admin.routes.permissions.test.js fails if one is missing.

router.post('/users/:id/suspend', requirePermission('user.suspend'), async (req, res) => {
  res.json(await admin.suspendUser(req.params.id, { adminId: req.user.id, reason: req.body.reason })); // FR-52
});

router.post(
  '/seller-applications/:id/review',
  requirePermission((req) => (req.body.decision === 'approved' ? 'seller_application.approve' : 'seller_application.reject')),
  async (req, res) => {
    res.json(await admin.reviewSellerApplication(req.params.id, { ...req.body, reviewerId: req.user.id })); // FR-53
  }
);

router.post('/listings/:id/approve', requirePermission('listing.approve'), async (req, res) => {
  res.json(await admin.approveListing(req.params.id, req.user.id)); // FR-54
});

router.post('/listings/:id/reject', requirePermission('listing.reject'), async (req, res) => {
  res.json(await admin.rejectListing(req.params.id, { reviewerId: req.user.id, reason: req.body.reason })); // FR-54
});

router.post('/listings/:id/verified-badge', requirePermission('listing.grant_verified_badge'), async (req, res) => {
  res.json(await admin.grantVerifiedBadge(req.params.id, { granted: req.body.granted, reviewerId: req.user.id })); // FR-54
});

router.get('/operations-overview', requirePermission('operations.view'), async (req, res) => {
  res.json(await admin.getOperationsOverview()); // FR-55
});

router.post('/disputes/:id/resolve', requirePermission('dispute.resolve'), async (req, res) => {
  res.json(await admin.resolveDispute(req.params.id, { ...req.body, resolvedBy: req.user.id })); // FR-56
});

router.post('/delivery-partners', requirePermission('delivery_partner.configure'), async (req, res) => {
  res.json(await admin.manageDeliveryPartner('create', req.body, req.user.id)); // FR-57
});

router.patch('/fees/commission', requirePermission('fee.configure'), async (req, res) => {
  res.json(await admin.configureFees(req.body.percent, req.user.id)); // FR-58
});

router.get('/advertising-overview', requirePermission('advertising.manage'), async (req, res) => {
  res.json(await admin.getAdvertisingOverview()); // FR-59, deferred stub
});

module.exports = router;
