const { Router } = require('express');
const media = require('../modules/media.service');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = Router();
const dailyUploadLimit = createRateLimiter({ category: 'media_upload', ipMax: 1000, accountMax: 20, windowSeconds: 86400 });

router.post('/listings/:id/images', requireAuth, dailyUploadLimit, async (req, res) => {
  if (!['front', 'back', 'other', 'optional_1', 'optional_2', 'optional_3'].includes(req.query.slot)) {
    return res.status(400).json({ error: 'slot must be front, back, other, or optional_1 through optional_3' });
  }
  const image = await media.uploadListingImage({
    listingId: req.params.id, sellerId: req.user.id, slot: req.query.slot, bytes: req.body,
  });
  return res.status(202).json(image);
});

router.get('/images/:id/:variant/:hash.webp', async (req, res) => {
  const bytes = await media.publicVariant(req.params.id, req.params.variant, req.params.hash);
  if (!bytes) return res.status(404).end();
  res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  return res.send(bytes);
});

router.get('/moderation-images/:id/:variant/:hash.webp', requireAuth, requirePermission('listing.review'), async (req, res) => {
  const bytes = await media.moderationVariant(req.params.id, req.params.variant, req.params.hash);
  if (!bytes) return res.status(404).end();
  res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  return res.send(bytes);
});

router.get('/private', async (req, res) => {
  const bytes = await media.privateObject(req.query.key, req.query.expires, req.query.signature);
  if (!bytes) return res.status(404).end();
  res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  return res.send(bytes);
});

router.get('/images/:id/original-url', requireAuth, async (req, res) => {
  const url = await media.signedOriginal(req.params.id, req.user.id);
  if (!url) return res.status(404).json({ error: 'Image not found' });
  return res.json({ url });
});

module.exports = router;
