const { Router } = require('express');
const orders = require('../modules/orders.service');
const reservations = require('../modules/reservations.service');
const listings = require('../modules/listings.service');
const escrowPayments = require('../modules/escrowPayments.service');
const payout = require('../modules/payout.service');
const settlement = require('../modules/settlement.service');
const sellerPayouts = require('../modules/sellerPayouts.service');
const sellerHeldFunds = require('../modules/sellerHeldFunds.service');
const disputes = require('../modules/disputes.service');
const returnRequests = require('../modules/returnRequests.service');
const chargebacks = require('../modules/chargebacks.service');
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
  const orderIds = ordersForSeller.map((order) => order.orderId);
  const [listingSummaries, reservationCities, holdStates, disputeStatuses, orderSettlements, orderPayouts, orderHeldFlags, returnStatuses, chargebackStatuses] = await Promise.all([
    listings.getSellerOrderListingSummaries(ordersForSeller.map((order) => order.listingId)),
    reservations.getSellerOrderDeliveryCities(ordersForSeller.map((order) => order.reservationId)),
    payout.getSellerOrderHoldStates(orderIds),
    disputes.getSellerOrderDisputeStatuses(orderIds),
    settlement.getSellerOrderSettlements(orderIds),
    sellerPayouts.getSellerOrderPayoutSummaries(orderIds),
    sellerHeldFunds.getSellerOrderHeldFlags(orderIds),
    returnRequests.getOrderReturnStatuses(orderIds),
    chargebacks.getOrderChargebackStatuses(orderIds),
  ]);
  const listingsById = new Map(listingSummaries.map((listing) => [listing.listingId, listing]));
  const reservationsById = new Map(reservationCities.map((reservation) => [reservation.reservationId, reservation]));
  const holdStatesByOrderId = new Map(holdStates.map((hold) => [hold.orderId, hold.state]));
  const disputesByOrderId = new Map(disputeStatuses.map((dispute) => [dispute.orderId, dispute]));
  const settlementsByOrderId = new Map(orderSettlements.map((settlementRow) => [settlementRow.orderId, settlementRow]));
  const payoutsByOrderId = new Map(orderPayouts.map((payoutRow) => [payoutRow.orderId, payoutRow]));
  const heldFlagsByOrderId = new Map(orderHeldFlags.map((heldFlag) => [heldFlag.orderId, heldFlag]));
  const returnStatusesByOrderId = new Map(returnStatuses.map((status) => [status.orderId, status]));
  const chargebacksByOrderId = new Map(chargebackStatuses.map((status) => [status.orderId, status.chargebacks]));

  return ordersForSeller.map((order) => {
    const listing = listingsById.get(order.listingId);
    const reservation = reservationsById.get(order.reservationId);
    if (!listing || !reservation) {
      throw new ConfigurationError('Seller order references unavailable listing or reservation data.');
    }
    const earningsValues = settlementsByOrderId.get(order.orderId);
    const payoutValues = payoutsByOrderId.get(order.orderId);
    const disputeValues = disputesByOrderId.get(order.orderId);
    const returnValues = returnStatusesByOrderId.get(order.orderId);
    const chargebackValues = chargebacksByOrderId.get(order.orderId);

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
      earnings: earningsValues ? {
        commissionPercent: earningsValues.commissionPercent,
        commissionAmount: earningsValues.commissionAmount,
        sellerNetAmount: earningsValues.sellerNetAmount,
      } : null,
      payout: payoutValues ? {
        status: payoutValues.status,
        amount: payoutValues.amount,
        currency: payoutValues.currency,
        method: payoutValues.method,
        transferReference: payoutValues.transferReference,
        paidOn: payoutValues.paidOn,
      } : null,
      fundsHeldForVerification: Boolean(heldFlagsByOrderId.get(order.orderId)),
      payoutHoldState: holdStatesByOrderId.get(order.orderId) ?? null,
      disputeStatus: disputeValues?.status ?? null,
      disputeOutcome: disputeValues?.outcome ?? null,
      disputeReason: disputeValues?.reason ?? null,
      disputeDecidedAt: disputeValues?.decidedAt ?? null,
      disputeTimeline: disputeValues?.timeline ?? [],
      returnStatus: returnValues?.status ?? null,
      returnOutcome: returnValues?.outcome ?? null,
      returnDecidedAt: returnValues?.decidedAt ?? null,
      chargebacks: chargebackValues ?? [],
    };
  });
}

router.get('/selling', noStore, limiters.payments, async (req, res) => {
  const page = await orders.getSellerReservationOrders(req.user.id, req.query);
  res.json({
    orders: await sellerOrderResponses(page.orders),
    nextBefore: page.nextBefore,
  });
});

router.get('/selling/:orderId', noStore, limiters.payments, async (req, res) => {
  const order = await orders.getSellerReservationOrder(req.params.orderId, req.user.id);
  res.json((await sellerOrderResponses([order]))[0]);
});

router.get('/mine', noStore, limiters.payments, async (req, res) => {
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  const buyerOrders = await orders.getBuyerReservationOrders(req.user.id, limit);
  const [returnStatuses, chargebackStatuses] = await Promise.all([
    returnRequests.getOrderReturnStatuses(buyerOrders.map((order) => order.orderId)),
    chargebacks.getOrderChargebackStatuses(buyerOrders.map((order) => order.orderId)),
  ]);
  const returnStatusesByOrderId = new Map(returnStatuses.map((status) => [status.orderId, status]));
  const chargebacksByOrderId = new Map(chargebackStatuses.map((status) => [status.orderId, status.chargebacks]));
  res.json(buyerOrders.map((order) => {
    const returnStatus = returnStatusesByOrderId.get(order.orderId);
    return {
      ...order,
      returnStatus: returnStatus?.status ?? null,
      returnOutcome: returnStatus?.outcome ?? null,
      returnDecidedAt: returnStatus?.decidedAt ?? null,
      chargebacks: chargebacksByOrderId.get(order.orderId) ?? [],
    };
  }));
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
    disputeFiling: await disputes.getBuyerDisputeFilingStatus(order),
    returnRequest: await returnRequests.getOrderReturnStatus(order.orderId),
    chargebacks: (
      await chargebacks.getOrderChargebackStatuses([order.orderId])
    )[0]?.chargebacks ?? [],
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
