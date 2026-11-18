/**
 * FR-27b: two-way order reviews and their blind-reveal lifecycle.
 * Tables owned: reviews, review_reports, review_moderation_events
 */

const db = require('../db.service');
const orders = require('./orders.service');
const disputes = require('./disputes.service');
const returnRequests = require('./returnRequests.service');
const chargebacks = require('./chargebacks.service');
const settlement = require('./settlement.service');
const sellerPayouts = require('./sellerPayouts.service');
const eventBus = require('../lib/eventBus');
const events = require('../lib/events');
const {
  ConflictError, ConfigurationError, ForbiddenError, NotFoundError, ValidationError,
} = require('../lib/errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVIEW_WINDOW_SETTING = 'review_window_days';

function assertUuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new ValidationError(`${field} must be a UUID.`);
  }
}

function validateText(value, field, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new ValidationError(`${field} must be ${min} to ${max} characters.`);
  }
  return value.trim();
}

function validateReviewInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['rating', 'itemRating', 'body'].includes(key))) {
    throw new ValidationError('Review fields are invalid.');
  }
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    throw new ValidationError('rating must be an integer from 1 to 5.');
  }
  if (input.itemRating !== undefined && input.itemRating !== null &&
      (!Number.isInteger(input.itemRating) || input.itemRating < 1 || input.itemRating > 5)) {
    throw new ValidationError('itemRating must be an integer from 1 to 5.');
  }
  const body = input.body === undefined || input.body === null
    ? null
    : validateText(input.body, 'body', 3, 1000);
  return {
    rating: input.rating,
    itemRating: input.itemRating ?? null,
    hasItemRating: Object.hasOwn(input, 'itemRating'),
    body,
  };
}

async function getReviewWindowDays(client) {
  const settings = await settlement.getSettingsForTransaction(client, [REVIEW_WINDOW_SETTING]);
  const raw = settings[REVIEW_WINDOW_SETTING];
  if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new ConfigurationError('platform_settings.review_window_days must be a non-negative integer.');
  }
  return Number(raw);
}

function reviewView(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    direction: row.direction,
    rating: row.rating,
    itemRating: row.item_rating,
    body: row.body,
    state: row.state,
    revealedAt: row.revealed_at,
    createdAt: row.created_at,
  };
}

/** FR-27b: submit one eligible review and reveal both directions atomically when possible. */
async function submitReview(orderId, reviewerId, input) {
  assertUuid(orderId, 'orderId');
  assertUuid(reviewerId, 'reviewerId');
  const {
    rating, itemRating, hasItemRating, body,
  } = validateReviewInput(input);

  try {
    return await db.withTransaction(async (client) => {
      const order = await orders.lockReviewOrder(client, orderId);
      if (!order) throw new NotFoundError('order', orderId);

      const buyerToSeller = reviewerId === order.buyer_id;
      const sellerToBuyer = reviewerId === order.seller_id;
      if (!buyerToSeller && !sellerToBuyer) {
        throw new ForbiddenError('Only an order participant may submit a review.');
      }
      if (!buyerToSeller && hasItemRating) {
        throw new ValidationError('Only a buyer-to-seller review may include itemRating.');
      }
      if (order.status !== 'completed' || !order.delivered_at) {
        throw new ConflictError('Only a delivered, completed order is eligible for reviews.');
      }
      if (await disputes.hasOpenDisputeInTransaction(client, orderId) ||
          await returnRequests.hasOpenReturnRequest(client, orderId) ||
          await chargebacks.hasOpenPayoutIssue(client, orderId)) {
        throw new ConflictError('An open dispute, return request, or chargeback blocks reviews.');
      }

      const businessDate = await sellerPayouts.getBusinessDate(client);
      const reviewWindowDays = await getReviewWindowDays(client);
      const { rows: windowRows } = await client.query(
        `SELECT $1::date <=
          (($2::timestamptz AT TIME ZONE 'Asia/Karachi')::date + $3::integer) AS in_window`,
        [businessDate, order.delivered_at, reviewWindowDays]
      );
      if (!windowRows[0]?.in_window) {
        throw new ConflictError('The review window has closed.');
      }

      const direction = buyerToSeller ? 'buyer_to_seller' : 'seller_to_buyer';
      const revieweeId = buyerToSeller ? order.seller_id : order.buyer_id;
      const { rows: insertedRows } = await client.query(
        `INSERT INTO reviews
           (order_id, reviewer_id, reviewee_id, direction, rating, item_rating, body, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'hidden_until_reveal')
         RETURNING id, order_id, direction, rating, item_rating, body, state, revealed_at, created_at`,
        [orderId, reviewerId, revieweeId, direction, rating, itemRating, body]
      );
      const review = insertedRows[0];

      await eventBus.emitAsync(events.REVIEW_WAITING, {
        reviewId: review.id,
        orderId,
        recipientId: revieweeId,
      }, { transaction: client });
      await revealPairIfComplete(client, orderId);
      const { rows: finalRows } = await client.query(
        `SELECT id, order_id, direction, rating, item_rating, body, state, revealed_at, created_at
         FROM reviews WHERE id = $1`,
        [review.id]
      );
      return reviewView(finalRows[0]);
    });
  } catch (error) {
    if (error?.code === '23505' &&
        ['reviews_order_id_direction_key', 'reviews_order_direction_unique',
          'reviews_order_id_reviewer_id_key'].includes(error.constraint)) {
      throw new ConflictError('A review has already been submitted for this order and direction.');
    }
    throw error;
  }
}

