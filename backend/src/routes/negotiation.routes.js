const { Router } = require('express');
const negotiation = require('../modules/negotiation.service');
const { requireAuth } = require('../middleware/auth');
const { createConfiguredRateLimiters } = require('../middleware/rateLimit');
const { ValidationError } = require('../lib/errors');

const limiters = createConfiguredRateLimiters();

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(value, name) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ValidationError(`${name} must be a valid UUID.`);
  }
}

function requireBody(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new ValidationError('A JSON object body is required.');
  }
  return req.body;
}

function validateOfferAmount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 9999999999.99) {
    throw new ValidationError('Offer amount must be a positive number with at most 10 integer digits.');
  }
}

function validateConversationRequest(req, _res, next) {
  try {
    validateUuid(requireBody(req).listingId, 'listingId');
    return next();
  } catch (error) {
    return next(error);
  }
}

function validateMessageRequest(req, _res, next) {
  try {
    validateUuid(req.params.id, 'conversationId');
    const body = requireBody(req);
    if (typeof body.body !== 'string' || !body.body.trim() || Array.from(body.body).length > 1000) {
      throw new ValidationError('Message must contain 1 to 1000 characters.');
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireOffersEnabled(_req, res, next) {
  if (process.env.OFFERS_ENABLED !== '1') {
    return res.status(503).json({ error: 'Offers are disabled' });
  }
  return next();
}

router.use(['/conversations/:id/offers', '/offers/:id'], requireOffersEnabled);

// FR-22a: every active route here requires login — messaging/offers are gated actions.
router.use(requireAuth);

router.post('/conversations', validateConversationRequest, limiters.conversation, async (req, res) => {
  res.status(201).json(await negotiation.startConversation(req.body.listingId, req.user.id)); // FR-28
});

router.post('/conversations/:id/messages', validateMessageRequest, limiters.message, async (req, res) => {
  res.status(201).json(await negotiation.sendMessage(req.params.id, req.user.id, req.body.body));
});

router.post('/conversations/:id/offers', (req, _res, next) => {
  try {
    validateUuid(req.params.id, 'conversationId');
    const body = requireBody(req);
    validateUuid(body.listingId, 'listingId');
    validateOfferAmount(body.amount);
    return next();
  } catch (error) {
    return next(error);
  }
}, limiters.offer, async (req, res) => {
  res.status(201).json(await negotiation.makeOffer(req.params.id, req.body.listingId, req.user.id, req.body.amount)); // FR-29
});

router.post('/offers/:id/counter', (req, _res, next) => {
  try {
    validateUuid(req.params.id, 'offerId');
    validateOfferAmount(requireBody(req).amount);
    return next();
  } catch (error) {
    return next(error);
  }
}, limiters.offer, async (req, res) => {
  res.status(201).json(await negotiation.counterOffer(req.params.id, req.user.id, req.body.amount)); // FR-29
});

router.post('/offers/:id/accept', async (req, res) => {
  validateUuid(req.params.id, 'offerId');
  res.json(await negotiation.acceptOffer(req.params.id, req.user.id)); // FR-29 -> FR-32 hand-off
});

router.get('/listings/:id/history', async (req, res) => {
  validateUuid(req.params.id, 'listingId');
  res.json(await negotiation.getNegotiationHistory(req.params.id, req.user.id)); // FR-31
});

module.exports = router;
