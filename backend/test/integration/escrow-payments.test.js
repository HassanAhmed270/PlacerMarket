const express = require('express');
const request = require('supertest');
const db = require('../../src/db.service');
const routes = require('../../src/routes');
const { cachePolicy } = require('../../src/middleware/cachePolicy');
const errorHandler = require('../../src/middleware/errorHandler');
const users = require('../../src/modules/users.service');
const reservations = require('../../src/modules/reservations.service');
const escrowPayments = require('../../src/modules/escrowPayments.service');
const paymentGateway = require('../../src/lib/adapters/paymentGateway');
const { signAccessToken } = require('../../src/lib/jwt');
const { createEscrowPaymentsRouter } = require('../../src/routes/escrowPayments.routes');
const { createFakeGatewayRouter } = require('../../src/routes/fakeGateway.routes');
const { createFixture, cleanupListingProjections } = require('./fixtures');

const JWT_SECRET = 'integration-escrow-payments-access-secret';
const ADDRESS = {
  recipientName: 'Test Recipient',
  phone: '+15551234567',
  cityId: '',
  addressLine1: '12 Test Street',
};
const ENV_KEYS = [
  'JWT_ACCESS_SECRET',
  'PAYMENTS_ENABLED',
  'PAYMENT_GATEWAY_PROVIDER',
  'FAKE_GATEWAY_WEBHOOK_SECRET',
  'PAYMENT_WEBHOOK_URL',
  'FAKE_GATEWAY_WEBHOOK_TOLERANCE_SECONDS',
  'FAKE_GATEWAY_DELAY_MS',
  'PUBLIC_BASE_URL',
  'NODE_ENV',
];

let originalEnvironment;
let fixture;
let buyerId;
let orderId;
let reservationId;
let listingIds;
let additionalUserIds;

function authHeader(userId) {
  const token = signAccessToken(userId, { secret: JWT_SECRET });
  return `Bearer ${token}`;
}

function passThrough(_req, _res, next) {
  return next();
}

function routeApp({ auth } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/orders', createEscrowPaymentsRouter({
    limiter: passThrough,
    ...(auth ? { auth } : {}),
  }));
  return app;
}

function mountedApiApp() {
  const app = express();
  app.use('/api', cachePolicy);
  app.use(express.json());
  app.use('/api', routes);
  app.use(errorHandler);
  return app;
}

async function createBuyer() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const { rows } = await db.query(
    `INSERT INTO users (full_name, phone, password_hash, city_id, role)
     VALUES ($1, $2, 'fixture-hash', $3, 'buyer') RETURNING id`,
    [`Escrow buyer ${suffix}`, `+1558${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 1000)}`, fixture.cityId]
  );
  additionalUserIds.push(rows[0].id);
  return rows[0].id;
}

async function createPaymentIntent() {
  const reservation = await reservations.buyListing(fixture.listingId, buyerId, {
    address: { ...ADDRESS, cityId: fixture.cityId },
  });
  orderId = reservation.orderId;
  reservationId = reservation.reservationId;
  return reservation;
}

