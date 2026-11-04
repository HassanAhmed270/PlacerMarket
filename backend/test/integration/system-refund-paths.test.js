const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');
const app = require('../../src/app');
const { cachePolicy } = require('../../src/middleware/cachePolicy');
const db = require('../../src/db.service');
const errorHandler = require('../../src/middleware/errorHandler');
const queue = require('../../src/lib/queue');
const listingSearch = require('../../src/modules/listingSearch.service');
const { requireAuth } = require('../../src/middleware/auth');
const discovery = require('../../src/modules/discovery.service');
const escrowPayments = require('../../src/modules/escrowPayments.service');
const listings = require('../../src/modules/listings.service');
const revisions = require('../../src/modules/listingRevisions.service');
const pageSnapshots = require('../../src/modules/pageSnapshots.service');
const reservations = require('../../src/modules/reservations.service');
const { createEscrowPaymentsRouter } = require('../../src/routes/escrowPayments.routes');
const legacyOrdersRouter = require('../../src/routes/orders.routes');
const { buildSignedFakeEvent } = require('../../src/lib/adapters/fakePaymentGateway');
const { signAccessToken } = require('../../src/lib/jwt');
const { createFixture, cleanupListingProjections } = require('./fixtures');

const PARALLEL_RACE_REPETITIONS = 20;
const JWT_SECRET = 'system-refund-integration-access-secret';
const ADDRESS = {
  recipientName: 'Refund Test Recipient',
  phone: '+15551234567',
  cityId: '',
  addressLine1: '12 Refund Test Street',
};
const ENV_KEYS = [
  'NODE_ENV',
  'PAYMENTS_ENABLED',
  'JWT_ACCESS_SECRET',
  'PAYMENT_GATEWAY_PROVIDER',
  'FAKE_GATEWAY_WEBHOOK_SECRET',
  'PAYMENT_WEBHOOK_URL',
  'FAKE_GATEWAY_WEBHOOK_TOLERANCE_SECONDS',
  'PUBLIC_BASE_URL',
];

let originalEnvironment;
let fixture;
let buyerId;
let orderId;
let reservationId;
let paymentId;
let trackedFixtures;
let extraUserIds;
let projectionWorker;

function passThrough(_req, _res, next) {
  return next();
}

function createCancellationApp() {
  const testApp = express();
  testApp.use('/api', cachePolicy);
  testApp.use(express.json());
  testApp.use('/api/orders', createEscrowPaymentsRouter({
    auth: requireAuth,
    limiter: passThrough,
  }));
  testApp.use('/api/orders', legacyOrdersRouter);
  testApp.use(errorHandler);
  return testApp;
}

const cancellationApp = createCancellationApp();

function authHeader(userId) {
  return `Bearer ${signAccessToken(userId, { secret: JWT_SECRET })}`;
}

async function createBuyer(cityId) {
  const suffix = `${Date.now()}-${crypto.randomUUID()}`;
  const { rows } = await db.query(
    `INSERT INTO users (full_name, phone, password_hash, city_id, role)
     VALUES ($1, $2, 'fixture-hash', $3, 'buyer') RETURNING id`,
    [`System refund buyer ${suffix}`, `+1559${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 1000)}`, cityId]
  );
  extraUserIds.push(rows[0].id);
  return rows[0].id;
}

async function enableDeliveryCity(cityId) {
  await db.query(
    `INSERT INTO supported_delivery_cities (city_id, active)
     VALUES ($1, true) ON CONFLICT (city_id) DO UPDATE SET active = true`,
    [cityId]
  );
}

async function createScenario({ reuseMain = false } = {}) {
  const scenarioFixture = reuseMain
    ? fixture
    : await createFixture({ askingPrice: '1250.50', listingStatus: 'published' });
  const scenario = {
    fixture: scenarioFixture,
    buyerId: reuseMain ? buyerId : await createBuyer(scenarioFixture.cityId),
    orderId: null,
    reservationId: null,
    paymentId: null,
  };
  trackedFixtures.push(scenario);
  await enableDeliveryCity(scenarioFixture.cityId);
  const reservation = await reservations.buyListing(scenarioFixture.listingId, scenario.buyerId, {
    address: { ...ADDRESS, cityId: scenarioFixture.cityId },
  });
  scenario.orderId = reservation.orderId;
  scenario.reservationId = reservation.reservationId;
  const payment = await escrowPayments.createOrReusePayment({
    orderId: scenario.orderId,
    buyerId: scenario.buyerId,
  });
  scenario.paymentId = payment.paymentId;
  return scenario;
}

async function fundOrder(scenario) {
  await db.withTransaction(async (client) => {
    await client.query(
      `UPDATE reservations SET status = 'paid', paid_at = now()
       WHERE id = $1 AND status = 'active'`,
      [scenario.reservationId]
    );
    await client.query(
      `UPDATE orders
       SET status = 'funded', funded_at = now(),
           handover_deadline_at = now() + INTERVAL '72 hours'
       WHERE id = $1`,
      [scenario.orderId]
    );
    await client.query(
      `UPDATE payments SET status = 'succeeded', succeeded_at = now()
       WHERE id = $1`,
      [scenario.paymentId]
    );
  });
}

function cancelThroughApi(scenario, buyer = scenario.buyerId) {
  return request(cancellationApp)
    .post(`/api/orders/${scenario.orderId}/cancel`)
    .set('Authorization', authHeader(buyer))
    .send({ amount: '0.01', trigger: 'manual_admin' });
}

