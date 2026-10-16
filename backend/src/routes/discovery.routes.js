const { Router } = require('express');
const discovery = require('../modules/discovery.service');
const { requireAuth } = require('../middleware/auth');

const router = Router();

// FR-22: pure browsing — fully public, no requireAuth on these three.
router.get('/search', async (req, res) => {
  res.json(await discovery.searchListings(req.query.q)); // FR-23
});

router.get('/filter', async (req, res) => {
  res.json(await discovery.filterListings(req.query)); // FR-24
});

router.get('/listings/:id', async (req, res) => {
  const detail = await discovery.getListingDetail(req.params.id); // FR-25
  if (!detail) return res.status(404).json({ error: 'Listing not found' });
  res.json(detail);
});

router.get('/listings/:id/share-url', (req, res) => {
  res.json({ url: discovery.buildShareUrl(req.params.id) }); // FR-27, public
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
