const { Router } = require('express');
const orders = require('../modules/orders.service');
const reservations = require('../modules/reservations.service');
const listings = require('../modules/listings.service');
const escrowPayments = require('../modules/escrowPayments.service');
const payout = require('../modules/payout.service');
const disputes = require('../modules/disputes.service');
const { requireAuth } = require('../middleware/auth');
const { createConfiguredRateLimiters } = require('../middleware/rateLimit');
const { ConfigurationError } = require('../lib/errors');

const router = Router();
const limiters = createConfiguredRateLimiters();
router.use(requireAuth); // every order action requires login

function noStore(_req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  return next();
}

async function sellerOrderResponses(ordersForSeller) {
  const [listingSummaries, reservationCities, holdStates, disputeStatuses] = await Promise.all([
    listings.getSellerOrderListingSummaries(ordersForSeller.map((order) => order.listingId)),
    reservations.getSellerOrderDeliveryCities(ordersForSeller.map((order) => order.reservationId)),
    payout.getSellerOrderHoldStates(ordersForSeller.map((order) => order.orderId)),
    disputes.getSellerOrderDisputeStatuses(ordersForSeller.map((order) => order.orderId)),
  ]);
  const listingsById = new Map(listingSummaries.map((listing) => [listing.listingId, listing]));
  const reservationsById = new Map(reservationCities.map((reservation) => [reservation.reservationId, reservation]));
  const holdStatesByOrderId = new Map(holdStates.map((hold) => [hold.orderId, hold.state]));
  const disputeStatusesByOrderId = new Map(disputeStatuses.map((dispute) => [dispute.orderId, dispute.status]));

  return ordersForSeller.map((order) => {
    const listing = listingsById.get(order.listingId);
    const reservation = reservationsById.get(order.reservationId);
    if (!listing || !reservation) {
      throw new ConfigurationError('Seller order references unavailable listing or reservation data.');
    }
    return {
      orderId: order.orderId,
      listingId: order.listingId,
      title: listing.title,
      imageUrl: listing.imageUrl,
      status: order.status,
      itemPrice: order.itemPrice,
      currency: reservation.currency,
      deliveryCity: reservation.deliveryCity,
      fundedAt: order.fundedAt,
      handoverDeadlineAt: order.handoverDeadlineAt,
      handedOverAt: order.handedOverAt,
      deliveredAt: order.deliveredAt,
      cancelledAt: order.cancelledAt,
      payoutHoldState: holdStatesByOrderId.get(order.orderId) ?? null,
      disputeStatus: disputeStatusesByOrderId.get(order.orderId) ?? null,
    };
  });
}

router.get('/selling', noStore, limiters.payments, async (req, res) => {
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  const ordersForSeller = await orders.getSellerReservationOrders(req.user.id, limit);
  res.json(await sellerOrderResponses(ordersForSeller));
});

router.get('/selling/:orderId', noStore, limiters.payments, async (req, res) => {
  const order = await orders.getSellerReservationOrder(req.params.orderId, req.user.id);
  res.json((await sellerOrderResponses([order]))[0]);
});

router.get('/mine', noStore, limiters.payments, async (req, res) => {
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  res.json(await orders.getBuyerReservationOrders(req.user.id, limit));
});

router.get('/:orderId/summary', noStore, limiters.payments, async (req, res) => {
  const order = await orders.getBuyerReservationOrder(req.params.orderId, req.user.id);
  const [reservation, listing, paymentStatus] = await Promise.all([
    reservations.getBuyerReservationSnapshot(order.reservationId, req.user.id),
    listings.getBuyerOrderListingSummary(order.listingId),
    escrowPayments.getPaymentStatus({ orderId: order.orderId, buyerId: req.user.id }),
  ]);
  res.json({
    orderId: order.orderId,
    listing,
    status: order.status,
    itemPrice: reservation.itemPrice,
    deliveryFee: reservation.deliveryFee,
    total: reservation.total,
    currency: reservation.currency,
    reservation: {
      status: reservation.status,
      expiresAt: reservation.expiresAt,
    },
    payment: paymentStatus.status === null ? null : {
      status: paymentStatus.status,
      checkoutUrl: paymentStatus.checkoutUrl || null,
    },
    handoverDeadlineAt: order.handoverDeadlineAt,
    createdAt: order.createdAt,
    address: {
      recipientName: reservation.recipientName,
      city: reservation.city,
      addressLine1: reservation.addressLine1,
    },
  });
});

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