async function refundRows(scenario) {
  const { rows } = await db.query(
    `SELECT id, trigger, amount, status, idempotency_key, reason
     FROM refunds
     WHERE order_id = $1
     ORDER BY created_at, id`,
    [scenario.orderId]
  );
  return rows;
}

async function refundJobCount(scenario) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS total
     FROM pgboss.job job
     JOIN refunds refund ON job.data->>'refundId' = refund.id::text
     WHERE job.name = $1 AND refund.order_id = $2`,
    [queue.QUEUES.REFUNDS, scenario.orderId]
  );
  return rows[0].total;
}

async function createParallelRaceScenarios() {
  const scenarios = [trackedFixtures[0]];
  while (scenarios.length < PARALLEL_RACE_REPETITIONS) {
    scenarios.push(await createScenario());
  }
  return scenarios;
}

async function runParallelRace(scenarios, left, right) {
  const rounds = [];
  for (const scenario of scenarios) {
    rounds.push(await Promise.allSettled([left(scenario), right(scenario)]));
  }
  const results = rounds.flat();
  for (const result of results) {
    if (result.status === 'rejected') {
      expect(['55P03', '40P01']).not.toContain(result.reason?.code);
    }
  }
  return results;
}

async function receiveSignedSuccess(scenario) {
  const { rows: paymentRows } = await db.query(
    'SELECT provider_payment_id, amount, currency FROM payments WHERE id = $1',
    [scenario.paymentId]
  );
  const eventId = `system-refund-${crypto.randomUUID()}`;
  const signed = buildSignedFakeEvent({
    type: 'payment.succeeded',
    providerPaymentRef: paymentRows[0].provider_payment_id,
    amount: String(paymentRows[0].amount),
    currency: paymentRows[0].currency,
    eventId,
    now: new Date(),
  });
  await request(app)
    .post('/api/webhooks/payments/fake')
    .set('Content-Type', 'application/json')
    .set(signed.headers)
    .send(signed.rawBody.toString('utf8'))
    .expect(200, { received: true });
  const { rows } = await db.query(
    `SELECT id FROM webhook_inbox
     WHERE provider = 'fake' AND provider_event_id = $1`,
    [eventId]
  );
  return rows[0].id;
}

async function setupMainScenario() {
  fixture = await createFixture({ askingPrice: '1250.50', listingStatus: 'published' });
  trackedFixtures.push({
    fixture,
    buyerId: null,
    orderId: null,
    reservationId: null,
    paymentId: null,
  });
  buyerId = await createBuyer(fixture.cityId);
  trackedFixtures[0].buyerId = buyerId;
  await enableDeliveryCity(fixture.cityId);
  const reservation = await reservations.buyListing(fixture.listingId, buyerId, {
    address: { ...ADDRESS, cityId: fixture.cityId },
  });
  orderId = reservation.orderId;
  reservationId = reservation.reservationId;
  trackedFixtures[0].orderId = orderId;
  trackedFixtures[0].reservationId = reservationId;
  const payment = await escrowPayments.createOrReusePayment({ orderId, buyerId });
  paymentId = payment.paymentId;
  trackedFixtures[0].paymentId = paymentId;
  return trackedFixtures[0];
}

async function cleanupScenario(scenario) {
  const { rows: retainedRows } = scenario.orderId
    ? await db.query(
      'SELECT EXISTS (SELECT 1 FROM money_audit_events WHERE order_id = $1) AS retained',
      [scenario.orderId]
    )
    : { rows: [{ retained: false }] };
  if (retainedRows[0].retained) return true;

  if (scenario.fixture) {
    await db.query(
      `DELETE FROM webhook_inbox
       WHERE payment_id IN (
         SELECT payment.id
         FROM payments payment
         JOIN orders order_row ON order_row.id = payment.order_id
         WHERE order_row.listing_id = $1
       )`,
      [scenario.fixture.listingId]
    );
    await db.query(
      'DELETE FROM refunds WHERE order_id IN (SELECT id FROM orders WHERE listing_id = $1)',
      [scenario.fixture.listingId]
    );
    await db.query(
      'DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE listing_id = $1)',
      [scenario.fixture.listingId]
    );
    await db.query('DELETE FROM orders WHERE listing_id = $1', [scenario.fixture.listingId]);
    await db.query(
      `DELETE FROM offers WHERE conversation_id IN (
         SELECT id FROM conversations WHERE listing_id = $1
       )`,
      [scenario.fixture.listingId]
    );
    await db.query('DELETE FROM conversations WHERE listing_id = $1', [scenario.fixture.listingId]);
  }
  if (scenario.fixture) {
    await db.query('DELETE FROM reservations WHERE listing_id = $1', [scenario.fixture.listingId]);
  }
  if (scenario.fixture) {
    await db.query('DELETE FROM supported_delivery_cities WHERE city_id = $1', [scenario.fixture.cityId]);
  }
  return false;
}

beforeAll(async () => {
  projectionWorker = queue.createQueueClient({
    connectionString: process.env.DATABASE_URL,
    worker: true,
  });
  await projectionWorker.start();
  await projectionWorker.boss.work(
    queue.QUEUES.LISTING_SEARCH,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 0.5, notifyPollingIntervalSeconds: 0.5 },
    async ([job]) => listingSearch.processListingSearchJob(job.data)
  );
  await projectionWorker.boss.work(
    queue.QUEUES.PAGE_SNAPSHOTS,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 0.5, notifyPollingIntervalSeconds: 0.5 },
    async ([job]) => pageSnapshots.processSnapshotJob(job.data)
  );
});

afterAll(async () => {
  if (projectionWorker) await projectionWorker.stop();
});

beforeEach(async () => {
  originalEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = 'test';
  process.env.PAYMENTS_ENABLED = '1';
  process.env.JWT_ACCESS_SECRET = JWT_SECRET;
  process.env.PAYMENT_GATEWAY_PROVIDER = 'fake';
  process.env.FAKE_GATEWAY_WEBHOOK_SECRET =
    `system-refund-fake-secret-${crypto.randomUUID()}`;
  process.env.PAYMENT_WEBHOOK_URL = 'http://127.0.0.1:39991/api/webhooks/payments/fake';
  process.env.FAKE_GATEWAY_WEBHOOK_TOLERANCE_SECONDS = '300';
  process.env.PUBLIC_BASE_URL = 'http://localhost:5173';
  trackedFixtures = [];
  extraUserIds = [];
  const scenario = await setupMainScenario();
  fixture = scenario.fixture;
  buyerId = scenario.buyerId;
  orderId = scenario.orderId;
  reservationId = scenario.reservationId;
  paymentId = scenario.paymentId;
});

afterEach(async () => {
  try {
    const fixturesToClean = [];
    const retainedListingIds = new Set();
    for (const scenario of trackedFixtures || []) {
      if (await cleanupScenario(scenario)) retainedListingIds.add(scenario.fixture.listingId);
      else fixturesToClean.push(scenario.fixture);
    }
    if (retainedListingIds.size) {
      const listingIds = [...retainedListingIds];
      for (const listingId of listingIds) await cleanupListingProjections(listingId);
      await db.query(
        `UPDATE listings SET status = 'unpublished'
         WHERE id = ANY($1::uuid[]) AND status = 'published'`,
        [listingIds]
      );
      await db.query('DELETE FROM listing_search WHERE listing_id = ANY($1::uuid[])', [listingIds]);
    }
    if (extraUserIds?.length) {
      await db.query(
        `DELETE FROM users user_row
         WHERE id = ANY($1::uuid[])
           AND NOT EXISTS (
             SELECT 1 FROM orders WHERE buyer_id = user_row.id OR seller_id = user_row.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM money_audit_events
             WHERE actor_id = user_row.id OR requested_by = user_row.id OR approved_by = user_row.id
           )`,
        [extraUserIds]
      );
    }
    for (const cleanup of fixturesToClean) await cleanup.cleanup();
  } finally {
    jest.restoreAllMocks();
    for (const [key, value] of Object.entries(originalEnvironment || {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

describe('FR-33a buyer cancellation', () => {
  test('FR-33a: cancelling an unpaid reserved order makes it available without a refund', async () => {
    await db.query(
      'UPDATE orders SET status = $1 WHERE id = $2',
      ['reserved', orderId]
    );
    await db.query(
      'UPDATE payments SET status = $1 WHERE id = $2',
      ['failed', paymentId]
    );
    const response = await cancelThroughApi(trackedFixtures[0]).expect(200);

    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toEqual({ orderId, status: 'cancelled', refund: null });
    const { rows } = await db.query(
      `SELECT orders.status AS order_status, reservations.status AS reservation_status,
              reservations.end_reason
       FROM orders JOIN reservations ON reservations.id = orders.reservation_id
       WHERE orders.id = $1`,
      [orderId]
    );
    expect(rows[0]).toEqual({
      order_status: 'cancelled',
      reservation_status: 'cancelled',
      end_reason: 'buyer_cancelled',
    });
    expect(await refundRows(trackedFixtures[0])).toEqual([]);
    expect(await discovery.getListingStatus(fixture.listingId)).toMatchObject({
      status: 'available',
      available: true,
    });
  });

  test('FR-33a: cancelling an unpaid order cancels its open payment and restores discovery availability', async () => {
    await cancelThroughApi(trackedFixtures[0]).expect(200, {
      orderId,
      status: 'cancelled',
      refund: null,
    });
    const { rows } = await db.query(
      `SELECT status FROM payments WHERE id = $1`,
      [paymentId]
    );
    expect(rows).toEqual([{ status: 'cancelled' }]);
    expect(await refundRows(trackedFixtures[0])).toEqual([]);
    expect(await discovery.getListingStatus(fixture.listingId)).toMatchObject({
      status: 'available',
      available: true,
    });
  });

  test('FR-33a, FR-61: a late capture after buyer cancellation creates the existing late-refund intent', async () => {
    const scenario = trackedFixtures[0];
    await cancelThroughApi(scenario).expect(200);
    const inboxId = await receiveSignedSuccess(scenario);
    await escrowPayments.processPaymentWebhookJob({ webhookInboxId: inboxId });

    expect(await refundRows(scenario)).toEqual([expect.objectContaining({
      trigger: 'system_expiry',
      amount: '1550.50',
      status: 'requested',
      idempotency_key: `refund:${paymentId}:late`,
      reason: 'Late payment after reservation ended',
    })]);
    expect(await refundJobCount(scenario)).toBe(1);
    const { rows } = await db.query(
      `SELECT orders.status AS order_status, reservations.status AS reservation_status,
              payments.status AS payment_status
       FROM orders
       JOIN reservations ON reservations.id = orders.reservation_id
       JOIN payments ON payments.order_id = orders.id
       WHERE orders.id = $1`,
      [orderId]
    );
    expect(rows[0]).toEqual({
      order_status: 'cancelled',
      reservation_status: 'cancelled',
      payment_status: 'late',
    });
  });

  test('FR-33a: cancelling a funded order requests the full item-plus-delivery refund once and the job succeeds', async () => {
    const scenario = trackedFixtures[0];
    await fundOrder(scenario);
    const response = await cancelThroughApi(scenario).expect(200);

    expect(response.body).toEqual({
      orderId,
      status: 'cancelled',
      refund: { status: 'requested' },
    });
    expect(await refundRows(scenario)).toEqual([expect.objectContaining({
      trigger: 'system_cancel',
      amount: '1550.50',
      status: 'requested',
      idempotency_key: `refund:${paymentId}:cancel`,
      reason: 'Buyer cancelled before courier handover',
    })]);
    expect(await refundJobCount(scenario)).toBe(1);
    const { rows: stateRows } = await db.query(
      `SELECT orders.status AS order_status, reservations.status AS reservation_status,
              reservations.end_reason, payments.status AS payment_status
       FROM orders
       JOIN reservations ON reservations.id = orders.reservation_id
       JOIN payments ON payments.order_id = orders.id
       WHERE orders.id = $1`,
      [orderId]
    );
    expect(stateRows[0]).toEqual({
      order_status: 'cancelled',
      reservation_status: 'released',
      end_reason: 'buyer_cancelled',
      payment_status: 'succeeded',
    });
    expect(await discovery.getListingStatus(fixture.listingId)).toMatchObject({
      status: 'available',
      available: true,
    });

    const [refund] = await refundRows(scenario);
    const gateway = {
      createRefund: jest.fn(async ({ providerPaymentRef, amount }) => ({
        providerPaymentRef,
        providerRefundRef: `refund-${crypto.randomUUID()}`,
        amount,
        status: 'succeeded',
      })),
    };
    await expect(escrowPayments.processRefundJob({ refundId: refund.id, gateway }))
      .resolves.toEqual({ outcome: 'succeeded', refundId: refund.id });
    expect(gateway.createRefund).toHaveBeenCalledTimes(1);
    await expect(refundRows(scenario)).resolves.toEqual([
      expect.objectContaining({ status: 'succeeded', amount: '1550.50' }),
    ]);
  });

  test('FR-33a: repeating a buyer cancellation returns the same result without another refund', async () => {
    const scenario = trackedFixtures[0];
    await fundOrder(scenario);
    const first = await cancelThroughApi(scenario).expect(200);
    const repeated = await cancelThroughApi(scenario).expect(200);

    expect(repeated.body).toEqual(first.body);
    expect(await refundRows(scenario)).toHaveLength(1);
  });

  test('FR-33a: a different buyer receives 404 and handed-over orders receive 409', async () => {
    const otherBuyer = await createBuyer(fixture.cityId);
    await cancelThroughApi(trackedFixtures[0], otherBuyer).expect(404);

    await fundOrder(trackedFixtures[0]);
    await db.query('UPDATE orders SET handed_over_at = now() WHERE id = $1', [orderId]);
    await cancelThroughApi(trackedFixtures[0]).expect(409);
    expect(await refundRows(trackedFixtures[0])).toEqual([]);
  });

  test('FR-33a: reservation-less orders continue through the legacy cancellation route', async () => {
    const { rows: conversationRows } = await db.query(
      `INSERT INTO conversations (listing_id, buyer_id, seller_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [fixture.listingId, buyerId, fixture.userId]
    );
    const { rows: offerRows } = await db.query(
      `INSERT INTO offers (conversation_id, listing_id, proposed_by, amount, status)
       VALUES ($1, $2, $3, 1250.50, 'accepted') RETURNING id`,
      [conversationRows[0].id, fixture.listingId, buyerId]
    );
    const { rows: orderRows } = await db.query(
      `INSERT INTO orders
         (accepted_offer_id, listing_id, buyer_id, seller_id, agreed_item_price,
          delivery_fee, delivery_address, payment_method_preference, status)
       VALUES ($1, $2, $3, $4, 1250.50, 0, '', 'cash', 'bag')
       RETURNING id`,
      [offerRows[0].id, fixture.listingId, buyerId, fixture.userId]
    );
    const response = await request(cancellationApp)
      .post(`/api/orders/${orderRows[0].id}/cancel`)
      .set('Authorization', authHeader(buyerId))
      .expect(200);

    expect(response.body.status).toBe('cancelled');
    expect(response.body).not.toHaveProperty('refund');
  });

  test('FR-33a: the cancellation route returns 503 while payments are disabled', async () => {
    process.env.PAYMENTS_ENABLED = '0';
    await request(app)
      .post(`/api/orders/${orderId}/cancel`)
      .expect(503)
      .expect('Cache-Control', 'private, no-store')
      .expect({ error: 'Payments are currently disabled.', code: 'payments_disabled' });
  });
});

