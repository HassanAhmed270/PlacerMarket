const { Router } = require('express');
const reviews = require('../modules/reviews.service');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { createConfiguredRateLimiters } = require('../middleware/rateLimit');
const { ValidationError } = require('../lib/errors');

const router = Router();
const limiters = createConfiguredRateLimiters();

function noStore(_req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  return next();
}

function reasonFromBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'reason') ||
      typeof body.reason !== 'string') {
    throw new ValidationError('A reason of 3 to 300 characters is required.');
  }
  return body.reason;
}

router.get('/sellers/:sellerId', async (req, res) => {
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  const result = await reviews.listPublicSellerReviews(req.params.sellerId, {
    cursor: req.query.cursor ?? null,
    limit,
  });
  res.set('Cache-Control', 'no-store').json(result);
});

router.post('/:reviewId/reports', requireAuth, noStore, limiters.security, async (req, res) => {
  const result = await reviews.reportReview(req.params.reviewId, req.user.id, reasonFromBody(req.body));
  res.status(201).json(result);
});

router.get(
  '/moderation-queue',
  requireAuth,
  requirePermission('review.queue'),
  noStore,
  limiters.adminOps,
  async (req, res) => {
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    res.json(await reviews.getReviewModerationQueue({
      cursor: req.query.cursor ?? null,
      limit,
      role: req.user.role,
    }));
  }
);

router.post(
  '/:reviewId/hide',
  requireAuth,
  requirePermission('review.hide'),
  noStore,
  limiters.adminOps,
  async (req, res) => {
    res.json(await reviews.hideReview(req.params.reviewId, req.user.id, reasonFromBody(req.body)));
  }
);

router.post(
  '/:reviewId/restore',
  requireAuth,
  requirePermission('review.restore'),
  noStore,
  limiters.adminOps,
  async (req, res) => {
    res.json(await reviews.restoreReview(req.params.reviewId, req.user.id, reasonFromBody(req.body)));
  }
);

module.exports = router;