async function revealPairIfComplete(client, orderId) {
  const { rows: counts } = await client.query(
    `SELECT count(*)::int AS review_count
       FROM reviews
      WHERE order_id = $1 AND direction IN ('buyer_to_seller', 'seller_to_buyer')`,
    [orderId]
  );
  if (counts[0].review_count !== 2) return false;
  const { rowCount } = await client.query(
    `UPDATE reviews
        SET state = 'visible', revealed_at = COALESCE(revealed_at, now()), updated_at = now()
      WHERE order_id = $1 AND state = 'hidden_until_reveal'`,
    [orderId]
  );
  if (rowCount) {
    await eventBus.emitAsync(events.REVIEWS_REVEALED, { orderId }, { transaction: client });
  }
  return rowCount > 0;
}

/** FR-27b: reveal completed pairs and expired single reviews in an idempotent maintenance pass. */
async function revealEligibleReviews({ getBusinessDate = sellerPayouts.getBusinessDate } = {}) {
  if (typeof getBusinessDate !== 'function') {
    throw new TypeError('The business-date owner is required to reveal expired reviews.');
  }
  return db.withTransaction(async (client) => {
    const businessDate = await getBusinessDate(client);
    const reviewWindowDays = await getReviewWindowDays(client);
    const { rows } = await client.query(
      `UPDATE reviews r
          SET state = 'visible', revealed_at = COALESCE(r.revealed_at, now()), updated_at = now()
         FROM orders o
        WHERE o.id = r.order_id
          AND r.state = 'hidden_until_reveal'
          AND (
            EXISTS (
              SELECT 1 FROM reviews other
               WHERE other.order_id = r.order_id
                 AND other.direction <> r.direction
            )
            OR $1::date >
              ((o.delivered_at AT TIME ZONE 'Asia/Karachi')::date + $2::integer)
          )
        RETURNING r.order_id`,
      [businessDate, reviewWindowDays]
    );
    const orderIds = [...new Set(rows.map((row) => row.order_id))];
    for (const orderId of orderIds) {
      await eventBus.emitAsync(events.REVIEWS_REVEALED, { orderId }, { transaction: client });
    }
    return { revealed: rows.length, orders: orderIds.length };
  });
}

module.exports = {
  submitReview,
  revealEligibleReviews,
};
