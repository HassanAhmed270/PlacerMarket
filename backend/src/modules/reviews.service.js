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
const MIN_VISIBLE_RATINGS = 3;

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

      const revealed = await revealPairIfComplete(client, orderId);
      if (!revealed) {
        await eventBus.emitAsync(events.REVIEW_WAITING, {
          reviewId: review.id,
          orderId,
          recipientId: revieweeId,
        }, { transaction: client });
      }
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

function validatePage(limit, cursor, cursorField = 'cursor') {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError('limit must be an integer from 1 to 100.');
  }
  if (cursor === undefined || cursor === null || cursor === '') return null;
  assertUuid(cursor, cursorField);
  return cursor;
}

function distributionFrom(row, prefix) {
  return {
    1: row[`${prefix}_1`] || 0,
    2: row[`${prefix}_2`] || 0,
    3: row[`${prefix}_3`] || 0,
    4: row[`${prefix}_4`] || 0,
    5: row[`${prefix}_5`] || 0,
  };
}

function reviewDisplayName(row, prefix) {
  return row[`${prefix}_alias`]?.trim() || row[`${prefix}_name`];
}

/** FR-27b, P35: only visible buyer-to-seller ratings contribute to the seller profile. */
async function getSellerRatingAggregate(sellerId) {
  assertUuid(sellerId, 'sellerId');
  const { rows } = await db.read(
    `SELECT CASE WHEN count(*) >= $2
                 THEN round(avg(r.rating)::numeric, 1)::text
                 ELSE NULL END AS average,
            count(*)::int AS count,
            count(*) FILTER (WHERE r.rating = 1)::int AS rating_1,
            count(*) FILTER (WHERE r.rating = 2)::int AS rating_2,
            count(*) FILTER (WHERE r.rating = 3)::int AS rating_3,
            count(*) FILTER (WHERE r.rating = 4)::int AS rating_4,
            count(*) FILTER (WHERE r.rating = 5)::int AS rating_5
       FROM reviews r
      WHERE r.reviewee_id = $1 AND r.direction = 'buyer_to_seller' AND r.state = 'visible'`,
    [sellerId, MIN_VISIBLE_RATINGS]
  );
  const row = rows[0];
  return { average: row.average, count: row.count, distribution: distributionFrom(row, 'rating') };
}

/** FR-27b, P35: only visible item ratings contribute to a listing's aggregate. */
async function getListingItemRatingAggregate(listingId) {
  assertUuid(listingId, 'listingId');
  const { rows } = await db.read(
    `SELECT CASE WHEN count(r.item_rating) >= $2
                 THEN round(avg(r.item_rating)::numeric, 1)::text
                 ELSE NULL END AS average,
            count(r.item_rating)::int AS count,
            count(*) FILTER (WHERE r.item_rating = 1)::int AS rating_1,
            count(*) FILTER (WHERE r.item_rating = 2)::int AS rating_2,
            count(*) FILTER (WHERE r.item_rating = 3)::int AS rating_3,
            count(*) FILTER (WHERE r.item_rating = 4)::int AS rating_4,
            count(*) FILTER (WHERE r.item_rating = 5)::int AS rating_5
       FROM reviews r
       JOIN orders o ON o.id = r.order_id
      WHERE o.listing_id = $1
        AND r.direction = 'buyer_to_seller'
        AND r.state = 'visible'
        AND r.item_rating IS NOT NULL`,
    [listingId, MIN_VISIBLE_RATINGS]
  );
  const row = rows[0];
  return { average: row.average, count: row.count, distribution: distributionFrom(row, 'rating') };
}

