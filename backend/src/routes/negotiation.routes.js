const { Router } = require('express');
const negotiation = require('../modules/negotiation.service');
const { requireAuth } = require('../middleware/auth');

const router = Router();

// FR-22a: every route here requires login — messaging/offers are gated actions.
router.use(requireAuth);

router.post('/conversations', async (req, res) => {
  res.status(201).json(await negotiation.startConversation(req.body.listingId, req.user.id, req.body.sellerId)); // FR-28
});

router.post('/conversations/:id/messages', async (req, res) => {
  res.status(201).json(await negotiation.sendMessage(req.params.id, req.user.id, req.body.body)); // FR-28, FR-30
});

router.post('/conversations/:id/offers', async (req, res) => {
  res.status(201).json(await negotiation.makeOffer(req.params.id, req.body.listingId, req.user.id, req.body.amount)); // FR-29
});

router.post('/offers/:id/counter', async (req, res) => {
  res.status(201).json(await negotiation.counterOffer(req.params.id, req.user.id, req.body.amount)); // FR-29
});

router.post('/offers/:id/accept', async (req, res) => {
  res.json(await negotiation.acceptOffer(req.params.id, req.user.id)); // FR-29 -> FR-32 hand-off
});

router.get('/listings/:id/history', async (req, res) => {
  res.json(await negotiation.getNegotiationHistory(req.params.id)); // FR-31
});

module.exports = router;