describe('FR-63a moderator take-down', () => {
  test('FR-63a: an unpaid reserved listing take-down releases the reservation without a refund', async () => {
    const scenario = trackedFixtures[0];
    await listings.rejectOrUnpublishListing(fixture.listingId, {
      reviewerId: fixture.userId,
      reason: 'Moderator take-down',
    });

    const { rows } = await db.query(
      `SELECT orders.status AS order_status, reservations.status AS reservation_status,
              reservations.end_reason, payments.status AS payment_status
       FROM orders
       JOIN reservations ON reservations.id = orders.reservation_id
       JOIN payments ON payments.order_id = orders.id
       WHERE orders.id = $1`,
      [orderId]
    );
    expect(rows[0]).toEqual({
      order_status: 'cancelled',
      reservation_status: 'released',
      end_reason: 'listing_taken_down',
      payment_status: 'cancelled',
    });
    expect(await refundRows(scenario)).toEqual([]);
  });

  test('FR-63a: a funded listing take-down requests only one full system cancellation refund', async () => {
    const scenario = trackedFixtures[0];
    await fundOrder(scenario);
    await listings.rejectOrUnpublishListing(fixture.listingId, {
      reviewerId: fixture.userId,
      reason: 'Moderator take-down',
    });

    expect(await refundRows(scenario)).toEqual([expect.objectContaining({
      trigger: 'system_cancel',
      amount: '1550.50',
      status: 'requested',
      idempotency_key: `refund:${paymentId}:takedown`,
      reason: 'Listing taken down',
    })]);
    expect(await refundJobCount(scenario)).toBe(1);
    const { rows } = await db.query(
      `SELECT orders.status AS order_status, reservations.status AS reservation_status,
              reservations.end_reason
       FROM orders JOIN reservations ON reservations.id = orders.reservation_id
       WHERE orders.id = $1`,
      [orderId]
    );
    expect(rows[0]).toEqual({
      order_status: 'cancelled',
      reservation_status: 'released',
      end_reason: 'listing_taken_down',
    });
  });

  test('FR-63a: a post-handover take-down leaves the order untouched and records one manual-review audit', async () => {
    const scenario = trackedFixtures[0];
    await fundOrder(scenario);
    await db.query('UPDATE orders SET handed_over_at = now() WHERE id = $1', [orderId]);

    await listings.rejectOrUnpublishListing(fixture.listingId, {
      reviewerId: fixture.userId,
      reason: 'Moderator take-down',
    });

    const { rows } = await db.query(
      `SELECT orders.status AS order_status, reservations.status AS reservation_status,
              payments.status AS payment_status,
              (SELECT count(*)::int FROM refunds WHERE order_id = $1) AS refund_count,
              (SELECT count(*)::int FROM money_audit_events
               WHERE order_id = $1 AND action = 'takedown_after_handover') AS audit_count
       FROM orders
       JOIN reservations ON reservations.id = orders.reservation_id
       JOIN payments ON payments.order_id = orders.id
       WHERE orders.id = $1`,
      [orderId]
    );
    expect(rows[0]).toEqual({
      order_status: 'funded',
      reservation_status: 'paid',
      payment_status: 'succeeded',
      refund_count: 0,
      audit_count: 1,
    });
  });
});

