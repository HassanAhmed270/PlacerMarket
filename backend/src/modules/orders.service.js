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
const listingSearch = require('./listingSearch.service');
const pageSnapshots = require('./pageSnapshots.service');
const availability = require('./availability.service');
const {
  NotFoundError, ValidationError, ForbiddenError, ConflictError, NotYetSpecifiedError,
} = require('../lib/errors');

const PRE_DISPATCH_STATUSES = new Set(['bag', 'order_placed', 'seller_preparing']); // FR-33a cutoff
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function lockListingForOrder(client, listingId) {
  const { rows } = await client.query(
    'SELECT id, status FROM listings WHERE id = $1 FOR UPDATE', [listingId]
  );
  return rows[0] || null;
}

async function readListingAvailability(client, listingId) {
  const { rows } = await client.query(
    `SELECT ${availability.reservedPredicateSql('l', availability.LEGACY_ORDER_SYNC_RESERVED_STATUSES)} AS is_reserved,
            ${availability.soldPredicateSql('l')} AS is_sold
     FROM listings l WHERE l.id = $1`,
    [listingId]
  );
  return rows[0] || { is_reserved: false, is_sold: false };
}

async function syncListingAfterOrderTransition(client, listingId, previousAvailability) {
  const currentAvailability = await readListingAvailability(client, listingId);
  if (currentAvailability.is_reserved === previousAvailability.is_reserved
      && currentAvailability.is_sold === previousAvailability.is_sold) return;
  const { rows } = await client.query(
    `UPDATE listings SET search_version = search_version + 1, updated_at = now()
     WHERE id = $1 RETURNING search_version`,
    [listingId]
  );
  if (rows[0]) {
    await listingSearch.enqueueListingSearchSync(client, listingId, rows[0].search_version);
    await pageSnapshots.enqueueListingSnapshotSync(client, listingId, rows[0].search_version);
  }
}

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
    if (order.reservation_id !== null) {
      throw new ConflictError('Reservation-backed orders cannot use legacy checkout.');
    }
    if (order.status !== 'bag') throw new ValidationError('Order is not in "bag" state');

    const listing = await lockListingForOrder(client, order.listing_id);
    const previousAvailability = listing ? await readListingAvailability(client, order.listing_id) : null;
    const { rows: updated } = await client.query(
      `UPDATE orders
       SET delivery_address = $1, payment_method_preference = $2, delivery_fee = $3,
           status = 'order_placed', checkout_completed_at = now()
       WHERE id = $4 RETURNING *`,
      [deliveryAddress, paymentMethodPreference, deliveryFee, orderId]
    );
    if (listing) await syncListingAfterOrderTransition(client, order.listing_id, previousAvailability);
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
    const { rows: existing } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const order = existing[0];
    if (!order) throw new NotFoundError('order', orderId);
    const listing = await lockListingForOrder(client, order.listing_id);
    const previousAvailability = listing ? await readListingAvailability(client, order.listing_id) : null;
    const { rows } = await client.query(
      `UPDATE orders SET status = $1 ${setClause} WHERE id = $2 RETURNING *`,
      [newStatus, orderId]
    );
    if (listing) {
      await syncListingAfterOrderTransition(client, order.listing_id, previousAvailability);
    }
    await eventBus.emitAsync(events.ORDER_STATUS_CHANGED, { orderId, status: newStatus, ...meta }, { transaction: client });
    return rows[0];
  });
}

/** FR-61, FR-62: fund a reservation-backed order using database time. */
async function fundReservationOrder(client, orderId, reservationId) {
  const { rows } = await client.query(
    `UPDATE orders
     SET status = 'funded', funded_at = now(),
         handover_deadline_at = now() + INTERVAL '72 hours'
     WHERE id = $1 AND reservation_id = $2 AND status = 'payment_pending'
     RETURNING id`,
    [orderId, reservationId]
  );
  return rows[0] || null;
}

/** FR-61, FR-62: cancel an unpaid reservation-backed order after expiry. */
async function cancelUnpaidReservationOrder(client, orderId) {
  const { rows } = await client.query(
    `UPDATE orders
     SET status = 'cancelled', cancelled_at = now()
     WHERE id = $1 AND status IN ('reserved', 'payment_pending')
     RETURNING id`,
    [orderId]
  );
  return rows[0] || null;
}

/** FR-63a, FR-65, FR-69, FR-72: read immutable order context before acquiring canonical money locks. */
async function getMoneyLockContext(client, orderId) {
  const { rows } = await client.query(
    'SELECT id, listing_id, buyer_id, reservation_id FROM orders WHERE id = $1',
    [orderId]
  );
  return rows[0] || null;
}

