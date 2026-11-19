const crypto = require('node:crypto');
const {
  authHeader,
  cleanupHarness,
  cleanupScenario,
  createHarness,
  createLegacyOrder,
  createScenario,
  db,
  getApp,
  getBusinessDate,
  request,
  restoreHandoverTestEnvironment,
} = require('./delivery-handover.helpers');
const reviews = require('../../src/modules/reviews.service');
const notifications = require('../../src/modules/notifications.service');
const queue = require('../../src/lib/queue');
const events = require('../../src/lib/events');

let harness;
let scenarios;
let originalReviewWindow;

async function createReviewScenario() {
  const scenario = await createScenario(harness);
  scenarios.push(scenario);
  await setDeliveryAge(scenario, 1);
  return scenario;
}

async function setDeliveryAge(scenario, days) {
  const businessDate = await getBusinessDate();
  await db.query(
    `UPDATE orders
        SET status = 'completed', completed_at = now(),
            delivered_at = (($1::date - $2::integer)::timestamp AT TIME ZONE 'Asia/Karachi')
      WHERE id = $3`,
    [businessDate, days, scenario.orderId]
  );
}

function submit(scenario, userId, body) {
  return request(getApp())
    .post(`/api/orders/${scenario.orderId}/reviews`)
    .set('Authorization', authHeader(userId))
    .send(body);
}

async function submitPair(scenario, {
  buyerRating = 4,
  itemRating = 4,
  sellerRating = 4,
  buyerBody = 'Buyer review text.',
  sellerBody = 'Seller review text.',
} = {}) {
  const buyerReview = await submit(scenario, scenario.buyerId, {
    rating: buyerRating,
    itemRating,
    body: buyerBody,
  }).expect(201);
  await submit(scenario, scenario.sellerId, {
    rating: sellerRating,
    body: sellerBody,
  }).expect(201);
  return buyerReview.body;
}

function sellerReviewList(sellerId, userId = null, query = {}) {
  const route = request(getApp()).get(`/api/reviews/sellers/${sellerId}`).query(query);
  return userId ? route.set('Authorization', authHeader(userId)) : route;
}

async function processReviewNotification(orderId, eventName) {
  await global.drainIntegrationListeners(5000);
  const { rows } = await db.query(
    `SELECT data FROM pgboss.job
      WHERE name = $1 AND data->>'eventName' = $2
        AND data->'payload'->>'orderId' = $3`,
    [queue.QUEUES.NOTIFICATIONS, eventName, orderId]
  );
  expect(rows).toHaveLength(1);
  const transactionDb = {
    executeSql: (text, params = []) => transactionDb.client.query(text, params),
  };
  await db.withTransaction(async (client) => {
    transactionDb.client = client;
    await notifications.processNotificationJob(rows[0].data, transactionDb);
  });
}

async function restoreReviewWindow(value) {
  await db.query(
    `UPDATE platform_settings
        SET value = $1, updated_by = $2, updated_at = $3
      WHERE key = 'review_window_days'`,
    [value.value, value.updated_by, value.updated_at]
  );
}

beforeAll(async () => {
  const { rows } = await db.query(
    `SELECT value, updated_by, updated_at FROM platform_settings
      WHERE key = 'review_window_days'`
  );
  originalReviewWindow = rows[0];
});

beforeEach(async () => {
  harness = await createHarness();
  scenarios = [];
});

afterEach(async () => {
  await global.drainIntegrationListeners(5000);
  for (const scenario of scenarios) {
    await db.query(
      'DELETE FROM review_reports WHERE review_id IN (SELECT id FROM reviews WHERE order_id = $1)',
      [scenario.orderId]
    );
    await db.query('DELETE FROM reviews WHERE order_id = $1', [scenario.orderId]);
    await db.query('DELETE FROM return_requests WHERE order_id = $1', [scenario.orderId]);
    await db.query('DELETE FROM chargebacks WHERE order_id = $1', [scenario.orderId]);
    await db.query('DELETE FROM refunds WHERE order_id = $1', [scenario.orderId]);
    await cleanupScenario(harness, scenario);
  }
  if (originalReviewWindow) await restoreReviewWindow(originalReviewWindow);
  await cleanupHarness(harness);
});

afterAll(() => {
  restoreHandoverTestEnvironment();
});