/** FR-27b: return the caller's own review and any revealed review written about them. */
async function getOrderReviewRead(orderId, userId) {
  assertUuid(orderId, 'orderId');
  assertUuid(userId, 'userId');
  const { rows } = await db.read(
    `SELECT id, order_id, reviewer_id, reviewee_id, direction, rating, item_rating,
            body, state, revealed_at, created_at
       FROM reviews
      WHERE order_id = $1
        AND (reviewer_id = $2 OR (reviewee_id = $2 AND state = 'visible'))`,
    [orderId, userId]
  );
  const result = { myReview: null, reviewOfMe: null };
  for (const row of rows) {
    if (row.reviewer_id === userId) result.myReview = reviewView(row);
    else if (row.reviewee_id === userId) result.reviewOfMe = reviewView(row);
  }
  return result;
}

/** FR-27b: batch the order review visibility rules for order lists. */
async function getOrderReviewReads(orderIds, userId) {
  assertUuid(userId, 'userId');
  if (!Array.isArray(orderIds) || orderIds.some((orderId) => !UUID.test(orderId))) {
    throw new ValidationError('orderIds must be an array of UUIDs.');
  }
  const result = new Map(orderIds.map((orderId) => [orderId, { myReview: null, reviewOfMe: null }]));
  if (orderIds.length === 0) return result;
  const { rows } = await db.read(
    `SELECT id, order_id, reviewer_id, reviewee_id, direction, rating, item_rating,
            body, state, revealed_at, created_at
       FROM reviews
      WHERE order_id = ANY($1::uuid[])
        AND (reviewer_id = $2 OR (reviewee_id = $2 AND state = 'visible'))`,
    [orderIds, userId]
  );
  for (const row of rows) {
    const orderReviews = result.get(row.order_id);
    if (row.reviewer_id === userId) orderReviews.myReview = reviewView(row);
    else if (row.reviewee_id === userId) orderReviews.reviewOfMe = reviewView(row);
  }
  return result;
}