/** FR-42, FR-72: return the order parties for delivery tracking access checks. */
async function getDeliveryOrderParties(orderId) {
  const { rows } = await db.query(
    'SELECT buyer_id, seller_id FROM orders WHERE id = $1',
    [orderId]
  );
  return rows[0] || null;
}

/** FR-63a: lock and cancel orders before their expired reservation rows are changed. */
async function cancelExpiredReservationOrders(client, reservationIds) {
  if (!reservationIds.length) return [];
  const { rows: locked } = await client.query(
    `SELECT id
     FROM orders
     WHERE reservation_id = ANY($1::uuid[]) AND status IN ('reserved', 'payment_pending')
     ORDER BY id
     FOR UPDATE`,
    [reservationIds]
  );
  if (!locked.length) return [];
  const { rows } = await client.query(
    `UPDATE orders
     SET status = 'cancelled', cancelled_at = now()
     WHERE id = ANY($1::uuid[]) AND status IN ('reserved', 'payment_pending')
     RETURNING id`,
    [locked.map((order) => order.id)]
  );
  return rows;
}

/** FR-69: lock the owning order before an escrow refund locks payment and refund rows. */
async function lockOrderForRefund(client, orderId) {
  const { rows } = await client.query(
    'SELECT id, listing_id, buyer_id FROM orders WHERE id = $1 FOR UPDATE',
    [orderId]
  );
  return rows[0] || null;
}

/** FR-33a, FR-63a, FR-72: lock an escrow order before its reservation and payment. */
async function lockReservationOrderForSystemAction(client, orderId) {
  const { rows } = await client.query(
    `SELECT id, listing_id, reservation_id, buyer_id, status, handed_over_at,
            handover_deadline_at,
            handover_deadline_at IS NOT NULL AND handover_deadline_at <= now() AS handover_due
     FROM orders
     WHERE id = $1
     FOR UPDATE`,
    [orderId]
  );
  return rows[0] || null;
}

/** FR-68, FR-72: lock an order for delivery validation after its listing and buyer. */
async function lockReservationOrderForHandover(client, orderId) {
  const { rows } = await client.query(
    `SELECT id, listing_id, reservation_id, buyer_id, status, funded_at,
            handed_over_at, handover_deadline_at, delivered_at
     FROM orders
     WHERE id = $1
     FOR UPDATE`,
    [orderId]
  );
  return rows[0] || null;
}

/** FR-65: lock a reservation-backed order after its listing and buyer. */
async function lockReservationOrderForPayout(client, orderId) {
  const { rows } = await client.query(
    `SELECT id, listing_id, reservation_id, buyer_id, seller_id, status, delivered_at
     FROM orders
     WHERE id = $1
     FOR UPDATE`,
    [orderId]
  );
  return rows[0] || null;
}

/** FR-65: complete a payout order through its owner in the caller's transaction. */
async function completeReservationPayoutOrder(client, orderId) {
  const { rows } = await client.query(
    `UPDATE orders
     SET status = 'completed', completed_at = now()
     WHERE id = $1 AND reservation_id IS NOT NULL AND status = 'held'
     RETURNING id, status, completed_at`,
    [orderId]
  );
  return rows[0] || null;
}

/** FR-68: persist delivery and payout-hold order states on a reservation-backed order. */
async function markReservationOrderDelivered(client, orderId) {
  const { rows: deliveredRows } = await client.query(
    `UPDATE orders
     SET status = 'delivered', delivered_at = now()
     WHERE id = $1
       AND reservation_id IS NOT NULL
       AND status IN ('handed_to_delivery', 'out_for_delivery')
       AND delivered_at IS NULL
       AND handed_over_at IS NOT NULL
     RETURNING id, delivered_at`,
    [orderId]
  );
  if (!deliveredRows[0]) return null;

  const { rows: heldRows } = await client.query(
    `UPDATE orders
     SET status = 'held'
     WHERE id = $1 AND status = 'delivered' AND delivered_at IS NOT NULL
     RETURNING id, status, delivered_at`,
    [orderId]
  );
  return heldRows[0] || null;
}

/** FR-72: record courier handover timestamps on the owning order in the caller's transaction. */
async function recordCourierHandover(client, orderId, courierPickupAt) {
  const { rows } = await client.query(
    `UPDATE orders
     SET status = 'handed_to_delivery',
         courier_pickup_at = $2::timestamptz,
         handover_recorded_at = now(),
         handed_over_at = $2::timestamptz
     WHERE id = $1 AND status = 'funded' AND handed_over_at IS NULL
     RETURNING id, status, courier_pickup_at, handover_recorded_at`,
    [orderId, courierPickupAt]
  );
  return rows[0] || null;
}

