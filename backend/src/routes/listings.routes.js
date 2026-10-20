const { Router } = require('express');
const listings = require('../modules/listings.service');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = Router();

router.post('/', requireAuth, async (req, res) => {
  res.status(201).json(await listings.createListing(req.user.id, req.body)); // FR-15
});

router.post('/:id/images', requireAuth, async (req, res) => {
  await listings.addListingImages(req.params.id, req.user.id, req.body.imageUrls); // FR-16
  res.status(204).end();
});

router.post('/:id/submit', requireAuth, async (req, res) => {
  res.json(await listings.submitListingForReview(req.params.id, req.user.id)); // FR-19
});

router.post('/:id/evidence', requireAuth, async (req, res) => {
  await listings.submitAuthenticityEvidence(req.params.id, req.user.id, req.body.evidenceUrls); // FR-17
  res.status(204).end();
});

router.patch('/:id', requireAuth, async (req, res) => {
  res.json(await listings.updateOwnListing(req.params.id, req.user.id, req.body)); // FR-20
});

router.post('/:id/resubmit', requireAuth, async (req, res) => {
  res.json(await listings.resubmitListing(req.params.id, req.user.id)); // FR-21a
});

// Moderation endpoints — mounted here for locality but gated by the
// 'listing.*' permissions from lib/roles.js (Admin + Moderator/Ops, FR-05a).
router.get('/moderation-queue', requirePermission('listing.review'), async (req, res) => {
  res.json(await listings.getModerationQueue()); // FR-19
});

router.post('/:id/approve', requirePermission('listing.approve'), async (req, res) => {
  res.json(await listings.approveListing(req.params.id, req.user.id)); // FR-19a
});

router.post('/:id/reject', requirePermission('listing.reject'), async (req, res) => {
  res.json(await listings.rejectOrUnpublishListing(req.params.id, { reviewerId: req.user.id, reason: req.body.reason })); // FR-21
});

router.post('/:id/verified-badge', requirePermission('listing.grant_verified_badge'), async (req, res) => {
  res.json(await listings.setVerifiedBadge(req.params.id, { granted: req.body.granted, reviewerId: req.user.id })); // FR-18
});

module.exports = router;