describe('FR-72 handover timeout', () => {
  test('FR-72: the exported timeout function is not due before the database deadline', async () => {
    await fundOrder(trackedFixtures[0]);
    await expect(escrowPayments.refundUnhandedOverOrder({ orderId }))
      .resolves.toEqual({ outcome: 'not_due' });
    expect(await refundRows(trackedFixtures[0])).toEqual([]);
  });

  test('FR-72: the due timeout requests one full refund and ten parallel calls remain idempotent', async () => {
    const scenario = trackedFixtures[0];
    await fundOrder(scenario);
    await db.query(
      `UPDATE orders
       SET funded_at = now() - INTERVAL '73 hours',
           handover_deadline_at = (now() - INTERVAL '73 hours') + INTERVAL '72 hours'
       WHERE id = $1`,
      [orderId]
    );
    const outcomes = await Promise.all(Array.from({ length: 10 }, () =>
      escrowPayments.refundUnhandedOverOrder({ orderId })));

    expect(outcomes.filter((result) => result.outcome === 'refunded')).toHaveLength(1);
    expect(await refundRows(scenario)).toEqual([expect.objectContaining({
      trigger: 'system_handover_timeout',
      amount: '1550.50',
      status: 'requested',
      idempotency_key: `refund:${paymentId}:handover_timeout`,
    })]);
    expect(await refundJobCount(scenario)).toBe(1);
    const { rows } = await db.query(
      `SELECT orders.status AS order_status, reservations.status AS reservation_status,
              reservations.end_reason
       FROM orders JOIN reservations ON reservations.id = orders.reservation_id
       WHERE orders.id = $1`,
      [orderId]
    );
    expect(rows[0]).toEqual({
      order_status: 'cancelled',
      reservation_status: 'released',
      end_reason: 'handover_timeout',
    });
  });

  test('FR-72: the handover sweep refunds only due, unhanded-over funded orders once', async () => {
    const due = trackedFixtures[0];
    const notDue = await createScenario();
    const handedOver = await createScenario();
    for (const scenario of [due, notDue, handedOver]) await fundOrder(scenario);
    await db.query(
      `UPDATE orders
       SET funded_at = now() - INTERVAL '73 hours',
           handover_deadline_at = (now() - INTERVAL '73 hours') + INTERVAL '72 hours'
       WHERE id = $1`,
      [due.orderId]
    );
    await db.query(
      `UPDATE orders
       SET funded_at = now() - INTERVAL '73 hours',
           handover_deadline_at = (now() - INTERVAL '73 hours') + INTERVAL '72 hours',
           handed_over_at = now()
       WHERE id = $1`,
      [handedOver.orderId]
    );

    await expect(escrowPayments.sweepUnhandedOverOrders({ logger: { info: jest.fn() } }))
      .resolves.toEqual({ processed: 1, skipped: 0, failed: 0 });
    expect(await refundRows(due)).toEqual([expect.objectContaining({
      trigger: 'system_handover_timeout',
      status: 'requested',
      idempotency_key: `refund:${due.paymentId}:handover_timeout`,
    })]);
    expect(await refundRows(notDue)).toEqual([]);
    expect(await refundRows(handedOver)).toEqual([]);
  });

  test('FR-72: parallel handover sweeps and buyer cancellation create one timeout refund', async () => {
    const scenario = trackedFixtures[0];
    await fundOrder(scenario);
    await db.query(
      `UPDATE orders
       SET funded_at = now() - INTERVAL '73 hours',
           handover_deadline_at = (now() - INTERVAL '73 hours') + INTERVAL '72 hours'
       WHERE id = $1`,
      [scenario.orderId]
    );

    const [buyerResult, firstSweep, secondSweep] = await Promise.all([
      cancelThroughApi(scenario),
      escrowPayments.sweepUnhandedOverOrders({ logger: { info: jest.fn() } }),
      escrowPayments.sweepUnhandedOverOrders({ logger: { info: jest.fn() } }),
    ]);
    expect([200, 409]).toContain(buyerResult.status);
    expect(firstSweep.failed + secondSweep.failed).toBe(0);
    expect(firstSweep.processed + secondSweep.processed).toBeLessThanOrEqual(1);
    expect(await refundRows(scenario)).toHaveLength(1);
    expect(['system_handover_timeout', 'system_cancel']).toContain((await refundRows(scenario))[0].trigger);
  });

  test('FR-72: a handed-over order is skipped by the timeout function', async () => {
    const scenario = trackedFixtures[0];
    await fundOrder(scenario);
    await db.query(
      `UPDATE orders
       SET funded_at = now() - INTERVAL '73 hours',
           handover_deadline_at = (now() - INTERVAL '73 hours') + INTERVAL '72 hours',
           handed_over_at = now()
       WHERE id = $1`,
      [orderId]
    );
    await expect(escrowPayments.refundUnhandedOverOrder({ orderId }))
      .resolves.toEqual({ outcome: 'not_due' });
    expect(await refundRows(scenario)).toEqual([]);
  });

  test('FR-33a, FR-72: ten buyer-cancel and timeout races create one refund and a consistent cancellation', async () => {
    for (let index = 0; index < 10; index += 1) {
      const scenario = index === 0
        ? trackedFixtures[0]
        : await createScenario({ reuseMain: true });
      await fundOrder(scenario);
      await db.query(
        `UPDATE orders
         SET funded_at = now() - INTERVAL '73 hours',
             handover_deadline_at = (now() - INTERVAL '73 hours') + INTERVAL '72 hours'
         WHERE id = $1`,
        [scenario.orderId]
      );
      const [cancelResponse, timeoutResult] = await Promise.all([
        cancelThroughApi(scenario),
        escrowPayments.sweepUnhandedOverOrders({ logger: { info: jest.fn() } }),
      ]);
      expect([200, 409]).toContain(cancelResponse.status);
      expect(timeoutResult.failed).toBe(0);
      expect(timeoutResult.processed + timeoutResult.skipped).toBeGreaterThanOrEqual(1);
      expect(await refundRows(scenario)).toHaveLength(1);
      const { rows } = await db.query(
        `SELECT orders.status AS order_status, reservations.status AS reservation_status,
                reservations.end_reason
         FROM orders JOIN reservations ON reservations.id = orders.reservation_id
         WHERE orders.id = $1`,
        [scenario.orderId]
      );
      expect(rows[0].order_status).toBe('cancelled');
      expect(['buyer_cancelled', 'handover_timeout']).toContain(rows[0].end_reason);
      expect(rows[0].reservation_status).toBe('released');
    }
  });
});