/** FR-33a, FR-63a, FR-72: update the owning order after a system cancellation decision. */
async function cancelReservationOrder(client, orderId, allowedStatuses) {
  const { rows } = await client.query(
    `UPDATE orders
     SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, now())
     WHERE id = $1 AND status::text = ANY($2::text[])
     RETURNING id`,
    [orderId, allowedStatuses]
  );
  return rows[0] || null;
}

/** FR-63a: read the owning reservation-backed order id for a reservation. */
async function getOrderIdForReservation(client, reservationId) {
  const { rows } = await client.query(
    'SELECT id FROM orders WHERE reservation_id = $1',
    [reservationId]
  );
  return rows[0]?.id || null;
}

/** FR-72: list a bounded batch of funded orders whose 72-hour handover deadline elapsed. */
async function getDueHandoverOrderIds(limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError('Handover sweep batch limit must be from 1 to 100.');
  }
  const { rows } = await db.read(
    `SELECT id
     FROM orders
     WHERE status IN ('funded', 'seller_preparing')
       AND handed_over_at IS NULL
       AND handover_deadline_at <= now()
     ORDER BY handover_deadline_at, id
     LIMIT $1`,
    [limit]
  );
  return rows.map(({ id }) => id);
}

/** FR-33a: free cancellation before handover to delivery partner, no fee. */
async function cancelOrder(orderId, buyerId) {
  const updated = await db.withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const order = rows[0];
    if (!order) throw new NotFoundError('order', orderId);
    if (order.buyer_id !== buyerId) throw new ForbiddenError('Not your order');
    if (order.reservation_id !== null) {
      throw new ConflictError('Reservation-backed orders cannot use legacy cancellation.');
    }
    if (!PRE_DISPATCH_STATUSES.has(order.status)) {
      throw new ValidationError('Order has already been handed to delivery — cancellation window has passed (FR-33a)');
    }
    const listing = await lockListingForOrder(client, order.listing_id);
    const previousAvailability = listing ? await readListingAvailability(client, order.listing_id) : null;
    const { rows: cancelled } = await client.query(
      `UPDATE orders SET status = 'cancelled', cancelled_at = now() WHERE id = $1 RETURNING *`,
      [orderId]
    );
    if (listing) await syncListingAfterOrderTransition(client, order.listing_id, previousAvailability);
    return cancelled[0];
  });
  eventBus.emit(events.ORDER_CANCELLED, { orderId });
  return updated;
}

