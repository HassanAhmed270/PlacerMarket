const crypto = require('node:crypto');
const {
  authHeader,
  cleanupHarness,
  cleanupScenario,
  createHarness,
  createScenario,
  db,
  getApp,
  getBusinessDate,
  request,
  restoreHandoverTestEnvironment,
} = require('./delivery-handover.helpers');
const reviews = require('../../src/modules/reviews.service');

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
});
