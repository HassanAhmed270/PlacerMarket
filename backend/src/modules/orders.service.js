/**
 * modules/orders.service.js
 *
 * Owns: FR-32 to FR-34 (specs.md section "6. Orders"), plus FR-27b (reviews
 * table is defined here in schema.sql, even though the FR itself is listed
 * under Search & Discovery — discovery.service.js reads the aggregate via
 * getSellerRatingSummary() below rather than querying `reviews` itself).
 * Tables owned: orders, reviews
 *
 * Cross-module dependencies IN (who calls this file):
 * - negotiation.service.acceptOffer() calls createBagEntry() (FR-32).
 * - payments.service.confirmCodCollection() calls setOrderStatus() and
 *   triggers payout.service.startHold() (FR-38, FR-45b) — the payout side
 *   lives in payout.service.js, not here.
 * - discovery.service.getSellerPublicCard() calls getSellerRatingSummary().
 *
 * FR-33b (OPEN / MAJOR GAP): `refused_at_door` is a reserved order_status
 * enum value with NO supporting logic yet (per schema.sql implementation
 * note #1). handleRefusalAtDoor() below throws NotYetSpecifiedError on
 * purpose — do not implement a guess here.
 */

const db = require('../db.service');
const eventBus = require('../lib/eventBus');
const events = require('../lib/events');
const { NotFoundError, ValidationError, ForbiddenError, NotYetSpecifiedError } = require('../lib/errors');

const PRE_DISPATCH_STATUSES = new Set(['bag', 'order_placed', 'seller_preparing']); // FR-33a cutoff

// ---- FR-32: Bag ----

/** FR-32: an accepted offer moves to the Bag — NOT yet a finalized order. */
async function createBagEntry(offer) {
  const { rows: convRows } = await db.query(
    'SELECT buyer_id, seller_id FROM conversations WHERE id = $1',
    [offer.conversation_id]
  );
  const conv = convRows[0];
  if (!conv) throw new NotFoundError('conversation', offer.conversation_id);

  const { rows } = await db.query(
    `INSERT INTO orders
       (accepted_offer_id, listing_id, buyer_id, seller_id, agreed_item_price,
        delivery_address, payment_method_preference, status)
     VALUES ($1, $2, $3, $4, $5, '', 'cash', 'bag')
     RETURNING *`,
    [offer.id, offer.listing_id, conv.buyer_id, conv.seller_id, offer.amount]
  );
  return rows[0];
}

// ---- FR-32a, FR-32b: checkout ----

/**
 * FR-32a: buyer confirms address + reviews COD total, THIS is when the order
 * record is actually created/finalized (moves out of 'bag').
 *
 * FR-32b (bag/checkout stays single-item at a time, one seller per checkout):
 * TODO — the exact enforcement point for this rule (can a buyer hold
 * multiple simultaneous 'bag' entries across different sellers, or only
 * one bag entry total?) is not precisely specified in specs.md. Do not
 * guess a hard constraint here until that's clarified; this function only
 * finalizes the ONE bag entry it's given.
 */
async function checkoutFromBag(orderId, buyerId, { deliveryAddress, paymentMethodPreference, deliveryFee }) {
  if (!['cash', 'digital_transfer'].includes(paymentMethodPreference)) {
    throw new ValidationError('paymentMethodPreference must be "cash" or "digital_transfer" (FR-36a)');
  }
  return db.withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const order = rows[0];
    if (!order) throw new NotFoundError('order', orderId);
    if (order.buyer_id !== buyerId) throw new ForbiddenError('Not your bag entry');
    if (order.status !== 'bag') throw new ValidationError('Order is not in "bag" state');

    const { rows: updated } = await client.query(
      `UPDATE orders
       SET delivery_address = $1, payment_method_preference = $2, delivery_fee = $3,
           status = 'order_placed', checkout_completed_at = now()
       WHERE id = $4 RETURNING *`,
      [deliveryAddress, paymentMethodPreference, deliveryFee, orderId]
    );
    await eventBus.emitAsync(events.ORDER_STATUS_CHANGED, { orderId, status: 'order_placed' }, { transaction: client });
    return updated[0];
  });
}

// ---- FR-33: lifecycle ----

