const { Router } = require('express');
const orders = require('../modules/orders.service');
const { requireAuth } = require('../middleware/auth');

const router = Router();
router.use(requireAuth); // every order action requires login

router.post('/:id/checkout', async (req, res) => {
  res.json(await orders.checkoutFromBag(req.params.id, req.user.id, req.body)); // FR-32a
});

router.post('/:id/cancel', async (req, res) => {
  res.json(await orders.cancelOrder(req.params.id, req.user.id)); // FR-33a
});

router.get('/', async (req, res) => {
  res.json(await orders.getOrderHistory(req.user.id)); // FR-34
});

router.post('/:id/reviews', async (req, res) => {
  res.status(201).json(await orders.submitReview(req.params.id, req.user.id, req.body)); // FR-27b
});

// FR-33b (OPEN / MAJOR GAP): route exists so the endpoint shape is visible,
// but the handler throws NotYetSpecifiedError — see orders.service.js.
router.post('/:id/refusal-at-door', async (req, res) => {
  res.json(await orders.handleRefusalAtDoor(req.params.id));
});

module.exports = router;
