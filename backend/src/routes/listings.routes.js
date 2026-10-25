const { Router } = require('express');
const listings = require('../modules/listings.service');
const listingRevisions = require('../modules/listingRevisions.service');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = Router();

router.post('/seo-recommendation', requireAuth, async (req, res) => {
  res.json(await listings.getSeoRecommendation(req.user.id, req.body)); // FR-82
});

router.post('/', requireAuth, async (req, res) => {
  res.status(201).json(await listings.createListing(req.user.id, req.body)); // FR-15
});

router.get('/mine', requireAuth, async (req, res) => {
  res.json(await listings.getOwnListings(req.user.id)); // FR-20
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

router.post('/:id/pause', requireAuth, async (req, res) => {
  res.json(await listings.setOwnListingPaused(req.params.id, req.user.id, true)); // FR-20
});

router.post('/:id/resume', requireAuth, async (req, res) => {
  res.json(await listings.setOwnListingPaused(req.params.id, req.user.id, false)); // FR-20
});

router.post('/:id/remove', requireAuth, async (req, res) => {
  res.json(await listings.removeOwnListing(req.params.id, req.user.id)); // FR-20
});

router.post('/:id/resubmit', requireAuth, async (req, res) => {
  res.json(await listings.resubmitListing(req.params.id, req.user.id)); // FR-21a
});

router.post('/:id/revisions', requireAuth, async (req, res) => {
  res.status(201).json(await listingRevisions.submitListingRevision(req.params.id, req.user.id, req.body)); // FR-73
});

router.get('/:id/revisions', requireAuth, async (req, res) => {
  res.json(await listingRevisions.getSellerRevisionHistory(req.params.id, req.user.id)); // FR-73
});

router.post('/revisions/:revisionId/withdraw', requireAuth, async (req, res) => {
  res.json(await listingRevisions.withdrawListingRevision(req.params.revisionId, req.user.id)); // FR-73
});

// Moderation endpoints — mounted here for locality but gated by the
// 'listing.*' permissions from lib/roles.js (Admin + Moderator/Ops, FR-05a).
router.get('/moderation-queue', requireAuth, requirePermission('listing.review'), async (req, res) => {
  res.json(await listings.getModerationQueue()); // FR-19
});

router.get('/revision-moderation-queue', requireAuth, requirePermission('listing.review'), async (_req, res) => {
  res.json(await listingRevisions.getListingRevisionQueue()); // FR-73
});

router.get('/revisions/:revisionId', requireAuth, requirePermission('listing.review'), async (req, res) => {
  res.json(await listingRevisions.getListingRevision(req.params.revisionId)); // FR-73
});

router.post('/revisions/:revisionId/approve', requireAuth, requirePermission('listing.approve'), async (req, res) => {
  res.json(await listingRevisions.approveListingRevision(req.params.revisionId, req.user.id)); // FR-73
});

router.post('/revisions/:revisionId/reject', requireAuth, requirePermission('listing.reject'), async (req, res) => {
  res.json(await listingRevisions.rejectListingRevision(req.params.revisionId, req.user.id, req.body.reason)); // FR-73
});

router.post('/photos/:imageId/confirm', requireAuth, requirePermission('listing.review'), async (req, res) => {
  res.json(await listings.confirmListingPhoto(req.params.imageId, req.user.id)); // FR-74a
});

router.post('/photos/:imageId/reject', requireAuth, requirePermission('listing.review'), async (req, res) => {
  res.json(await listings.rejectListingPhoto(req.params.imageId, req.user.id, req.body.reason)); // FR-74a
});

router.post('/:id/approve', requireAuth, requirePermission('listing.approve'), async (req, res) => {
  res.json(await listings.approveListing(req.params.id, req.user.id)); // FR-19a
});

router.post('/:id/reject', requireAuth, requirePermission('listing.reject'), async (req, res) => {
  res.json(await listings.rejectOrUnpublishListing(req.params.id, { reviewerId: req.user.id, reason: req.body.reason })); // FR-21
});

router.post('/:id/verified-badge', requireAuth, requirePermission('listing.grant_verified_badge'), async (req, res) => {
  res.json(await listings.setVerifiedBadge(req.params.id, { granted: req.body.granted, reviewerId: req.user.id })); // FR-18
});

module.exports = router;