/**
 * FR-33: generic status transition. Caller is responsible for only passing
 * valid next-states for the current state — this function does not encode
 * the full state machine graph (kept intentionally simple for the harness;
 * add transition validation here once the exact allowed graph is confirmed
 * beyond the linear happy path in specs.md).
 */
async function setOrderStatus(orderId, newStatus, meta = {}) {
  const timestampColumn = { delivered: 'delivered_at', completed: 'completed_at' }[newStatus];
  const setClause = timestampColumn ? `, ${timestampColumn} = now()` : '';
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE orders SET status = $1 ${setClause} WHERE id = $2 RETURNING *`,
      [newStatus, orderId]
    );
    if (!rows[0]) throw new NotFoundError('order', orderId);
    await eventBus.emitAsync(events.ORDER_STATUS_CHANGED, { orderId, status: newStatus, ...meta }, { transaction: client });
    return rows[0];
  });
}

/** FR-33a: free cancellation before handover to delivery partner, no fee. */
async function cancelOrder(orderId, buyerId) {
  const { rows } = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  const order = rows[0];
  if (!order) throw new NotFoundError('order', orderId);
  if (order.buyer_id !== buyerId) throw new ForbiddenError('Not your order');
  if (!PRE_DISPATCH_STATUSES.has(order.status)) {
    throw new ValidationError('Order has already been handed to delivery — cancellation window has passed (FR-33a)');
  }
  const { rows: updated } = await db.query(
    `UPDATE orders SET status = 'cancelled', cancelled_at = now() WHERE id = $1 RETURNING *`,
    [orderId]
  );
  eventBus.emit(events.ORDER_CANCELLED, { orderId });
  return updated[0];
}

/**
 * FR-33b (OPEN / MAJOR GAP): do not implement. The whole flow — who logs
 * the refusal, repeat-refusal flagging, return logistics/cost, whether it
 * counts against the seller — is undecided. This function exists only as
 * the documented landing point so it's easy to find once FR-33b is spec'd.
 */
async function handleRefusalAtDoor(orderId) {
  throw new NotYetSpecifiedError(
    'FR-33b',
    'COD refusal-at-the-door flow (who logs it, repeat-refusal flags, return logistics/cost, seller impact) is undefined'
  );
}

/** FR-34: role-scoped order history. */
async function getOrderHistory(userId) {
  const { rows } = await db.query(
    `SELECT * FROM orders WHERE buyer_id = $1 OR seller_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

// ---- FR-27b: two-way reviews, entry point is the completed Orders page only ----

/** FR-27b: only after order completion; entry point enforced by caller (Orders page), not here. */
async function submitReview(orderId, raterId, { rating, comment }) {
  const { rows } = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  const order = rows[0];
  if (!order) throw new NotFoundError('order', orderId);
  if (order.status !== 'completed') {
    throw new ValidationError('Reviews can only be submitted after order completion (FR-27b)');
  }
  const revieweeId = raterId === order.buyer_id ? order.seller_id
    : raterId === order.seller_id ? order.buyer_id
    : null;
  if (!revieweeId) throw new ForbiddenError('Rater is not a party to this order');

  const { rows: review } = await db.query(
    `INSERT INTO reviews (order_id, reviewer_id, reviewee_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [orderId, raterId, revieweeId, rating, comment || null]
  );
  return review[0];
}

/** FR-37 read-side: total_cod_amount is a generated column on `orders` — payments.service.js reads it through here rather than querying `orders` directly. */
async function getCodAmountDue(orderId) {
  const { rows } = await db.query('SELECT total_cod_amount, agreed_item_price, delivery_fee FROM orders WHERE id = $1', [orderId]);
  if (!rows[0]) throw new NotFoundError('order', orderId);
  return rows[0];
}

/** Read model for discovery.service.getSellerPublicCard() (FR-27a) — keep `reviews` ownership in this file. */
async function getSellerRatingSummary(sellerId) {
  const { rows } = await db.query(
    `SELECT COALESCE(AVG(rating), 0)::float AS "averageRating", COUNT(*)::int AS "ratingCount"
     FROM reviews WHERE reviewee_id = $1`,
    [sellerId]
  );
  return rows[0];
}

module.exports = {
  createBagEntry,
  checkoutFromBag,
  setOrderStatus,
  cancelOrder,
  handleRefusalAtDoor,
  getOrderHistory,
  getCodAmountDue,
  submitReview,
  getSellerRatingSummary,
};
