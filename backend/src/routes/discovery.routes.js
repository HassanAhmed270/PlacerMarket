const { Router } = require('express');
const discovery = require('../modules/discovery.service');
const { requireAuth } = require('../middleware/auth');
const { createConfiguredRateLimiters } = require('../middleware/rateLimit');

const limiters = createConfiguredRateLimiters();
const router = Router();

// FR-22: pure browsing — fully public, no requireAuth on these three.
router.get('/search', limiters.search, async (req, res) => {
  const result = await discovery.searchListings({
    q: req.query.q ?? req.query.query,
    sort: req.query.sort,
    limit: req.query.limit,
    cursor: req.query.cursor,
    mainCategoryId: req.query.mainCategoryId,
    subCategoryId: req.query.subCategoryId,
    condition: req.query.condition,
    minPrice: req.query.minPrice,
    maxPrice: req.query.maxPrice,
    cityId: req.query.cityId ?? req.query.city,
    brandId: req.query.brandId ?? req.query.brand,
    colorId: req.query.colorId ?? req.query.color,
    fabricId: req.query.fabricId ?? req.query.fabric,
  });
  res.json(result);
});

router.get('/filter', async (req, res) => {
  res.json(await discovery.filterListings(req.query)); // FR-24
});

router.get('/suggestions', async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json(await discovery.getSearchVocabulary());
});

router.get('/vocabulary', async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json(await discovery.getSearchVocabulary());
});

router.get('/listings/:id', async (req, res) => {
  const detail = await discovery.getListingDetail(req.params.id); // FR-25
  if (!detail) return res.status(404).json({ error: 'Listing not found' });
  if (detail.removed) return res.status(410).json({ error: 'Listing is no longer available' });
  if (detail.sold || detail.unavailable) res.set('X-Robots-Tag', 'noindex');
  res.json(detail);
});

router.get('/listings/:id/status', async (req, res) => {
  const status = await discovery.getListingStatus(req.params.id);
  if (!status) return res.status(404).json({ error: 'Listing not found' });
  if (status.removed) return res.status(410).json({ error: 'Listing is no longer available' });
  res.json(status);
});

router.get('/listings/:id/share-url', (req, res) => {
  res.json({ url: discovery.buildShareUrl(req.params.id) }); // FR-27, public
});

router.get('/favorites', requireAuth, async (req, res) => {
  res.json(await discovery.getFavorites(req.user.id, req.query));
});

// FR-22a: login required the moment a user favorites — gated here.
router.post('/listings/:id/favorite', requireAuth, async (req, res) => {
  await discovery.addFavorite(req.user.id, req.params.id); // FR-26
  res.status(204).end();
});

router.delete('/listings/:id/favorite', requireAuth, async (req, res) => {
  await discovery.removeFavorite(req.user.id, req.params.id);
  res.status(204).end();
});

module.exports = router;