describe('P4-S7a parallel money-lock races', () => {
  test('Buy against buyer cancel has one consistent live reservation outcome', async () => {
    const scenarios = await createParallelRaceScenarios();
    const results = await runParallelRace(scenarios,
      (scenario) => reservations.buyListing(scenario.fixture.listingId, scenario.buyerId, {
        address: { ...ADDRESS, cityId: scenario.fixture.cityId },
      }),
      (scenario) => cancelThroughApi(scenario)
    );
    const buys = results.filter((_, index) => index % 2 === 0);
    const cancellations = results.filter((_, index) => index % 2 === 1);
    for (const result of buys) {
      if (result.status === 'fulfilled') continue;
      expect(result.reason.statusCode).toBe(409);
    }
    expect(cancellations.filter((result) => result.status === 'fulfilled')
      .every((result) => result.value.status === 200)).toBe(true);
    expect(cancellations.filter((result) => result.status === 'rejected')).toHaveLength(0);

    for (const scenario of scenarios) {
      const { rows } = await db.query(
        `SELECT count(*)::int AS live
         FROM reservations
         WHERE listing_id = $1 AND (status = 'paid' OR (status = 'active' AND expires_at > now()))`,
        [scenario.fixture.listingId]
      );
      expect(rows[0].live).toBeLessThanOrEqual(1);
      expect(await refundRows(scenario)).toHaveLength(0);
    }
  });

  test('Buy against a stale expired reservation and late webhook preserves one capture refund', async () => {
    const scenarios = await createParallelRaceScenarios();
    for (const scenario of scenarios) {
      await db.query(
        'UPDATE reservations SET expires_at = now() - INTERVAL \'1 second\' WHERE id = $1',
        [scenario.reservationId]
      );
      scenario.webhookInboxId = await receiveSignedSuccess(scenario);
    }
    const results = await runParallelRace(scenarios,
      (scenario) => reservations.buyListing(scenario.fixture.listingId, scenario.buyerId, {
        address: { ...ADDRESS, cityId: scenario.fixture.cityId },
      }),
      (scenario) => escrowPayments.processPaymentWebhookJob({ webhookInboxId: scenario.webhookInboxId })
    );
    const buys = results.filter((_, index) => index % 2 === 0);
    expect(buys.map((result) => result.status)).toEqual(Array(20).fill('fulfilled'));
    for (const scenario of scenarios) {
      const refunds = await refundRows(scenario);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ trigger: 'system_expiry', amount: '1550.50' });
      const { rows } = await db.query(
        `SELECT orders.status AS order_status, reservations.status AS reservation_status,
                payments.status AS payment_status
         FROM orders
         JOIN reservations ON reservations.id = orders.reservation_id
         JOIN payments ON payments.order_id = orders.id
         WHERE orders.id = $1`,
        [scenario.orderId]
      );
      expect(rows[0]).toEqual({
        order_status: 'cancelled',
        reservation_status: 'expired',
        payment_status: 'late',
      });
      const { rows: liveRows } = await db.query(
        `SELECT count(*)::int AS live
         FROM reservations
         WHERE listing_id = $1 AND (status = 'paid' OR (status = 'active' AND expires_at > now()))`,
        [scenario.fixture.listingId]
      );
      expect(liveRows[0].live).toBe(1);
    }
  });

  test('funding webhook against admin take-down ends unpublished with at most one refund', async () => {
    const scenarios = await createParallelRaceScenarios();
    for (const scenario of scenarios) scenario.webhookInboxId = await receiveSignedSuccess(scenario);
    const results = await runParallelRace(scenarios,
      (scenario) => escrowPayments.processPaymentWebhookJob({ webhookInboxId: scenario.webhookInboxId }),
      (scenario) => listings.rejectOrUnpublishListing(scenario.fixture.listingId, {
        reviewerId: scenario.fixture.userId, reason: 'Concurrent lock-order test',
      })
    );
    expect(results.filter((_, index) => index % 2 === 0)
      .filter((result) => result.status === 'rejected')).toHaveLength(0);
    for (const result of results.filter((result, index) => index % 2 === 1 && result.status === 'rejected')) {
      expect([400, 409]).toContain(result.reason.statusCode);
    }
    for (const scenario of scenarios) {
      const { rows } = await db.query(
        `SELECT listings.status AS listing_status, orders.status AS order_status,
                reservations.status AS reservation_status, payments.status AS payment_status
         FROM listings
         JOIN orders ON orders.listing_id = listings.id
         JOIN reservations ON reservations.id = orders.reservation_id
         JOIN payments ON payments.order_id = orders.id
         WHERE listings.id = $1`,
        [scenario.fixture.listingId]
      );
      expect(rows[0]).toMatchObject({
        listing_status: 'unpublished',
        order_status: 'cancelled',
        reservation_status: 'released',
      });
      expect(['succeeded', 'late']).toContain(rows[0].payment_status);
      expect(await refundRows(scenario)).toHaveLength(1);
    }
  });

  test('buyer cancel against take-down leaves a single canceled order outcome', async () => {
    const scenarios = await createParallelRaceScenarios();
    const results = await runParallelRace(scenarios,
      (scenario) => cancelThroughApi(scenario),
      (scenario) => listings.rejectOrUnpublishListing(scenario.fixture.listingId, {
        reviewerId: scenario.fixture.userId, reason: 'Concurrent lock-order test',
      })
    );
    const cancellations = results.filter((_, index) => index % 2 === 0);
    expect(cancellations.filter((result) => result.status === 'fulfilled')
      .every((result) => [200, 409].includes(result.value.status))).toBe(true);
    expect(cancellations.filter((result) => result.status === 'rejected')).toHaveLength(0);
    for (const result of results.filter((result, index) => index % 2 === 1 && result.status === 'rejected')) {
      expect([400, 409]).toContain(result.reason.statusCode);
    }
    for (const scenario of scenarios) {
      const { rows } = await db.query(
        `SELECT listings.status AS listing_status, orders.status AS order_status,
                reservations.status AS reservation_status, reservations.end_reason
         FROM listings
         JOIN orders ON orders.listing_id = listings.id
         JOIN reservations ON reservations.id = orders.reservation_id
         WHERE listings.id = $1`,
        [scenario.fixture.listingId]
      );
      expect(rows[0].listing_status).toBe('unpublished');
      expect(rows[0].order_status).toBe('cancelled');
      expect(['cancelled', 'released']).toContain(rows[0].reservation_status);
      expect(['buyer_cancelled', 'listing_taken_down']).toContain(rows[0].end_reason);
      expect(await refundRows(scenario)).toHaveLength(0);
    }
  });

  test('buyer cancel against timeout function completes 20 parallel pairs with one refund', async () => {
    const scenarios = await createParallelRaceScenarios();
    await Promise.all(scenarios.map(async (scenario) => {
      await fundOrder(scenario);
      await db.query(
        `UPDATE orders
         SET funded_at = now() - INTERVAL '73 hours',
             handover_deadline_at = (now() - INTERVAL '73 hours') + INTERVAL '72 hours'
         WHERE id = $1`,
        [scenario.orderId]
      );
    }));
    const results = await runParallelRace(scenarios,
      (scenario) => cancelThroughApi(scenario),
      (scenario) => escrowPayments.refundUnhandedOverOrder({ orderId: scenario.orderId })
    );
    for (const result of results.filter((_, index) => index % 2 === 0)) {
      if (result.status === 'fulfilled') expect([200, 409]).toContain(result.value.status);
      else expect([400, 409]).toContain(result.reason.statusCode);
    }
    for (const result of results.filter((_, index) => index % 2 === 1)) {
      if (result.status === 'fulfilled') expect(['refunded', 'not_due', 'skipped']).toContain(result.value.outcome);
    }
    for (const scenario of scenarios) {
      expect(await refundRows(scenario)).toHaveLength(1);
      const { rows } = await db.query(
        `SELECT orders.status AS order_status, reservations.status AS reservation_status,
                reservations.end_reason
         FROM orders JOIN reservations ON reservations.id = orders.reservation_id
         WHERE orders.id = $1`,
        [scenario.orderId]
      );
      expect(rows[0].order_status).toBe('cancelled');
      expect(rows[0].reservation_status).toBe('released');
      expect(['buyer_cancelled', 'handover_timeout']).toContain(rows[0].end_reason);
    }
  });

  test('revision approval against Buy has one consistent reservation and content state', async () => {
    const scenarios = await createParallelRaceScenarios();
    for (const scenario of scenarios) {
      await escrowPayments.cancelReservationOrder({ orderId: scenario.orderId, buyerId: scenario.buyerId });
      await db.query(
        'UPDATE listings SET published_at = COALESCE(published_at, now()) WHERE id = $1',
        [scenario.fixture.listingId]
      );
      const revision = await revisions.submitListingRevision(
        scenario.fixture.listingId, scenario.fixture.userId, { askingPrice: 250 }
      );
      expect(revision.status).toBe('pending_review');
      scenario.revisionId = revision.id;
    }

    const results = await runParallelRace(scenarios,
      (scenario) => revisions.approveListingRevision(scenario.revisionId, scenario.fixture.otherUserId),
      (scenario) => reservations.buyListing(scenario.fixture.listingId, scenario.buyerId, {
        address: { ...ADDRESS, cityId: scenario.fixture.cityId },
      })
    );
    for (const result of results.filter((result, index) => index % 2 === 0 && result.status === 'rejected')) {
      expect(result.reason.statusCode).toBe(409);
    }
    for (const result of results.filter((result, index) => index % 2 === 1 && result.status === 'rejected')) {
      expect(result.reason.statusCode).toBe(409);
    }
    for (const scenario of scenarios) {
      const { rows: reservationRows } = await db.query(
        `SELECT count(*)::int AS live
         FROM reservations
         WHERE listing_id = $1 AND (status = 'paid' OR (status = 'active' AND expires_at > now()))`,
        [scenario.fixture.listingId]
      );
      expect(reservationRows[0].live).toBe(1);
      const { rows: revisionRows } = await db.query(
        'SELECT status FROM listing_revisions WHERE id = $1',
        [scenario.revisionId]
      );
      expect(['approved', 'pending_review']).toContain(revisionRows[0].status);
    }
  });
});