describe('FR-27b two-way reviews', () => {
  test('FR-27b: buyer and seller submit one review each and the pair is revealed together', async () => {
    const scenario = await createReviewScenario();
    const buyerReview = await submit(scenario, scenario.buyerId, {
      rating: 5, itemRating: 4, body: 'Excellent communication and service.',
    }).expect(201);
    expect(buyerReview.body).toMatchObject({
      direction: 'buyer_to_seller',
      rating: 5,
      itemRating: 4,
      state: 'hidden_until_reveal',
    });

    const sellerReview = await submit(scenario, scenario.sellerId, {
      rating: 4, body: 'Prompt payment and clear instructions.',
    }).expect(201);
    expect(sellerReview.body).toMatchObject({
      direction: 'seller_to_buyer',
      rating: 4,
      itemRating: null,
      state: 'visible',
    });
    const { rows } = await db.query(
      'SELECT direction, state FROM reviews WHERE order_id = $1 ORDER BY direction',
      [scenario.orderId]
    );
    expect(rows).toEqual([
      { direction: 'buyer_to_seller', state: 'visible' },
      { direction: 'seller_to_buyer', state: 'visible' },
    ]);
  });

  test('FR-27b: duplicate reviews return 409 and non-participants return 403', async () => {
    const scenario = await createReviewScenario();
    const body = { rating: 4 };
    await submit(scenario, harness.unrelatedBuyerId, body).expect(403);
    await submit(scenario, scenario.buyerId, body).expect(201);
    await submit(scenario, scenario.buyerId, body).expect(409);
    await submit(scenario, scenario.sellerId, body).expect(201);
  });

  test('FR-27b: rating bounds and direction-specific item rating are validated', async () => {
    const scenario = await createReviewScenario();
    for (const rating of [0, 6, 2.5, '4']) {
      await submit(scenario, scenario.buyerId, { rating }).expect(400);
    }
    await submit(scenario, scenario.buyerId, { rating: 4, itemRating: 0 }).expect(400);
    await submit(scenario, scenario.sellerId, { rating: 4, itemRating: null }).expect(400);
    await submit(scenario, scenario.buyerId, { rating: 4, itemRating: 5 }).expect(201);
  });

  test('FR-27b: review text is optional and provided text must contain 3 to 1000 characters', async () => {
    const noText = await createReviewScenario();
    await submit(noText, noText.buyerId, { rating: 4 }).expect(201);

    const shortText = await createReviewScenario();
    await submit(shortText, shortText.buyerId, { rating: 4, body: 'ok' }).expect(400);

    const longText = await createReviewScenario();
    await submit(longText, longText.buyerId, { rating: 4, body: 'a'.repeat(1001) }).expect(400);

    const maximumText = await createReviewScenario();
    await submit(maximumText, maximumText.buyerId, { rating: 4, body: 'a'.repeat(1000) }).expect(201);
  });

  test('FR-27b: an open dispute, return request, or chargeback blocks review submission with 409', async () => {
    const disputeScenario = await createReviewScenario();
    await db.query(
      `INSERT INTO disputes (order_id, raised_by, reason_text, status)
       VALUES ($1, $2, 'The delivered item differs from the listing.', 'open')`,
      [disputeScenario.orderId, disputeScenario.buyerId]
    );
    await submit(disputeScenario, disputeScenario.buyerId, { rating: 4 }).expect(409);

    const returnScenario = await createReviewScenario();
    await db.query(
      `INSERT INTO return_requests (order_id, buyer_id, reason, status)
       VALUES ($1, $2, 'The item needs to be returned.', 'requested')`,
      [returnScenario.orderId, returnScenario.buyerId]
    );
    await submit(returnScenario, returnScenario.buyerId, { rating: 4 }).expect(409);

    const chargebackScenario = await createReviewScenario();
    const refundKey = `review-test-chargeback:${crypto.randomUUID()}`;
    const { rows: refundRows } = await db.query(
      `INSERT INTO refunds
         (payment_id, order_id, trigger, amount, currency, status, idempotency_key)
       VALUES ($1, $2, 'chargeback', 1, 'PKR', 'succeeded', $3)
       RETURNING id`,
      [chargebackScenario.paymentId, chargebackScenario.orderId, refundKey]
    );
    await db.query(
      `INSERT INTO chargebacks
         (order_id, amount, currency, reference, note, recorded_by, refund_id)
       VALUES ($1, 1, 'PKR', 'review test chargeback', 'Review eligibility test', $2, $3)`,
      [chargebackScenario.orderId, harness.adminId, refundRows[0].id]
    );
    await submit(chargebackScenario, chargebackScenario.buyerId, { rating: 4 }).expect(409);
  });

  test('FR-27b: day 14 is eligible and day 15 is outside the review window', async () => {
    const day14 = await createReviewScenario();
    await setDeliveryAge(day14, 14);
    await submit(day14, day14.buyerId, { rating: 5 }).expect(201);

    const day15 = await createReviewScenario();
    await setDeliveryAge(day15, 15);
    await submit(day15, day15.buyerId, { rating: 5 }).expect(409);
  });

  test('FR-27b: the configured review window is honored and the setting is restored', async () => {
    const previous = await db.one(
      `SELECT value, updated_by, updated_at FROM platform_settings
        WHERE key = 'review_window_days'`
    );
    try {
      await db.query(
        `UPDATE platform_settings SET value = '1', updated_by = NULL, updated_at = now()
          WHERE key = 'review_window_days'`
      );
      const scenario = await createReviewScenario();
      await setDeliveryAge(scenario, 2);
      await submit(scenario, scenario.buyerId, { rating: 4 }).expect(409);
    } finally {
      await restoreReviewWindow(previous);
    }
  });

  test('FR-27b: the reveal job reveals an expired single review idempotently', async () => {
    const scenario = await createReviewScenario();
    await submit(scenario, scenario.buyerId, { rating: 5 }).expect(201);
    await setDeliveryAge(scenario, 15);
    await expect(reviews.revealEligibleReviews()).resolves.toEqual({ revealed: 1, orders: 1 });
    await expect(reviews.revealEligibleReviews()).resolves.toEqual({ revealed: 0, orders: 0 });
    const { rows } = await db.query(
      'SELECT state FROM reviews WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(rows).toEqual([{ state: 'visible' }]);
  });

  test('FR-27b: concurrent buyer and seller submissions create two revealed reviews', async () => {
    const scenario = await createReviewScenario();
    const results = await Promise.all([
      submit(scenario, scenario.buyerId, { rating: 5, itemRating: 5 }),
      submit(scenario, scenario.sellerId, { rating: 4 }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 201]);
    const { rows } = await db.query(
      'SELECT state FROM reviews WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.state === 'visible')).toBe(true);
  });

  test('FR-27b: public seller reviews hide unrevealed and moderated content and paginate by SQL cursor', async () => {
    const visible = [];
    for (let index = 0; index < 3; index += 1) {
      const scenario = await createReviewScenario();
      const review = await submitPair(scenario, {
        buyerBody: `Buyer public review ${index}.`,
        sellerBody: `Seller private review ${index}.`,
      });
      visible.push({ scenario, review });
    }
    const waitingScenario = await createReviewScenario();
    const waiting = await submit(waitingScenario, waitingScenario.buyerId, {
      rating: 5,
      itemRating: 5,
      body: 'This review is not revealed.',
    }).expect(201);

    const timestamps = [
      '2026-03-20T00:00:00.000001Z',
      '2026-03-20T00:00:00.000002Z',
      '2026-03-20T00:00:00.000003Z',
    ];
    for (let index = 0; index < visible.length; index += 1) {
      await db.query(
        'UPDATE reviews SET created_at = $2::timestamptz WHERE id = $1',
        [visible[index].review.id, timestamps[index]]
      );
    }

    const pages = [];
    let cursor = null;
    do {
      const query = { limit: 1 };
      if (cursor) query.cursor = cursor;
      const response = await sellerReviewList(harness.fixture.userId, null, query).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      pages.push(...response.body.reviews);
      cursor = response.body.nextCursor;
      if (pages.length === 3) expect(cursor).toBeNull();
    } while (cursor);

    expect(pages.map((review) => review.id)).toEqual([
      visible[2].review.id,
      visible[1].review.id,
      visible[0].review.id,
    ]);
    expect(pages.map((review) => review.body)).toEqual([
      'Buyer public review 2.',
      'Buyer public review 1.',
      'Buyer public review 0.',
    ]);
    expect(Object.keys(pages[0].reviewer)).toEqual(['displayName']);
    const { rows: buyerRows } = await db.query(
      'SELECT full_name, phone FROM users WHERE id = $1',
      [visible[2].scenario.buyerId]
    );
    const fullNameParts = buyerRows[0].full_name.trim().split(/\s+/);
    const expectedDisplayName = fullNameParts.length < 2
      ? fullNameParts[0]
      : `${fullNameParts[0]} ${Array.from(fullNameParts[fullNameParts.length - 1])[0]}.`;
    expect(pages[0].reviewer.displayName).toBe(expectedDisplayName);
    const publicJson = JSON.stringify(pages);
    expect(publicJson).not.toContain(buyerRows[0].phone);
    expect(publicJson).not.toContain(fullNameParts[fullNameParts.length - 1]);
    expect(publicJson).not.toContain('Seller private review');
    expect(publicJson).not.toContain(harness.adminId);
    expect(pages[0]).not.toHaveProperty('reviewerId');
    expect(pages[0]).not.toHaveProperty('orderId');

    for (const { review } of visible) {
      await request(getApp())
        .post(`/api/reviews/${review.id}/reports`)
        .set('Authorization', authHeader(harness.unrelatedBuyerId))
        .send({ reason: 'Visible review report.' })
        .expect(201);
    }
    const queuePages = [];
    cursor = null;
    do {
      const query = { limit: 1 };
      if (cursor) query.cursor = cursor;
      const response = await request(getApp())
        .get('/api/reviews/moderation-queue')
        .set('Authorization', authHeader(harness.moderatorId))
        .query(query)
        .expect(200);
      queuePages.push(...response.body.reviews);
      cursor = response.body.nextCursor;
      if (queuePages.length === 3) expect(cursor).toBeNull();
    } while (cursor);
    expect(queuePages.map((review) => review.id)).toEqual([
      visible[2].review.id,
      visible[1].review.id,
      visible[0].review.id,
    ]);
    expect(queuePages[0].reviewer.displayName).toBe(buyerRows[0].full_name);

    await request(getApp())
      .post(`/api/reviews/${visible[1].review.id}/hide`)
      .set('Authorization', authHeader(harness.adminId))
      .send({ reason: 'Hide this reported review.' })
      .expect(200);
    const publicAfterHide = await sellerReviewList(harness.fixture.userId).expect(200);
    expect(publicAfterHide.body.reviews.map((review) => review.id)).toEqual([
      visible[2].review.id,
      visible[0].review.id,
    ]);
    expect(publicAfterHide.body.reviews.map((review) => review.id)).not.toContain(waiting.body.id);
  });

  test('FR-27b: unrevealed buyer ratings are excluded until the seller review reveals the pair', async () => {
    const scenario = await createReviewScenario();
    const emptySellerAggregate = await reviews.getSellerRatingAggregate(scenario.sellerId);
    const emptyListingAggregate = await reviews.getListingItemRatingAggregate(scenario.listingId);
    expect(emptySellerAggregate).toEqual({
      average: null,
      count: 0,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    });
    expect(emptyListingAggregate).toEqual({
      average: null,
      count: 0,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    });

    const buyerReview = await submit(scenario, scenario.buyerId, {
      rating: 1,
      itemRating: 1,
    }).expect(201);
    expect(buyerReview.body.state).toBe('hidden_until_reveal');
    await expect(reviews.getSellerRatingAggregate(scenario.sellerId))
      .resolves.toEqual(emptySellerAggregate);
    await expect(reviews.getListingItemRatingAggregate(scenario.listingId))
      .resolves.toEqual(emptyListingAggregate);

    await submit(scenario, scenario.sellerId, { rating: 4 }).expect(201);
    const { rows } = await db.query(
      'SELECT state FROM reviews WHERE order_id = $1 ORDER BY direction',
      [scenario.orderId]
    );
    expect(rows).toEqual([
      { state: 'visible' },
      { state: 'visible' },
    ]);
    await expect(reviews.getSellerRatingAggregate(scenario.sellerId)).resolves.toEqual({
      average: null,
      count: 1,
      distribution: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0 },
    });
    await expect(reviews.getListingItemRatingAggregate(scenario.listingId)).resolves.toEqual({
      average: null,
      count: 1,
      distribution: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0 },
    });
  });

  test('FR-27b P35: seller and listing averages require three visible ratings and hide drops them below threshold', async () => {
    const reviewScenarios = [];
    for (let index = 0; index < 3; index += 1) {
      reviewScenarios.push(await createReviewScenario());
    }
    const listingId = reviewScenarios[0].listingId;
    const reviewOrderScenarios = [];
    const legacyOrderIds = [];

    async function readListing() {
      const response = await request(getApp())
        .get(`/api/discovery/listings/${listingId}`)
        .expect(200);
      return response.body;
    }

    try {
      for (const scenario of reviewScenarios) {
        const legacyOrder = { listingId, buyerId: scenario.buyerId };
        const orderId = await createLegacyOrder(harness, legacyOrder);
        scenario.legacyOrderId = orderId;
        legacyOrderIds.push(orderId);
        const reviewOrder = { ...scenario, orderId, listingId };
        await setDeliveryAge(reviewOrder, 1);
        reviewOrderScenarios.push(reviewOrder);
      }

      const empty = await readListing();
      expect(empty.seller).toMatchObject({
        averageRating: null,
        ratingCount: 0,
        ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      });
      expect(empty.itemRating).toEqual({
        average: null,
        count: 0,
        distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      });

      const cases = [
        { ratingCount: 1, fours: 1, fives: 0, average: null },
        { ratingCount: 2, fours: 1, fives: 1, average: null },
        { ratingCount: 3, fours: 1, fives: 2, average: '4.7' },
      ];
      const buyerReviews = [];
      for (let index = 0; index < reviewOrderScenarios.length; index += 1) {
        buyerReviews.push(await submitPair(reviewOrderScenarios[index], {
          buyerRating: index === 0 ? 4 : 5,
          itemRating: index === 0 ? 4 : 5,
        }));
        const detail = await readListing();
        const expected = cases[index];
        const distribution = {
          1: 0, 2: 0, 3: 0,
          4: expected.fours,
          5: expected.fives,
        };
        expect(detail.seller).toEqual({
          joinDate: expect.any(String),
          averageRating: expected.average,
          ratingCount: expected.ratingCount,
          ratingDistribution: distribution,
        });
        expect(detail.itemRating).toEqual({
          average: expected.average,
          count: expected.ratingCount,
          distribution,
        });
      }

      await request(getApp())
        .post(`/api/reviews/${buyerReviews[0].id}/hide`)
        .set('Authorization', authHeader(harness.adminId))
        .send({ reason: 'Hide one of three ratings.' })
        .expect(200);
      const afterHide = await readListing();
      expect(afterHide.seller).toMatchObject({
        averageRating: null,
        ratingCount: 2,
        ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 2 },
      });
      expect(afterHide.itemRating).toEqual({
        average: null,
        count: 2,
        distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 2 },
      });
    } finally {
      if (legacyOrderIds.length) {
        await db.query(
          'DELETE FROM review_reports WHERE review_id IN (SELECT id FROM reviews WHERE order_id = ANY($1::uuid[]))',
          [legacyOrderIds]
        );
        await db.query('DELETE FROM reviews WHERE order_id = ANY($1::uuid[])', [legacyOrderIds]);
        await db.query('DELETE FROM orders WHERE id = ANY($1::uuid[])', [legacyOrderIds]);
      }
      await db.query(
        'DELETE FROM offers WHERE conversation_id IN (SELECT id FROM conversations WHERE listing_id = $1)',
        [listingId]
      );
      await db.query('DELETE FROM conversations WHERE listing_id = $1', [listingId]);
    }
  });

  test('FR-27b P33: reports, Moderator hide, and Admin-only restore require audited reasons', async () => {
    const scenario = await createReviewScenario();
    const review = await submit(scenario, scenario.buyerId, {
      rating: 4,
      itemRating: 4,
      body: 'Reported review body.',
    }).expect(201);
    const reportPath = `/api/reviews/${review.body.id}/reports`;
    const hidePath = `/api/reviews/${review.body.id}/hide`;
    const restorePath = `/api/reviews/${review.body.id}/restore`;
    const reason300 = 'r'.repeat(300);

    await request(getApp()).post(reportPath).send({ reason: 'Valid report.' }).expect(401);
    await request(getApp())
      .post(reportPath)
      .set('Authorization', authHeader(harness.unrelatedBuyerId))
      .send({ reason: 'ab' })
      .expect(400);
    await request(getApp())
      .post(reportPath)
      .set('Authorization', authHeader(harness.unrelatedBuyerId))
      .send({ reason: 'r'.repeat(301) })
      .expect(400);
    const report = await request(getApp())
      .post(reportPath)
      .set('Authorization', authHeader(harness.unrelatedBuyerId))
      .send({ reason: reason300 })
      .expect(201);
    expect(report.body.reason).toBe(reason300);
    await request(getApp())
      .post(reportPath)
      .set('Authorization', authHeader(harness.unrelatedBuyerId))
      .send({ reason: 'Duplicate report.' })
      .expect(409);

    await request(getApp())
      .get('/api/reviews/moderation-queue')
      .set('Authorization', authHeader(harness.unrelatedBuyerId))
      .expect(403);
    const moderatorQueue = await request(getApp())
      .get('/api/reviews/moderation-queue')
      .set('Authorization', authHeader(harness.moderatorId))
      .expect(200);
    const moderatorEntry = moderatorQueue.body.reviews.find((entry) => entry.id === review.body.id);
    expect(moderatorQueue.body.reviews).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: review.body.id, reportCount: 1 }),
    ]));
    expect(moderatorEntry).toMatchObject({
      orderId: null,
      rating: null,
      itemRating: null,
      body: null,
      reviewer: null,
      reviewee: null,
    });
    const adminQueue = await request(getApp())
      .get('/api/reviews/moderation-queue')
      .set('Authorization', authHeader(harness.adminId))
      .expect(200);
    expect(adminQueue.body.reviews).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: review.body.id, body: 'Reported review body.' }),
    ]));

    await request(getApp())
      .post(hidePath)
      .set('Authorization', authHeader(harness.unrelatedBuyerId))
      .send({ reason: 'Unauthorized hide.' })
      .expect(403);
    const moderator = request(getApp())
      .post(hidePath)
      .set('Authorization', authHeader(harness.moderatorId));
    await moderator.send({}).expect(400);
    await request(getApp())
      .post(hidePath)
      .set('Authorization', authHeader(harness.moderatorId))
      .send({ reason: 'ab' })
      .expect(400);
    await request(getApp())
      .post(hidePath)
      .set('Authorization', authHeader(harness.moderatorId))
      .send({ reason: 'r'.repeat(301) })
      .expect(400);
    const hidden = await request(getApp())
      .post(hidePath)
      .set('Authorization', authHeader(harness.moderatorId))
      .send({ reason: reason300 })
      .expect(200);
    expect(hidden.body).toMatchObject({ reviewId: review.body.id, state: 'hidden_by_admin', reason: reason300 });
    expect(JSON.stringify(hidden.body)).not.toContain(harness.adminId);
    await request(getApp())
      .post(restorePath)
      .set('Authorization', authHeader(harness.moderatorId))
      .send({ reason: 'Moderator cannot restore.' })
      .expect(403);
    await request(getApp())
      .post(restorePath)
      .set('Authorization', authHeader(harness.adminId))
      .send({ reason: 'ab' })
      .expect(400);
    await request(getApp())
      .post(restorePath)
      .set('Authorization', authHeader(harness.adminId))
      .send({ reason: 'r'.repeat(301) })
      .expect(400);
    const restored = await request(getApp())
      .post(restorePath)
      .set('Authorization', authHeader(harness.adminId))
      .send({ reason: reason300 })
      .expect(200);
    expect(restored.body).toMatchObject({
      reviewId: review.body.id,
      state: 'hidden_until_reveal',
    });

    await request(getApp())
      .post(hidePath)
      .set('Authorization', authHeader(harness.adminId))
      .send({ reason: 'Admin hide.' })
      .expect(200);
    const { rows: auditRows } = await db.query(
      `SELECT actor_id, action, reason
         FROM review_moderation_events
        WHERE review_id = $1`,
      [review.body.id]
    );
    expect(auditRows).toHaveLength(3);
    expect(auditRows).toEqual(expect.arrayContaining([
      { actor_id: harness.moderatorId, action: 'hide', reason: reason300 },
      { actor_id: harness.adminId, action: 'restore', reason: reason300 },
      { actor_id: harness.adminId, action: 'hide', reason: 'Admin hide.' },
    ]));
  });

  test('FR-27b: order reads reveal only the author review until reveal and notifications contain no review content', async () => {
    const scenario = await createReviewScenario();
    const buyerBody = 'Private buyer review content.';
    const sellerBody = 'Private seller review content.';
    const buyerReview = await submit(scenario, scenario.buyerId, {
      rating: 5,
      itemRating: 4,
      body: buyerBody,
    }).expect(201);

    const buyerBeforeReveal = await request(getApp())
      .get(`/api/orders/${scenario.orderId}/summary`)
      .set('Authorization', authHeader(scenario.buyerId))
      .expect(200);
    expect(buyerBeforeReveal.body.myReview).toMatchObject({
      id: buyerReview.body.id,
      state: 'hidden_until_reveal',
      body: buyerBody,
    });
    expect(buyerBeforeReveal.body.reviewOfMe).toBeNull();
    const sellerBeforeReveal = await request(getApp())
      .get(`/api/orders/selling/${scenario.orderId}`)
      .set('Authorization', authHeader(scenario.sellerId))
      .expect(200);
    expect(sellerBeforeReveal.body.myReview).toBeNull();
    expect(sellerBeforeReveal.body.reviewOfMe).toBeNull();

    await processReviewNotification(scenario.orderId, events.REVIEW_WAITING);
    const { rows: waitingRows } = await db.query(
      `SELECT payload FROM notifications
        WHERE user_id = $1 AND dedupe_key = $2`,
      [scenario.sellerId, `review_waiting:${buyerReview.body.id}`]
    );
    expect(waitingRows).toHaveLength(1);
    expect(waitingRows[0].payload).toMatchObject({
      orderId: scenario.orderId,
      message: 'A review is waiting.',
    });
    expect(Object.keys(waitingRows[0].payload).sort()).toEqual(['href', 'message', 'orderId']);
    expect(JSON.stringify(waitingRows[0].payload)).not.toContain(buyerBody);
    expect(JSON.stringify(waitingRows[0].payload)).not.toContain(harness.adminId);

    await submit(scenario, scenario.sellerId, { rating: 4, body: sellerBody }).expect(201);
    const buyerAfterReveal = await request(getApp())
      .get(`/api/orders/${scenario.orderId}/summary`)
      .set('Authorization', authHeader(scenario.buyerId))
      .expect(200);
    expect(buyerAfterReveal.body.myReview).toMatchObject({ state: 'visible', body: buyerBody });
    expect(buyerAfterReveal.body.reviewOfMe).toMatchObject({ direction: 'seller_to_buyer', state: 'visible', body: sellerBody });
    const sellerAfterReveal = await request(getApp())
      .get(`/api/orders/selling/${scenario.orderId}`)
      .set('Authorization', authHeader(scenario.sellerId))
      .expect(200);
    expect(sellerAfterReveal.body.myReview).toMatchObject({ direction: 'seller_to_buyer', state: 'visible', body: sellerBody });
    expect(sellerAfterReveal.body.reviewOfMe).toMatchObject({ direction: 'buyer_to_seller', state: 'visible', body: buyerBody });
    expect(JSON.stringify(buyerAfterReveal.body)).not.toContain(harness.adminId);
    expect(JSON.stringify(sellerAfterReveal.body)).not.toContain(harness.adminId);

    await processReviewNotification(scenario.orderId, events.REVIEWS_REVEALED);
    const { rows: revealedRows } = await db.query(
      `SELECT user_id, payload FROM notifications
        WHERE user_id = ANY($1::uuid[]) AND dedupe_key = $2
        ORDER BY user_id`,
      [[scenario.buyerId, scenario.sellerId], `reviews_revealed:${scenario.orderId}`]
    );
    expect(revealedRows).toHaveLength(2);
    for (const row of revealedRows) {
      expect(row.payload.message).toBe('Reviews are now visible.');
      expect(Object.keys(row.payload).sort()).toEqual(['href', 'message', 'orderId']);
      expect(JSON.stringify(row.payload)).not.toContain(buyerBody);
      expect(JSON.stringify(row.payload)).not.toContain(sellerBody);
      expect(JSON.stringify(row.payload)).not.toContain(harness.adminId);
    }
    const sellerPublicReviews = await sellerReviewList(scenario.sellerId).expect(200);
    expect(sellerPublicReviews.body.reviews).toEqual([
      expect.objectContaining({ body: buyerBody, rating: 5 }),
    ]);
    expect(JSON.stringify(sellerPublicReviews.body)).not.toContain(sellerBody);
    expect(sellerPublicReviews.body.reviews[0]).not.toHaveProperty('direction');
  });
});