beforeEach(async () => {
  originalEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET = JWT_SECRET;
  process.env.PAYMENTS_ENABLED = '1';
  process.env.PAYMENT_GATEWAY_PROVIDER = 'fake';
  process.env.FAKE_GATEWAY_WEBHOOK_SECRET =
    `integration-fake-webhook-secret-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  process.env.PAYMENT_WEBHOOK_URL = 'http://127.0.0.1:39991/api/webhooks/payments/fake';
  process.env.FAKE_GATEWAY_WEBHOOK_TOLERANCE_SECONDS = '300';
  process.env.FAKE_GATEWAY_DELAY_MS = '1';
  process.env.PUBLIC_BASE_URL = 'http://localhost:5173';

  fixture = await createFixture({ askingPrice: '1250.50', listingStatus: 'published' });
  listingIds = [fixture.listingId];
  additionalUserIds = [];
  buyerId = await createBuyer();
  await db.query(
    `INSERT INTO supported_delivery_cities (city_id, active)
     VALUES ($1, true) ON CONFLICT (city_id) DO UPDATE SET active = true`,
    [fixture.cityId]
  );
  orderId = null;
  reservationId = null;
});

afterEach(async () => {
  try {
    if (listingIds?.length) {
      for (const listingId of listingIds) await cleanupListingProjections(listingId);
      await db.query(
        'DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE listing_id = ANY($1::uuid[]))',
        [listingIds]
      );
      await db.query('DELETE FROM orders WHERE listing_id = ANY($1::uuid[])', [listingIds]);
      await db.query('DELETE FROM reservations WHERE listing_id = ANY($1::uuid[])', [listingIds]);
    }
    if (fixture) await db.query('DELETE FROM supported_delivery_cities WHERE city_id = $1', [fixture.cityId]);
    if (additionalUserIds?.length) {
      await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [additionalUserIds]);
    }
    if (fixture) await fixture.cleanup();
  } finally {
    jest.restoreAllMocks();
    for (const [key, value] of Object.entries(originalEnvironment || {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

describe('FR-60a hosted checkout intent', () => {
  test('FR-60a: first checkout creates one payment, moves the order to payment_pending, and returns snapshot values', async () => {
    const reservation = await createPaymentIntent();
    const result = await escrowPayments.createOrReusePayment({ orderId, buyerId });

    expect(result).toMatchObject({
      status: 'pending',
      checkoutUrl: expect.stringContaining('/fake-gateway/checkout/fake_'),
      amount: reservation.total,
      currency: 'PKR',
      created: true,
    });
    const { rows } = await db.query(
      `SELECT p.status, p.amount, p.currency, p.idempotency_key, o.status AS order_status
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.order_id = $1`,
      [orderId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'pending',
      amount: reservation.total,
      currency: 'PKR',
      idempotency_key: `pay:${reservationId}:1`,
      order_status: 'payment_pending',
    });
    expect(paymentGateway.getPaymentGateway().getSessionCount()).toBe(1);
  });

  test('FR-60a: repeat checkout reuses the payment and URL with exactly one fake provider session', async () => {
    await createPaymentIntent();
    const first = await escrowPayments.createOrReusePayment({ orderId, buyerId });
    const repeated = await escrowPayments.createOrReusePayment({ orderId, buyerId });

    expect(repeated).toMatchObject({
      paymentId: first.paymentId,
      checkoutUrl: first.checkoutUrl,
      status: 'pending',
      created: false,
    });
    expect(paymentGateway.getPaymentGateway().getSessionCount()).toBe(1);
  });

  test('FR-60a: eight parallel checkout requests create one payment row and one fake session', async () => {
    await createPaymentIntent();
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      escrowPayments.createOrReusePayment({ orderId, buyerId })));
    const { rows } = await db.query('SELECT id FROM payments WHERE order_id = $1', [orderId]);

    expect(rows).toHaveLength(1);
    expect(new Set(results.map((result) => result.paymentId)).size).toBe(1);
    expect(new Set(results.map((result) => result.checkoutUrl)).size).toBe(1);
    expect(paymentGateway.getPaymentGateway().getSessionCount()).toBe(1);
  });

  test('FR-60a, FR-61: route ignores client amount and currency, and keeps checkout responses private', async () => {
    await createPaymentIntent();
    const response = await request(routeApp())
      .post(`/api/orders/${orderId}/payment`)
      .set('Authorization', authHeader(buyerId))
      .send({ amount: '0.01', currency: 'USD' })
      .expect(201)
      .expect('Cache-Control', 'private, no-store');

    expect(response.body).toMatchObject({
      paymentId: expect.any(String),
      status: 'pending',
      checkoutUrl: expect.stringContaining('/fake-gateway/checkout/fake_'),
      amount: '1550.50',
      currency: 'PKR',
    });
    const repeated = await request(routeApp())
      .post(`/api/orders/${orderId}/payment`)
      .set('Authorization', authHeader(buyerId))
      .send({ amount: '1', currency: 'USD' })
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    expect(repeated.body.paymentId).toBe(response.body.paymentId);
    expect(repeated.body.checkoutUrl).toBe(response.body.checkoutUrl);
  });

  test('FR-60a: a different buyer receives 404', async () => {
    await createPaymentIntent();
    await expect(escrowPayments.createOrReusePayment({
      orderId,
      buyerId: fixture.userId,
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('FR-60a: expired or released reservations and already-succeeded payments return 409', async () => {
    await createPaymentIntent();
    await db.query(
      "UPDATE reservations SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [reservationId]
    );
    await expect(escrowPayments.createOrReusePayment({ orderId, buyerId }))
      .rejects.toMatchObject({ statusCode: 409 });

    await db.query(
      `UPDATE reservations SET status = 'released', expires_at = now() + interval '30 minutes'
       WHERE id = $1`,
      [reservationId]
    );
    await expect(escrowPayments.createOrReusePayment({ orderId, buyerId }))
      .rejects.toMatchObject({ statusCode: 409 });

    await db.query("UPDATE reservations SET status = 'active' WHERE id = $1", [reservationId]);
    await db.query("UPDATE orders SET status = 'payment_pending' WHERE id = $1", [orderId]);
    await db.query(
      `INSERT INTO payments
         (order_id, provider, status, amount, currency, gateway_fee_currency, idempotency_key)
       VALUES ($1, 'fake', 'succeeded', '1550.50', 'PKR', 'PKR', $2)`,
      [orderId, `pay:${reservationId}:succeeded`]
    );
    await expect(escrowPayments.createOrReusePayment({ orderId, buyerId }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  test('FR-60a: gateway failure leaves a created row and retry succeeds with the same key', async () => {
    await createPaymentIntent();
    const gateway = paymentGateway.getPaymentGateway();
    const createCheckout = jest.spyOn(gateway, 'createHostedCheckout').mockRejectedValueOnce(new Error('private provider detail'));

    await expect(escrowPayments.createOrReusePayment({ orderId, buyerId }))
      .rejects.toMatchObject({ statusCode: 503, code: 'payment_gateway_unavailable', retryHint: 'retry_same_payment' });
    const { rows: failedRows } = await db.query(
      `SELECT p.status, p.idempotency_key, r.status AS reservation_status
       FROM payments p JOIN orders o ON o.id = p.order_id
       JOIN reservations r ON r.id = o.reservation_id WHERE p.order_id = $1`,
      [orderId]
    );
    expect(failedRows).toEqual([{
      status: 'created',
      idempotency_key: `pay:${reservationId}:1`,
      reservation_status: 'active',
    }]);

    const retry = await escrowPayments.createOrReusePayment({ orderId, buyerId });
    expect(retry).toMatchObject({ status: 'pending', created: false });
    const { rows: paymentRows } = await db.query(
      'SELECT idempotency_key FROM payments WHERE order_id = $1',
      [orderId]
    );
    expect(paymentRows).toEqual([{ idempotency_key: `pay:${reservationId}:1` }]);
    expect(gateway.getSessionCount()).toBe(1);
    expect(createCheckout).toHaveBeenCalledTimes(2);
  });

  test('FR-60a: a previous failed payment uses the next attempt key', async () => {
    await createPaymentIntent();
    const first = await escrowPayments.createOrReusePayment({ orderId, buyerId });
    await db.query("UPDATE payments SET status = 'failed' WHERE id = $1", [first.paymentId]);
    const next = await escrowPayments.createOrReusePayment({ orderId, buyerId });
    const { rows } = await db.query(
      'SELECT idempotency_key FROM payments WHERE order_id = $1 ORDER BY created_at, id',
      [orderId]
    );

    expect(rows.map((row) => row.idempotency_key)).toEqual([
      `pay:${reservationId}:1`,
      `pay:${reservationId}:2`,
    ]);
    expect(next.paymentId).not.toBe(first.paymentId);
    expect(paymentGateway.getPaymentGateway().getSessionCount()).toBe(2);
  });

  test('FR-60a: payments disabled returns 503 before authentication or database access', async () => {
    await createPaymentIntent();
    process.env.PAYMENTS_ENABLED = '0';
    const principalLookup = jest.spyOn(users, 'getAuthenticationPrincipal');
    const response = await request(mountedApiApp())
      .post(`/api/orders/${orderId}/payment`)
      .set('Authorization', authHeader(buyerId))
      .expect(503)
      .expect('Cache-Control', 'private, no-store');

    expect(response.body.code).toBe('payments_disabled');
    expect(principalLookup).not.toHaveBeenCalled();
  });

  test('FR-60a: production refuses fake checkout before database access and does not mount its page', async () => {
    await createPaymentIntent();
    process.env.NODE_ENV = 'production';
    const transaction = jest.spyOn(db, 'withTransaction');
    const auth = (req, _res, next) => {
      req.user = { id: buyerId };
      return next();
    };
    const response = await request(routeApp({ auth }))
      .post(`/api/orders/${orderId}/payment`)
      .expect(503)
      .expect('Cache-Control', 'private, no-store');
    expect(response.body.code).toBe('payment_provider_not_configured');
    expect(transaction).not.toHaveBeenCalled();

    let productionApp;
    jest.isolateModules(() => {
      productionApp = require('../../src/app');
    });
    await request(productionApp).get('/fake-gateway/checkout/fake_ref').expect(404);
  });
});

describe('FR-61 database-only payment status and fake hosted page', () => {
  test('FR-61: status GET is private/no-store and leaves stored order and payment state unchanged', async () => {
    await createPaymentIntent();
    await escrowPayments.createOrReusePayment({ orderId, buyerId });
    const before = await db.query(
      `SELECT o.status AS order_status, r.status AS reservation_status, p.status AS payment_status
       FROM orders o JOIN reservations r ON r.id = o.reservation_id
       JOIN payments p ON p.order_id = o.id WHERE o.id = $1`,
      [orderId]
    );
    const response = await request(routeApp())
      .get(`/api/orders/${orderId}/payment`)
      .set('Authorization', authHeader(buyerId))
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    const after = await db.query(
      `SELECT o.status AS order_status, r.status AS reservation_status, p.status AS payment_status
       FROM orders o JOIN reservations r ON r.id = o.reservation_id
       JOIN payments p ON p.order_id = o.id WHERE o.id = $1`,
      [orderId]
    );

    expect(response.body).toMatchObject({
      orderId,
      orderStatus: 'payment_pending',
      reservationStatus: 'active',
      status: 'pending',
      amount: '1550.50',
      currency: 'PKR',
    });
    expect(after.rows).toEqual(before.rows);
  });

  test('FR-61: fake page escapes output and sends success, failure, duplicate, and delayed signed events without changing state', async () => {
    await createPaymentIntent();
    const payment = await escrowPayments.createOrReusePayment({ orderId, buyerId });
    const { rows } = await db.query('SELECT provider_payment_id FROM payments WHERE id = $1', [payment.paymentId]);
    const safeRef = rows[0].provider_payment_id;
    const hostileRef = '<img src=x onerror=alert(1)>';
    await db.query(
      'UPDATE payments SET provider_payment_id = $2, provider_reference = $2, hosted_checkout_reference = $2 WHERE id = $1',
      [payment.paymentId, hostileRef]
    );
    await db.query(
      "UPDATE reservations SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [reservationId]
    );

    const deliveries = [];
    const fakeFetch = jest.fn(async (_url, options) => {
      deliveries.push(options);
      return { status: 204, ok: true };
    });
    const app = express();
    app.use('/fake-gateway', createFakeGatewayRouter({
      fetchImpl: fakeFetch,
      webhookUrl: 'http://127.0.0.1:39992/test-webhook',
      delayMs: 1,
    }));

    const checkout = await request(app)
      .get(`/fake-gateway/checkout/${encodeURIComponent(hostileRef)}`)
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    expect(checkout.text).toContain('Amount: 1550.50');
    expect(checkout.text).toContain('Currency: PKR');
    expect(checkout.text).toContain('Pay (success)');
    expect(checkout.text).toContain('Fail');
    expect(checkout.text).toContain('Duplicate');
    expect(checkout.text).toContain('Delayed');
    expect(checkout.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(checkout.text).not.toContain('<img src=x');

    for (const scenario of ['success', 'failure', 'duplicate', 'delayed']) {
      await request(app)
        .post(`/fake-gateway/checkout/${encodeURIComponent(hostileRef)}/complete`)
        .type('form')
        .send({ scenario })
        .expect(303);
    }
    expect(fakeFetch).toHaveBeenCalledTimes(5);
    const gateway = paymentGateway.getPaymentGateway();
    const verified = await Promise.all(deliveries.map(({ body, headers }) =>
      gateway.verifyWebhook({ rawBody: body, headers, now: new Date() })));
    expect(verified.map((event) => event.type)).toEqual([
      'payment.succeeded',
      'payment.failed',
      'payment.succeeded',
      'payment.succeeded',
      'payment.succeeded',
    ]);
    expect(verified[2].eventId).toBe(verified[3].eventId);
    expect(deliveries[2].body).toEqual(deliveries[3].body);
    expect(safeRef).not.toBe(hostileRef);

    const { rows: unchanged } = await db.query(
      `SELECT o.status AS order_status, r.status AS reservation_status, p.status AS payment_status
       FROM orders o JOIN reservations r ON r.id = o.reservation_id
       JOIN payments p ON p.order_id = o.id WHERE o.id = $1`,
      [orderId]
    );
    expect(unchanged[0]).toEqual({
      order_status: 'payment_pending',
      reservation_status: 'active',
      payment_status: 'pending',
    });
  });

  test('FR-61: fake page displays the stage-five webhook-not-available message on a 404', async () => {
    await createPaymentIntent();
    const payment = await escrowPayments.createOrReusePayment({ orderId, buyerId });
    const { rows } = await db.query('SELECT provider_payment_id FROM payments WHERE id = $1', [payment.paymentId]);
    const app = express();
    app.use('/fake-gateway', createFakeGatewayRouter({
      fetchImpl: async () => ({ status: 404, ok: false }),
      webhookUrl: 'http://127.0.0.1:39993/test-webhook',
      delayMs: 0,
    }));

    const response = await request(app)
      .post(`/fake-gateway/checkout/${rows[0].provider_payment_id}/complete`)
      .type('form')
      .send({ scenario: 'success' })
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    expect(response.text).toContain('webhook endpoint not available yet');
  });
});