describe('FR-33a, FR-61 capture race', () => {
  test('FR-33a, FR-61: ten buyer-cancel and webhook races always refund one captured payment', async () => {
    for (let index = 0; index < 10; index += 1) {
      const scenario = index === 0
        ? trackedFixtures[0]
        : await createScenario({ reuseMain: true });
      const inboxId = await receiveSignedSuccess(scenario);
      const [cancelResponse, webhookResult] = await Promise.all([
        cancelThroughApi(scenario),
        escrowPayments.processPaymentWebhookJob({ webhookInboxId: inboxId }),
      ]);
      expect(cancelResponse.status).toBe(200);
      expect(webhookResult).toEqual({ outcome: 'processed' });
      const refunds = await refundRows(scenario);
      expect(refunds).toHaveLength(1);
      expect(refunds[0].amount).toBe('1550.50');
      expect(['system_cancel', 'system_expiry']).toContain(refunds[0].trigger);
      const { rows } = await db.query(
        `SELECT orders.status AS order_status, reservations.status AS reservation_status,
                payments.status AS payment_status
         FROM orders
         JOIN reservations ON reservations.id = orders.reservation_id
         JOIN payments ON payments.order_id = orders.id
         WHERE orders.id = $1`,
        [scenario.orderId]
      );
      expect(rows[0].order_status).toBe('cancelled');
      expect(['cancelled', 'released']).toContain(rows[0].reservation_status);
      expect(['late', 'succeeded']).toContain(rows[0].payment_status);
    }
  });
});