/** FR-27b: public seller reviews use an id cursor resolved and compared entirely in SQL. */
async function listPublicSellerReviews(sellerId, { cursor, limit = 20 } = {}) {
  assertUuid(sellerId, 'sellerId');
  const afterId = validatePage(limit, cursor);
  const { rows } = await db.read(
    `WITH cursor_review AS (
       SELECT id, created_at
         FROM reviews
        WHERE id = $1::uuid
          AND reviewee_id = $2
          AND direction = 'buyer_to_seller'
          AND state = 'visible'
     )
     SELECT cursor_check.valid AS cursor_valid, page.*
       FROM (
         SELECT $1::uuid IS NULL OR EXISTS (SELECT 1 FROM cursor_review) AS valid
       ) cursor_check
       LEFT JOIN LATERAL (
         SELECT r.id, r.rating, r.item_rating, r.body, r.created_at,
                u.full_name AS reviewer_name, sp.display_alias AS reviewer_alias
           FROM reviews r
           JOIN users u ON u.id = r.reviewer_id
           LEFT JOIN seller_profiles sp ON sp.user_id = u.id
          WHERE r.reviewee_id = $2
            AND r.direction = 'buyer_to_seller'
            AND r.state = 'visible'
            AND ($1::uuid IS NULL OR (r.created_at, r.id) < (
              SELECT created_at, id FROM cursor_review
            ))
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT $3
       ) page ON true`,
    [afterId, sellerId, limit + 1]
  );
  if (!rows[0]?.cursor_valid) {
    throw new ValidationError('cursor must identify a visible review for this seller.');
  }
  const reviews = rows.filter((row) => row.id !== null);
  const hasMore = reviews.length > limit;
  const page = reviews.slice(0, limit).map((row) => ({
    id: row.id,
    rating: row.rating,
    itemRating: row.item_rating,
    body: row.body,
    createdAt: row.created_at,
    reviewer: { displayName: reviewDisplayName(row, 'reviewer') },
  }));
  return {
    reviews: page,
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

/** FR-27b: any authenticated user may report a review once. */
async function reportReview(reviewId, reporterId, reason) {
  assertUuid(reviewId, 'reviewId');
  assertUuid(reporterId, 'reporterId');
  const normalizedReason = validateText(reason, 'reason', 3, 300);
  try {
    return await db.withTransaction(async (client) => {
      const { rows: reviewRows } = await client.query(
        'SELECT id FROM reviews WHERE id = $1',
        [reviewId]
      );
      if (!reviewRows[0]) throw new NotFoundError('review', reviewId);
      const { rows } = await client.query(
        `INSERT INTO review_reports (review_id, reporter_id, reason)
         VALUES ($1, $2, $3)
         RETURNING id, review_id, reason, created_at`,
        [reviewId, reporterId, normalizedReason]
      );
      return {
        id: rows[0].id,
        reviewId: rows[0].review_id,
        reason: rows[0].reason,
        createdAt: rows[0].created_at,
      };
    });
  } catch (error) {
    if (error?.code === '23505' && error.constraint === 'review_reports_review_id_reporter_id_key') {
      throw new ConflictError('You have already reported this review.');
    }
    throw error;
  }
}

/** FR-27b: reported and hidden reviews are visible to Admins and Moderators for moderation. */
async function getReviewModerationQueue({ cursor, limit = 50, role = 'admin' } = {}) {
  const afterId = validatePage(limit, cursor);
  const { rows } = await db.read(
    `WITH queue_reviews AS (
       SELECT r.id, r.created_at
         FROM reviews r
        WHERE r.state = 'hidden_by_admin'
           OR EXISTS (SELECT 1 FROM review_reports rr WHERE rr.review_id = r.id)
     ),
     cursor_review AS (
       SELECT id, created_at FROM queue_reviews WHERE id = $1::uuid
     )
     SELECT cursor_check.valid AS cursor_valid, page.*
       FROM (
         SELECT $1::uuid IS NULL OR EXISTS (SELECT 1 FROM cursor_review) AS valid
       ) cursor_check
       LEFT JOIN LATERAL (
         SELECT r.id, r.order_id, r.direction, r.rating, r.item_rating, r.body,
                r.state, r.revealed_at, r.created_at,
                reviewer.full_name AS reviewer_name, reviewer_profile.display_alias AS reviewer_alias,
                reviewee.full_name AS reviewee_name, reviewee_profile.display_alias AS reviewee_alias,
                (SELECT count(*)::int FROM review_reports rr WHERE rr.review_id = r.id) AS report_count,
                COALESCE((
                  SELECT json_agg(json_build_object(
                    'reason', report.reason,
                    'createdAt', report.created_at,
                    'reporterDisplayName', reporter.full_name
                  ) ORDER BY report.created_at, report.id)
                    FROM review_reports report
                    JOIN users reporter ON reporter.id = report.reporter_id
                   WHERE report.review_id = r.id
                ), '[]'::json) AS reports
           FROM reviews r
           JOIN users reviewer ON reviewer.id = r.reviewer_id
           LEFT JOIN seller_profiles reviewer_profile ON reviewer_profile.user_id = reviewer.id
           JOIN users reviewee ON reviewee.id = r.reviewee_id
           LEFT JOIN seller_profiles reviewee_profile ON reviewee_profile.user_id = reviewee.id
          WHERE (r.state = 'hidden_by_admin'
                 OR EXISTS (SELECT 1 FROM review_reports rr WHERE rr.review_id = r.id))
            AND ($1::uuid IS NULL OR (r.created_at, r.id) < (
              SELECT created_at, id FROM cursor_review
            ))
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT $2
       ) page ON true`,
    [afterId, limit + 1]
  );
  if (!rows[0]?.cursor_valid) {
    throw new ValidationError('cursor must identify a review in the moderation queue.');
  }
  const queue = rows.filter((row) => row.id !== null);
  const hasMore = queue.length > limit;
  const page = queue.slice(0, limit).map((row) => {
    const blindToModerator = role === 'moderator' && row.revealed_at === null;
    return {
      id: row.id,
      orderId: blindToModerator ? null : row.order_id,
      direction: row.direction,
      rating: blindToModerator ? null : row.rating,
      itemRating: blindToModerator ? null : row.item_rating,
      body: blindToModerator ? null : row.body,
      state: row.state,
      revealedAt: row.revealed_at,
      createdAt: row.created_at,
      reviewer: blindToModerator ? null : { displayName: reviewDisplayName(row, 'reviewer') },
      reviewee: blindToModerator ? null : { displayName: reviewDisplayName(row, 'reviewee') },
      reportCount: row.report_count,
      reports: row.reports,
    };
  });
  return {
    reviews: page,
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

/** FR-27b, P33: Admins and Moderators may hide a review with a required reason. */
async function hideReview(reviewId, actorId, reason) {
  assertUuid(reviewId, 'reviewId');
  assertUuid(actorId, 'actorId');
  const normalizedReason = validateText(reason, 'reason', 3, 300);
  return db.withTransaction(async (client) => {
    const { rows: reviewRows } = await client.query(
      'SELECT id, state FROM reviews WHERE id = $1 FOR UPDATE',
      [reviewId]
    );
    if (!reviewRows[0]) throw new NotFoundError('review', reviewId);
    if (reviewRows[0].state === 'hidden_by_admin') {
      throw new ConflictError('The review is already hidden.');
    }
    const { rows } = await client.query(
      `UPDATE reviews
          SET state = 'hidden_by_admin', hidden_by = $2, hidden_reason = $3, updated_at = now()
        WHERE id = $1
        RETURNING id, state, hidden_reason, updated_at`,
      [reviewId, actorId, normalizedReason]
    );
    await client.query(
      `INSERT INTO review_moderation_events (review_id, actor_id, action, reason)
       VALUES ($1, $2, 'hide', $3)`,
      [reviewId, actorId, normalizedReason]
    );
    return {
      reviewId: rows[0].id,
      state: rows[0].state,
      reason: rows[0].hidden_reason,
      updatedAt: rows[0].updated_at,
    };
  });
}

/** FR-27b, P33: only Admins may restore a review, preserving the blind state if it was not revealed. */
async function restoreReview(reviewId, actorId, reason) {
  assertUuid(reviewId, 'reviewId');
  assertUuid(actorId, 'actorId');
  const normalizedReason = validateText(reason, 'reason', 3, 300);
  return db.withTransaction(async (client) => {
    const { rows: reviewRows } = await client.query(
      'SELECT id, order_id, state, revealed_at FROM reviews WHERE id = $1 FOR UPDATE',
      [reviewId]
    );
    if (!reviewRows[0]) throw new NotFoundError('review', reviewId);
    if (reviewRows[0].state !== 'hidden_by_admin') {
      throw new ConflictError('The review is not hidden.');
    }
    const restoredState = reviewRows[0].revealed_at ? 'visible' : 'hidden_until_reveal';
    await client.query(
      `UPDATE reviews
          SET state = $2, hidden_by = NULL, hidden_reason = NULL, updated_at = now()
        WHERE id = $1`,
      [reviewId, restoredState]
    );
    await client.query(
      `INSERT INTO review_moderation_events (review_id, actor_id, action, reason)
       VALUES ($1, $2, 'restore', $3)`,
      [reviewId, actorId, normalizedReason]
    );
    if (restoredState === 'hidden_until_reveal') {
      await revealPairIfComplete(client, reviewRows[0].order_id);
    }
    const { rows } = await client.query(
      'SELECT state, updated_at FROM reviews WHERE id = $1',
      [reviewId]
    );
    return {
      reviewId,
      state: rows[0].state,
      updatedAt: rows[0].updated_at,
    };
  });
}

module.exports = {
  submitReview,
  revealEligibleReviews,
  MIN_VISIBLE_RATINGS,
  getSellerRatingAggregate,
  getListingItemRatingAggregate,
  getOrderReviewRead,
  getOrderReviewReads,
  listPublicSellerReviews,
  reportReview,
  getReviewModerationQueue,
  hideReview,
  restoreReview,
};