/** FR-63a: guard legacy payment and payout paths against reservation-backed orders. */
async function assertLegacyOrder(orderId) {
  const { rows } = await db.query('SELECT reservation_id FROM orders WHERE id = $1', [orderId]);
  if (rows[0]?.reservation_id !== null && rows[0]?.reservation_id !== undefined) {
    throw new ConflictError('Reservation-backed orders cannot use legacy COD or payout operations.');
  }
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

/** FR-61, FR-62: load a reservation-backed order only for its buyer. */
async function getBuyerReservationOrder(orderId, buyerId) {
  if (typeof orderId !== 'string' || !UUID.test(orderId)
      || typeof buyerId !== 'string' || !UUID.test(buyerId)) {
    throw new ValidationError('Order and buyer ids must be UUIDs.');
  }
  const { rows } = await db.read(
    `SELECT id, listing_id, reservation_id, status, handover_deadline_at, created_at
     FROM orders
     WHERE id = $1 AND buyer_id = $2 AND reservation_id IS NOT NULL`,
    [orderId, buyerId]
  );
  if (!rows[0]) throw new NotFoundError('order', orderId);
  return {
    orderId: rows[0].id,
    listingId: rows[0].listing_id,
    reservationId: rows[0].reservation_id,
    status: rows[0].status,
    handoverDeadlineAt: rows[0].handover_deadline_at,
    createdAt: rows[0].created_at,
  };
}

/** FR-61, FR-62: list at most 20 of the caller's reservation-backed orders. */
async function getBuyerReservationOrders(userId, limit = 20) {
  if (typeof userId !== 'string' || !UUID.test(userId)
      || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new ValidationError('A buyer UUID and limit from 1 to 20 are required.');
  }
  // cross-module read: listings (owned by listings.service.js)
  // cross-module read: reservations (owned by reservations.service.js)
  const { rows } = await db.read(
    `SELECT o.id AS order_id, o.listing_id, l.title, o.status,
            r.total_amount_snapshot, r.currency, r.expires_at, o.created_at
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     JOIN reservations r ON r.id = o.reservation_id
     WHERE o.buyer_id = $1 AND o.reservation_id IS NOT NULL
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows.map((row) => ({
    orderId: row.order_id,
    listingId: row.listing_id,
    title: row.title,
    status: row.status,
    total: String(row.total_amount_snapshot),
    currency: row.currency,
    reservationExpiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
  }));
}

/** FR-34: return a seller's funded reservation-backed order details. */
async function getSellerReservationOrder(orderId, sellerId) {
  if (typeof orderId !== 'string' || !UUID.test(orderId)
      || typeof sellerId !== 'string' || !UUID.test(sellerId)) {
    throw new ValidationError('Order and buyer ids must be UUIDs.');
  }
  const { rows } = await db.read(
    `SELECT id AS order_id, listing_id, reservation_id, status,
            agreed_item_price, funded_at, handover_deadline_at, handed_over_at,
            delivered_at, cancelled_at
     FROM orders
     WHERE id = $1 AND seller_id = $2
       AND reservation_id IS NOT NULL AND funded_at IS NOT NULL`,
    [orderId, sellerId]
  );
  const row = rows[0];
  if (!row) throw new NotFoundError('order', orderId);
  return {
    orderId: row.order_id,
    listingId: row.listing_id,
    reservationId: row.reservation_id,
    status: row.status,
    itemPrice: String(row.agreed_item_price),
    fundedAt: row.funded_at,
    handoverDeadlineAt: row.handover_deadline_at,
    handedOverAt: row.handed_over_at,
    deliveredAt: row.delivered_at,
    cancelledAt: row.cancelled_at,
  };
}

/** FR-34: list at most 20 of the seller's funded reservation-backed orders. */
async function getSellerReservationOrders(sellerId, limit = 20) {
  if (typeof sellerId !== 'string' || !UUID.test(sellerId)
      || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new ValidationError('A buyer UUID and limit from 1 to 20 are required.');
  }
  const { rows } = await db.read(
    `SELECT id AS order_id, listing_id, reservation_id, status,
            agreed_item_price, funded_at, handover_deadline_at, handed_over_at,
            delivered_at, cancelled_at
     FROM orders
     WHERE seller_id = $1 AND reservation_id IS NOT NULL AND funded_at IS NOT NULL
     ORDER BY funded_at DESC, id DESC
     LIMIT $2`,
    [sellerId, limit]
  );
  return rows.map((row) => ({
    orderId: row.order_id,
    listingId: row.listing_id,
    reservationId: row.reservation_id,
    status: row.status,
    itemPrice: String(row.agreed_item_price),
    fundedAt: row.funded_at,
    handoverDeadlineAt: row.handover_deadline_at,
    handedOverAt: row.handed_over_at,
    deliveredAt: row.delivered_at,
    cancelledAt: row.cancelled_at,
  }));
}

/** FR-68: return the owner-scoped fields needed to compose an Admin reservation-order read. */
async function getAdminReservationOrderContext(orderId) {
  if (typeof orderId !== 'string' || !UUID.test(orderId)) {
    throw new ValidationError('orderId must be a UUID.');
  }
  return db.one(
    `SELECT id, listing_id, reservation_id, buyer_id, seller_id, status,
            funded_at, handover_deadline_at, handed_over_at, delivered_at,
            courier_pickup_at, handover_recorded_at, created_at
     FROM orders
     WHERE id = $1 AND reservation_id IS NOT NULL`,
    [orderId]
  );
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
  fundReservationOrder,
  cancelUnpaidReservationOrder,
  getMoneyLockContext,
  getDeliveryOrderParties,
  cancelExpiredReservationOrders,
  getDueHandoverOrderIds,
  lockOrderForRefund,
  lockReservationOrderForSystemAction,
  lockReservationOrderForHandover,
  lockReservationOrderForPayout,
  completeReservationPayoutOrder,
  markReservationOrderDelivered,
  recordCourierHandover,
  cancelReservationOrder,
  getOrderIdForReservation,
  cancelOrder,
  assertLegacyOrder,
  handleRefusalAtDoor,
  getOrderHistory,
  getBuyerReservationOrder,
  getBuyerReservationOrders,
  getSellerReservationOrder,
  getSellerReservationOrders,
  getAdminReservationOrderContext,
  getCodAmountDue,
  submitReview,
  getSellerRatingSummary,
};
