const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');
const db = require('../../src/db.service');
const queue = require('../../src/lib/queue');
const app = require('../../src/app');
const reservations = require('../../src/modules/reservations.service');
const escrowPayments = require('../../src/modules/escrowPayments.service');
const listings = require('../../src/modules/listings.service');
const listingSearch = require('../../src/modules/listingSearch.service');
const discovery = require('../../src/modules/discovery.service');
const { ConflictError } = require('../../src/lib/errors');
const { buildSignedFakeEvent } = require('../../src/lib/adapters/fakePaymentGateway');
const { createEscrowPaymentsRouter } = require('../../src/routes/escrowPayments.routes');
const { createPaymentWebhooksRouter } = require('../../src/routes/paymentWebhooks.routes');
const { createFakeGatewayRouter } = require('../../src/routes/fakeGateway.routes');
const reservationsRoutes = require('../../src/routes/reservations.routes');
const { signAccessToken } = require('../../src/lib/jwt');
const errorHandler = require('../../src/middleware/errorHandler');
const { createFixture } = require('./fixtures');

const JWT_SECRET = 'payment-webhook-integration-access-secret';
const ADDRESS = {
  recipientName: 'Webhook Test Recipient',
  phone: '+15551234567',
  cityId: '',
  addressLine1: '12 Webhook Test Street',
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
let paymentId;
let paymentRef;
let eventIds;
let additionalFixtures;

function signPayload(rawBody, secret, timestamp = String(Math.floor(Date.now() / 1000))) {
  return {
    'x-fake-timestamp': timestamp,
    'x-fake-signature': crypto.createHmac('sha256', secret).update(rawBody).digest('hex'),
  };
}

function postWebhook(rawBody, headers, provider = 'fake') {
  return request(app)
    .post(`/api/webhooks/payments/${provider}`)
    .set('Content-Type', 'application/json')
    .set(headers)
    .send(rawBody.toString('utf8'));
}

function eventId() {
  const id = `webhook-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  eventIds.push(id);
  return id;
}

async function webhookCounts(id) {
  const { rows: inboxRows } = await db.query(
    `SELECT count(*)::int AS total
     FROM webhook_inbox
     WHERE provider = 'fake' AND provider_event_id = $1`,
    [id]
  );
  const { rows: jobRows } = await db.query(
    `SELECT count(*)::int AS total
     FROM pgboss.job job
     JOIN webhook_inbox inbox ON job.data->>'webhookInboxId' = inbox.id::text
     WHERE job.name = $1 AND inbox.provider = 'fake' AND inbox.provider_event_id = $2`,
    [queue.QUEUES.PAYMENT_WEBHOOKS, id]
  );
  return { inbox: inboxRows[0].total, jobs: jobRows[0].total };
}

async function createSignedEvent(id = eventId(), overrides = {}) {
  return buildSignedFakeEvent({
    type: overrides.type || 'payment.succeeded',
    providerPaymentRef: overrides.providerPaymentRef || paymentRef,
    amount: overrides.amount || '1550.50',
    currency: overrides.currency || 'PKR',
    eventId: id,
    now: new Date(),
  });
}

async function receiveSignedEvent(signed) {
  await postWebhook(signed.rawBody, signed.headers).expect(200, { received: true });
  const { rows } = await db.query(
    `SELECT id
     FROM webhook_inbox
     WHERE provider = 'fake' AND provider_event_id = $1`,
    [JSON.parse(signed.rawBody.toString('utf8')).eventId]
  );
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

beforeEach(async () => {
  originalEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = 'test';
  process.env.PAYMENTS_ENABLED = '1';
  process.env.JWT_ACCESS_SECRET = JWT_SECRET;
  process.env.PAYMENT_GATEWAY_PROVIDER = 'fake';
  process.env.FAKE_GATEWAY_WEBHOOK_SECRET =
    `integration-fake-webhook-secret-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  process.env.PAYMENT_WEBHOOK_URL = 'http://127.0.0.1:39991/api/webhooks/payments/fake';
  process.env.FAKE_GATEWAY_WEBHOOK_TOLERANCE_SECONDS = '300';
  process.env.PUBLIC_BASE_URL = 'http://localhost:5173';

  fixture = await createFixture({ askingPrice: '1250.50', listingStatus: 'published' });
  eventIds = [];
  additionalFixtures = [];
  const buyerSuffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const { rows: buyerRows } = await db.query(
    `INSERT INTO users (full_name, phone, password_hash, city_id, role)
     VALUES ($1, $2, 'fixture-hash', $3, 'buyer') RETURNING id`,
    [`Webhook buyer ${buyerSuffix}`, `+1557${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 1000)}`, fixture.cityId]
  );
  buyerId = buyerRows[0].id;
  await db.query(
    `INSERT INTO supported_delivery_cities (city_id, active)
     VALUES ($1, true) ON CONFLICT (city_id) DO UPDATE SET active = true`,
    [fixture.cityId]
  );
  const reservation = await reservations.buyListing(fixture.listingId, buyerId, {
    address: { ...ADDRESS, cityId: fixture.cityId },
  });
  orderId = reservation.orderId;
  const payment = await escrowPayments.createOrReusePayment({ orderId, buyerId });
  paymentId = payment.paymentId;
  const { rows: paymentRows } = await db.query(
    'SELECT provider_payment_id FROM payments WHERE id = $1',
    [paymentId]
  );
  paymentRef = paymentRows[0].provider_payment_id;
});

afterEach(async () => {
  try {
    if (eventIds?.length) {
      await db.query(
        "DELETE FROM webhook_inbox WHERE provider = 'fake' AND provider_event_id = ANY($1::text[])",
        [eventIds]
      );
    }
    for (const record of [
      { fixture, buyerId, orderId },
      ...(additionalFixtures || []),
    ]) {
      if (!record.fixture) continue;
      const { rows: auditRows } = record.orderId ? await db.query(
        'SELECT EXISTS (SELECT 1 FROM money_audit_events WHERE order_id = $1) AS retained',
        [record.orderId]
      ) : { rows: [{ retained: false }] };
      if (!auditRows[0].retained) {
        if (record.orderId) await db.query('DELETE FROM payments WHERE order_id = $1', [record.orderId]);
        await db.query('DELETE FROM orders WHERE listing_id = $1', [record.fixture.listingId]);
        await db.query('DELETE FROM reservations WHERE listing_id = $1', [record.fixture.listingId]);
        await db.query('DELETE FROM supported_delivery_cities WHERE city_id = $1', [record.fixture.cityId]);
        if (record.buyerId) await db.query('DELETE FROM users WHERE id = $1', [record.buyerId]);
        await record.fixture.cleanup();
      }
    }
  } finally {
    jest.restoreAllMocks();
    for (const [key, value] of Object.entries(originalEnvironment || {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

describe('FR-77b, SEC-33 verified payment webhook inbox', () => {
  test('FR-77b, SEC-33: a valid signed event stores exact bytes and queues one job without funding the order', async () => {
    const signed = await createSignedEvent();

    const response = await postWebhook(signed.rawBody, signed.headers).expect(200);
    expect(response.body).toEqual({ received: true });

    const { rows } = await db.query(
      `SELECT id, event_type, raw_body, signature_metadata, timestamp_metadata,
              verified_at, status, payment_id
       FROM webhook_inbox
       WHERE provider = 'fake' AND provider_event_id = $1`,
      [eventIds[0]]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      event_type: 'payment.succeeded',
      raw_body: signed.rawBody,
      signature_metadata: { header: 'x-fake-signature', algorithm: 'hmac-sha256' },
      timestamp_metadata: {
        header: 'x-fake-timestamp',
        value: signed.headers['x-fake-timestamp'],
      },
      status: 'received',
      payment_id: paymentId,
    }));
    expect(rows[0].verified_at).toBeInstanceOf(Date);
    expect(await webhookCounts(eventIds[0])).toEqual({ inbox: 1, jobs: 1 });

    const { rows: paymentRows } = await db.query(
      `SELECT p.status AS payment_status, o.status AS order_status
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.id = $1`,
      [paymentId]
    );
    expect(paymentRows[0]).toEqual({ payment_status: 'pending', order_status: 'payment_pending' });
  });

  test('FR-77b: a repeated verified event is acknowledged without a second inbox row or job', async () => {
    const signed = await createSignedEvent();

    await postWebhook(signed.rawBody, signed.headers).expect(200, { received: true });
    await postWebhook(signed.rawBody, signed.headers).expect(200, { received: true });

    expect(await webhookCounts(eventIds[0])).toEqual({ inbox: 1, jobs: 1 });
  });

  test.each([
    ['tampered body', (signed) => ({
      rawBody: Buffer.from(`${signed.rawBody.toString()} `),
      headers: signed.headers,
    })],
    ['wrong secret', (signed) => ({
      rawBody: signed.rawBody,
      headers: signPayload(signed.rawBody, 'wrong-integration-webhook-secret-with-32-bytes'),
    })],
    ['missing signature', (signed) => ({
      rawBody: signed.rawBody,
      headers: { 'x-fake-timestamp': signed.headers['x-fake-timestamp'] },
    })],
    ['missing timestamp', (signed) => ({
      rawBody: signed.rawBody,
      headers: { 'x-fake-signature': signed.headers['x-fake-signature'] },
    })],
    ['stale timestamp', (signed) => {
      const stale = buildSignedFakeEvent({
        type: 'payment.succeeded',
        providerPaymentRef: paymentRef,
        amount: '1550.50',
        currency: 'PKR',
        eventId: eventIds[0],
        now: new Date(Date.now() - 10 * 60 * 1000),
      });
      return stale;
    }],
  ])('SEC-33: rejects a %s signature without an inbox row or job', async (_label, mutate) => {
    const signed = await createSignedEvent();
    const requestBody = mutate(signed);

    await postWebhook(requestBody.rawBody, requestBody.headers).expect(401);

    expect(await webhookCounts(eventIds[0])).toEqual({ inbox: 0, jobs: 0 });
  });

  test('FR-77b: only the configured fake provider is accepted', async () => {
    const signed = await createSignedEvent();

    await postWebhook(signed.rawBody, signed.headers, 'other').expect(404);

    expect(await webhookCounts(eventIds[0])).toEqual({ inbox: 0, jobs: 0 });
  });

  test('FR-77b: the fake provider is unavailable when its webhook secret is not configured', async () => {
    const signed = await createSignedEvent();
    const secret = process.env.FAKE_GATEWAY_WEBHOOK_SECRET;
    delete process.env.FAKE_GATEWAY_WEBHOOK_SECRET;

    try {
      await postWebhook(signed.rawBody, signed.headers).expect(404);
    } finally {
      process.env.FAKE_GATEWAY_WEBHOOK_SECRET = secret;
    }

    expect(await webhookCounts(eventIds[0])).toEqual({ inbox: 0, jobs: 0 });
  });

  test('FR-77b: a raw body larger than 64 KiB is rejected', async () => {
    const id = eventId();
    const rawBody = Buffer.from(JSON.stringify({
      type: 'payment.succeeded',
      providerPaymentRef: paymentRef,
      amount: '1550.50',
      currency: 'PKR',
      eventId: id,
      padding: 'x'.repeat(66 * 1024),
    }));

    await postWebhook(rawBody, signPayload(rawBody, process.env.FAKE_GATEWAY_WEBHOOK_SECRET)).expect(413);

    expect(await webhookCounts(id)).toEqual({ inbox: 0, jobs: 0 });
  });

  test('SEC-33: a valid signature is verified before malformed JSON receives 400', async () => {
    const rawBody = Buffer.from('{not-json');
    const headers = signPayload(rawBody, process.env.FAKE_GATEWAY_WEBHOOK_SECRET);
    const { rows: previousInboxRows } = await db.query(
      `SELECT count(*)::int AS total FROM webhook_inbox WHERE provider = 'fake'`
    );
    const { rows: previousJobRows } = await db.query(
      `SELECT count(*)::int AS total FROM pgboss.job WHERE name = $1`,
      [queue.QUEUES.PAYMENT_WEBHOOKS]
    );

    await postWebhook(rawBody, headers).expect(400);

    const { rows: inboxRows } = await db.query(
      `SELECT count(*)::int AS total FROM webhook_inbox WHERE provider = 'fake'`
    );
    const { rows: jobRows } = await db.query(
      `SELECT count(*)::int AS total FROM pgboss.job WHERE name = $1`,
      [queue.QUEUES.PAYMENT_WEBHOOKS]
    );
    expect(inboxRows[0].total).toBe(previousInboxRows[0].total);
    expect(jobRows[0].total).toBe(previousJobRows[0].total);
  });
});

describe('FR-61, FR-62 payment webhook worker', () => {
  test('FR-61, FR-62: a verified success funds the order exactly once and syncs sold availability', async () => {
    const signed = await createSignedEvent();
    const inboxId = await receiveSignedEvent(signed);

    expect(await escrowPayments.processPaymentWebhookJob({ webhookInboxId: inboxId }))
      .toEqual({ outcome: 'processed' });

    const { rows: stateRows } = await db.query(
      `SELECT p.status AS payment_status, r.status AS reservation_status,
              o.status AS order_status, o.funded_at,
              o.handover_deadline_at = o.funded_at + INTERVAL '72 hours' AS deadline_matches,
              r.paid_at
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       JOIN reservations r ON r.id = o.reservation_id
       WHERE p.id = $1`,
      [paymentId]
    );
    expect(stateRows[0]).toMatchObject({
      payment_status: 'succeeded',
      reservation_status: 'paid',
      order_status: 'funded',
      deadline_matches: true,
    });
    expect(stateRows[0].funded_at).toBeInstanceOf(Date);
    expect(stateRows[0].paid_at).toBeInstanceOf(Date);

    const { rows: moneyRows } = await db.query(
      `SELECT
         (SELECT count(*)::int FROM ledger_entries WHERE payment_id = $1 AND entry_type = 'capture') AS captures,
         (SELECT count(*)::int FROM money_audit_events WHERE payment_id = $1 AND action = 'payment_funded') AS audits,
         (SELECT count(*)::int FROM refunds WHERE payment_id = $1) AS refunds`,
      [paymentId]
    );
    expect(moneyRows[0]).toEqual({ captures: 1, audits: 1, refunds: 0 });

    expect(await discovery.getListingStatus(fixture.listingId)).toMatchObject({
      status: 'sold',
      sold: true,
    });
    const { rows: jobs } = await db.query(
      `SELECT name, data
       FROM pgboss.job
       WHERE name IN ($1, $2) AND data->>'listingId' = $3
       ORDER BY (data->>'searchVersion')::int DESC NULLS LAST`,
      [queue.QUEUES.LISTING_SEARCH, queue.QUEUES.PAGE_SNAPSHOTS, fixture.listingId]
    );
    expect(jobs.some((job) => job.name === queue.QUEUES.LISTING_SEARCH)).toBe(true);
    expect(jobs.some((job) => job.name === queue.QUEUES.PAGE_SNAPSHOTS)).toBe(true);
    const searchJob = jobs.find((job) => job.name === queue.QUEUES.LISTING_SEARCH);
    await listingSearch.processListingSearchJob(searchJob.data);
    const { rows: indexRows } = await db.query(
      'SELECT is_sold FROM listing_search WHERE listing_id = $1',
      [fixture.listingId]
    );
    expect(indexRows).toEqual([{ is_sold: true }]);
  });

  test('FR-61, FR-62: five parallel runs of one inbox job produce one capture, audit, and funding transition', async () => {
    const inboxId = await receiveSignedEvent(await createSignedEvent());

    const results = await Promise.all(Array.from({ length: 5 }, () =>
      escrowPayments.processPaymentWebhookJob({ webhookInboxId: inboxId })));
    expect(results).toEqual(Array.from({ length: 5 }, () => ({ outcome: 'processed' })));

    const { rows } = await db.query(
      `SELECT p.status, o.status AS order_status,
              (SELECT count(*)::int FROM ledger_entries WHERE payment_id = p.id) AS ledger_count,
              (SELECT count(*)::int FROM money_audit_events WHERE payment_id = p.id) AS audit_count
       FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = $1`,
      [paymentId]
    );
    expect(rows[0]).toEqual({
      status: 'succeeded',
      order_status: 'funded',
      ledger_count: 1,
      audit_count: 1,
    });
  });

  test('FR-77b, SEC-33: ten parallel identical signed deliveries create one inbox row and one job', async () => {
    const signed = await createSignedEvent();
    const responses = await Promise.all(Array.from({ length: 10 }, () =>
      postWebhook(signed.rawBody, signed.headers)));

    expect(responses.every((response) =>
      response.status === 200 && response.body.received === true)).toBe(true);
    expect(await webhookCounts(eventIds[0])).toEqual({ inbox: 1, jobs: 1 });
  });

  test('FR-61, FR-62: replay after processing changes no payment, order, reservation, ledger, refund, or audit state', async () => {
    const signed = await createSignedEvent();
    const inboxId = await receiveSignedEvent(signed);
    await escrowPayments.processPaymentWebhookJob({ webhookInboxId: inboxId });
    const { rows: beforeRows } = await db.query(
      `SELECT p.status AS payment_status, o.status AS order_status, r.status AS reservation_status,
              (SELECT count(*)::int FROM ledger_entries WHERE payment_id = p.id) AS ledger_count,
              (SELECT count(*)::int FROM refunds WHERE payment_id = p.id) AS refund_count,
              (SELECT count(*)::int FROM money_audit_events WHERE payment_id = p.id) AS audit_count
       FROM payments p JOIN orders o ON o.id = p.order_id
       JOIN reservations r ON r.id = o.reservation_id
       WHERE p.id = $1`,
      [paymentId]
    );
    const { rows: beforeInboxRows } = await db.query(
      'SELECT attempts, processed_at FROM webhook_inbox WHERE id = $1',
      [inboxId]
    );

    await postWebhook(signed.rawBody, signed.headers).expect(200, { received: true });
    await escrowPayments.processPaymentWebhookJob({ webhookInboxId: inboxId });

    const { rows: afterRows } = await db.query(
      `SELECT p.status AS payment_status, o.status AS order_status, r.status AS reservation_status,
              (SELECT count(*)::int FROM ledger_entries WHERE payment_id = p.id) AS ledger_count,
              (SELECT count(*)::int FROM refunds WHERE payment_id = p.id) AS refund_count,
              (SELECT count(*)::int FROM money_audit_events WHERE payment_id = p.id) AS audit_count
       FROM payments p JOIN orders o ON o.id = p.order_id
       JOIN reservations r ON r.id = o.reservation_id
       WHERE p.id = $1`,
      [paymentId]
    );
    expect(afterRows).toEqual(beforeRows);
    const { rows: afterInboxRows } = await db.query(
      'SELECT attempts, processed_at FROM webhook_inbox WHERE id = $1',
      [inboxId]
    );
    expect(afterInboxRows[0]).toEqual({
      attempts: beforeInboxRows[0].attempts + 1,
      processed_at: beforeInboxRows[0].processed_at,
    });
    expect(await webhookCounts(eventIds[0])).toEqual({ inbox: 1, jobs: 1 });
  });

  test('FR-61, FR-62: a failed payment keeps the reservation active and a new keyed attempt can fund it', async () => {
    const failedInboxId = await receiveSignedEvent(await createSignedEvent(undefined, {
      type: 'payment.failed',
    }));
    await escrowPayments.processPaymentWebhookJob({ webhookInboxId: failedInboxId });

    const { rows: failedRows } = await db.query(
      `SELECT p.status AS payment_status, r.status AS reservation_status, o.status AS order_status
       FROM payments p JOIN orders o ON o.id = p.order_id
       JOIN reservations r ON r.id = o.reservation_id WHERE p.id = $1`,
      [paymentId]
    );
    expect(failedRows[0]).toEqual({
      payment_status: 'failed',
      reservation_status: 'active',
      order_status: 'payment_pending',
    });

    const retry = await escrowPayments.createOrReusePayment({ orderId, buyerId });
    const { rows: originalPaymentRows } = await db.query(
      'SELECT idempotency_key FROM payments WHERE id = $1',
      [paymentId]
    );
    const { rows: retryRows } = await db.query(
      `SELECT id, provider_payment_id, idempotency_key
       FROM payments WHERE id = $1`,
      [retry.paymentId]
    );
    expect(retryRows[0].idempotency_key).not.toBe(originalPaymentRows[0].idempotency_key);
    expect(retryRows[0].provider_payment_id).not.toBe(paymentRef);
    const retryInboxId = await receiveSignedEvent(await createSignedEvent(undefined, {
      providerPaymentRef: retryRows[0].provider_payment_id,
    }));
    await escrowPayments.processPaymentWebhookJob({ webhookInboxId: retryInboxId });

    const { rows: fundedRows } = await db.query(
      `SELECT p.status AS payment_status, r.status AS reservation_status, o.status AS order_status
       FROM payments p JOIN orders o ON o.id = p.order_id
       JOIN reservations r ON r.id = o.reservation_id
       WHERE p.id = $1`,
      [retry.paymentId]
    );
    expect(fundedRows[0]).toEqual({
      payment_status: 'succeeded',
      reservation_status: 'paid',
      order_status: 'funded',
    });
  });

  test('FR-61, FR-62: a late capture requests one full system-expiry refund without reopening the order', async () => {
    await db.query(
      `UPDATE reservations SET expires_at = now() - INTERVAL '1 minute'
       WHERE id = (SELECT reservation_id FROM orders WHERE id = $1)`,
      [orderId]
    );
    const inboxId = await receiveSignedEvent(await createSignedEvent());
    await escrowPayments.processPaymentWebhookJob({ webhookInboxId: inboxId });

    const { rows: lateRows } = await db.query(
      `SELECT p.status AS payment_status, r.status AS reservation_status,
              o.status AS order_status, refund.trigger, refund.amount::text AS refund_amount,
              p.amount::text AS payment_amount, refund.status AS refund_status
       FROM payments p JOIN orders o ON o.id = p.order_id
       JOIN reservations r ON r.id = o.reservation_id
       JOIN refunds refund ON refund.payment_id = p.id
       WHERE p.id = $1`,
      [paymentId]
    );
    expect(lateRows).toHaveLength(1);
    expect(lateRows[0]).toMatchObject({
      payment_status: 'late',
      reservation_status: 'expired',
      order_status: 'cancelled',
      trigger: 'system_expiry',
      refund_amount: '1550.50',
      payment_amount: '1550.50',
      refund_status: 'requested',
    });

    const secondInboxId = await receiveSignedEvent(await createSignedEvent());
    await escrowPayments.processPaymentWebhookJob({ webhookInboxId: secondInboxId });
    const { rows: counts } = await db.query(
      `SELECT
         (SELECT count(*)::int FROM refunds WHERE payment_id = $1) AS refunds,
         (SELECT count(*)::int FROM ledger_entries WHERE payment_id = $1 AND entry_type = 'capture') AS captures,
         (SELECT count(*)::int FROM money_audit_events WHERE payment_id = $1) AS audits`,
      [paymentId]
    );
    expect(counts[0]).toEqual({ refunds: 1, captures: 1, audits: 1 });
    const { rows: noGatewayCalls } = await db.query(
      `SELECT count(*)::int AS total
       FROM refunds WHERE payment_id = $1 AND provider_refund_id IS NOT NULL`,
      [paymentId]
    );
    expect(noGatewayCalls[0].total).toBe(0);
  });

  test('FR-61, FR-62: a second capture after funding is refunded without changing the funded order', async () => {
    const firstInboxId = await receiveSignedEvent(await createSignedEvent());
    await escrowPayments.processPaymentWebhookJob({ webhookInboxId: firstInboxId });

    const { rows: beforeRows } = await db.query(
      `SELECT p.status AS payment_status, p.succeeded_at, o.status AS order_status,
              o.funded_at, r.status AS reservation_status, r.paid_at
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       JOIN reservations r ON r.id = o.reservation_id
       WHERE p.id = $1`,
      [paymentId]
    );
    const providerPaymentRef = `second-payment-${crypto.randomUUID()}`;
    const { rows: secondPaymentRows } = await db.query(
      `INSERT INTO payments
         (order_id, provider, provider_payment_id, provider_reference, status,
          amount, currency, gateway_fee_currency, idempotency_key)
       SELECT order_id, provider, $2, $2, 'pending',
              amount, currency, gateway_fee_currency, $3
       FROM payments
       WHERE id = $1
       RETURNING id, amount::text AS amount, currency`,
      [paymentId, providerPaymentRef, `test:${crypto.randomUUID()}`]
    );
    expect(secondPaymentRows).toHaveLength(1);

    const signed = await createSignedEvent(undefined, {
      providerPaymentRef,
      amount: secondPaymentRows[0].amount,
      currency: secondPaymentRows[0].currency,
    });
    const inboxId = await receiveSignedEvent(signed);
    await escrowPayments.processPaymentWebhookJob({ webhookInboxId: inboxId });

    const { rows: afterRows } = await db.query(
      `SELECT p.status AS payment_status, p.succeeded_at, o.status AS order_status,
              o.funded_at, r.status AS reservation_status, r.paid_at
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       JOIN reservations r ON r.id = o.reservation_id
       WHERE p.id = $1`,
      [paymentId]
    );
    expect(afterRows).toEqual(beforeRows);

    const { rows: capturedRows } = await db.query(
      `SELECT p.status, p.succeeded_at,
              (SELECT count(*)::int FROM ledger_entries
               WHERE payment_id = p.id AND entry_type = 'capture') AS ledger_count,
              (SELECT idempotency_key FROM ledger_entries
               WHERE payment_id = p.id AND entry_type = 'capture') AS ledger_key,
              (SELECT count(*)::int FROM money_audit_events WHERE payment_id = p.id) AS audit_count
       FROM payments p
       WHERE p.id = $1`,
      [secondPaymentRows[0].id]
    );
    expect(capturedRows[0]).toMatchObject({
      status: 'late',
      ledger_count: 1,
      ledger_key: `capture:${secondPaymentRows[0].id}`,
      audit_count: 1,
    });
    expect(capturedRows[0].succeeded_at).toBeInstanceOf(Date);

    const { rows: refundRows } = await db.query(
      `SELECT refund.trigger, refund.status, refund.amount::text AS refund_amount,
              payment.amount::text AS payment_amount, refund.idempotency_key, refund.reason
       FROM refunds refund
       JOIN payments payment ON payment.id = refund.payment_id
       WHERE refund.payment_id = $1`,
      [secondPaymentRows[0].id]
    );
    expect(refundRows).toEqual([{
      trigger: 'system_expiry',
      status: 'requested',
      refund_amount: secondPaymentRows[0].amount,
      payment_amount: secondPaymentRows[0].amount,
      idempotency_key: `refund:${secondPaymentRows[0].id}:late`,
      reason: 'Duplicate capture: reservation already paid',
    }]);
    expect(Number(refundRows[0].refund_amount)).toBeLessThanOrEqual(
      Number(refundRows[0].payment_amount)
    );

    const { rows: auditRows } = await db.query(
      `SELECT actor_id, action, reason
       FROM money_audit_events
       WHERE payment_id = $1`,
      [secondPaymentRows[0].id]
    );
    expect(auditRows).toEqual([{
      actor_id: null,
      action: 'late_payment_refund_requested',
      reason: 'duplicate_capture',
    }]);
    const { rows: inboxRows } = await db.query(
      'SELECT status FROM webhook_inbox WHERE id = $1',
      [inboxId]
    );
    expect(inboxRows).toEqual([{ status: 'processed' }]);
  });

  test('FR-61, FR-62: an active unexpired reservation with an ineligible order is refunded without funding', async () => {
    await db.query(
      "UPDATE orders SET status = 'reserved' WHERE id = $1",
      [orderId]
    );
    const inboxId = await receiveSignedEvent(await createSignedEvent());
    await escrowPayments.processPaymentWebhookJob({ webhookInboxId: inboxId });

    const { rows: stateRows } = await db.query(
      `SELECT p.status AS payment_status, p.succeeded_at,
              o.status AS order_status, r.status AS reservation_status,
              r.expires_at > now() AS reservation_unexpired,
              (SELECT count(*)::int FROM ledger_entries WHERE payment_id = p.id) AS ledger_count,
              (SELECT count(*)::int FROM refunds WHERE payment_id = p.id) AS refund_count
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       JOIN reservations r ON r.id = o.reservation_id
       WHERE p.id = $1`,
      [paymentId]
    );
    expect(stateRows[0]).toMatchObject({
      payment_status: 'late',
      order_status: 'reserved',
      reservation_status: 'active',
      reservation_unexpired: true,
      ledger_count: 1,
      refund_count: 1,
    });
    expect(stateRows[0].succeeded_at).toBeInstanceOf(Date);
    const { rows: refundRows } = await db.query(
      `SELECT trigger, status, amount::text AS amount, idempotency_key, reason
       FROM refunds WHERE payment_id = $1`,
      [paymentId]
    );
    expect(refundRows).toEqual([{
      trigger: 'system_expiry',
      status: 'requested',
      amount: '1550.50',
      idempotency_key: `refund:${paymentId}:late`,
      reason: 'Ineligible capture: order not awaiting payment',
    }]);
  });

  test('FR-61, FR-62: parallel processing and replay create one refund, capture, and audit for an ineligible capture', async () => {
    await db.query(
      "UPDATE orders SET status = 'reserved' WHERE id = $1",
      [orderId]
    );
    const signed = await createSignedEvent();
    const inboxId = await receiveSignedEvent(signed);
    await Promise.all(Array.from({ length: 5 }, () =>
      escrowPayments.processPaymentWebhookJob({ webhookInboxId: inboxId })));

    await postWebhook(signed.rawBody, signed.headers).expect(200, { received: true });
    await escrowPayments.processPaymentWebhookJob({ webhookInboxId: inboxId });

    const { rows } = await db.query(
      `SELECT
         (SELECT count(*)::int FROM ledger_entries
          WHERE payment_id = $1 AND entry_type = 'capture') AS ledger_count,
         (SELECT count(*)::int FROM refunds
          WHERE payment_id = $1) AS refund_count,
         (SELECT count(*)::int FROM refunds
          WHERE payment_id = $1 AND idempotency_key = $2) AS refund_key_count,
         (SELECT count(*)::int FROM money_audit_events
          WHERE payment_id = $1) AS audit_count`,
      [paymentId, `refund:${paymentId}:late`]
    );
    expect(rows[0]).toEqual({
      ledger_count: 1,
      refund_count: 1,
      refund_key_count: 1,
      audit_count: 1,
    });
  });

  test.each([
    ['amount mismatch', { amount: '1550.51' }, 'amount_mismatch'],
    ['currency mismatch', { currency: 'USD' }, 'currency_mismatch'],
    ['unmatched payment reference', { providerPaymentRef: 'unknown-payment-reference' }, 'unmatched_payment'],
    ['unsupported event type', { type: 'payment.refunded' }, 'unsupported_event_type'],
  ])('FR-61: %s is recorded as failed with one manual-review audit and no funding', async (_label, changes, code) => {
    const inboxId = await receiveSignedEvent(await createSignedEvent(undefined, changes));
    await escrowPayments.processPaymentWebhookJob({ webhookInboxId: inboxId });

    const { rows: inboxRows } = await db.query(
      'SELECT status, attempts, error_code FROM webhook_inbox WHERE id = $1',
      [inboxId]
    );
    expect(inboxRows[0]).toMatchObject({ status: 'failed', attempts: 1, error_code: code });
    const { rows: stateRows } = await db.query(
      `SELECT p.status AS payment_status, r.status AS reservation_status, o.status AS order_status,
              (SELECT count(*)::int FROM ledger_entries WHERE payment_id = p.id) AS ledger_count,
              (SELECT count(*)::int FROM refunds WHERE payment_id = p.id) AS refund_count
       FROM payments p JOIN orders o ON o.id = p.order_id
       JOIN reservations r ON r.id = o.reservation_id WHERE p.id = $1`,
      [paymentId]
    );
    expect(stateRows[0]).toEqual({
      payment_status: 'pending',
      reservation_status: 'active',
      order_status: 'payment_pending',
      ledger_count: 0,
      refund_count: 0,
    });
    const auditFilter = code === 'unmatched_payment'
      ? 'payment_id IS NULL AND order_id IS NULL'
      : 'payment_id = $2';
    const auditParams = code === 'unmatched_payment' ? [code] : [code, paymentId];
    const { rows: audits } = await db.query(
      `SELECT count(*)::int AS total
       FROM money_audit_events
       WHERE ${auditFilter} AND action = 'payment_webhook_manual_review' AND reason = $1`,
      auditParams
    );
    expect(audits[0].total).toBe(1);
  });

  test('FR-61: an inbox row without payment_id resolves the payment from the signed raw body', async () => {
    const inboxId = await receiveSignedEvent(await createSignedEvent());
    await db.query('UPDATE webhook_inbox SET payment_id = NULL WHERE id = $1', [inboxId]);

    await escrowPayments.processPaymentWebhookJob({ webhookInboxId: inboxId });

    const { rows } = await db.query(
      `SELECT inbox.payment_id, payment.status
       FROM webhook_inbox inbox JOIN payments payment ON payment.id = inbox.payment_id
       WHERE inbox.id = $1`,
      [inboxId]
    );
    expect(rows[0]).toEqual({ payment_id: paymentId, status: 'succeeded' });
  });

  test('FR-61: a worker database failure records a retryable code and a repeated job can finish', async () => {
    const inboxId = await receiveSignedEvent(await createSignedEvent());
    const sync = jest.spyOn(listings, 'syncAvailabilityProjection').mockRejectedValueOnce(
      new Error('synthetic transaction failure')
    );

    await expect(escrowPayments.processPaymentWebhookJob({ webhookInboxId: inboxId }))
      .rejects.toThrow('synthetic transaction failure');
    let { rows } = await db.query(
      'SELECT status, attempts, error_code FROM webhook_inbox WHERE id = $1',
      [inboxId]
    );
    expect(rows[0]).toEqual({
      status: 'received',
      attempts: 1,
      error_code: 'processing_error',
    });

    sync.mockRestore();
    await escrowPayments.processPaymentWebhookJob({ webhookInboxId: inboxId });
    ({ rows } = await db.query(
      'SELECT status, attempts, error_code FROM webhook_inbox WHERE id = $1',
      [inboxId]
    ));
    expect(rows[0]).toMatchObject({ status: 'processed', attempts: 2, error_code: null });
  });

  test('FR-61: ten worker and createOrReusePayment races for one order do not deadlock', async () => {
    const inboxId = await receiveSignedEvent(await createSignedEvent());
    const outcomes = await Promise.allSettled([
      ...Array.from({ length: 10 }, () =>
        escrowPayments.processPaymentWebhookJob({ webhookInboxId: inboxId })),
      ...Array.from({ length: 10 }, () =>
        escrowPayments.createOrReusePayment({ orderId, buyerId })),
    ]);

    const workerOutcomes = outcomes.slice(0, 10);
    const paymentOutcomes = outcomes.slice(10);
    expect(workerOutcomes.every((result) => result.status === 'fulfilled')).toBe(true);
    for (const result of paymentOutcomes) {
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(ConflictError);
    }
    expect(outcomes.some((result) => result.status === 'rejected' &&
      ['40P01', '40001'].includes(result.reason?.code))).toBe(false);
  });

  test('FR-60a, FR-61: checkout return and payment-status reads never fund an order', async () => {
    const e2eFixture = await createFixture({ askingPrice: '1250.50', listingStatus: 'published' });
    const e2eRecord = { fixture: e2eFixture, buyerId: null, orderId: null };
    additionalFixtures.push(e2eRecord);
    const e2eBuyerSuffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { rows: e2eBuyerRows } = await db.query(
      `INSERT INTO users (full_name, phone, password_hash, city_id, role)
       VALUES ($1, $2, 'fixture-hash', $3, 'buyer') RETURNING id`,
      [
        `Webhook E2E buyer ${e2eBuyerSuffix}`,
        `+1559${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 1000)}`,
        e2eFixture.cityId,
      ]
    );
    e2eRecord.buyerId = e2eBuyerRows[0].id;
    await db.query(
      `INSERT INTO supported_delivery_cities (city_id, active)
       VALUES ($1, true) ON CONFLICT (city_id) DO UPDATE SET active = true`,
      [e2eFixture.cityId]
    );

    const checkoutApp = express();
    let webhookDelivery;
    checkoutApp.use('/api/webhooks/payments', createPaymentWebhooksRouter());
    checkoutApp.use(express.json());
    checkoutApp.use('/api/listings', reservationsRoutes);
    checkoutApp.use('/api/orders', createEscrowPaymentsRouter({
      auth: (req, _res, next) => {
        req.user = { id: e2eRecord.buyerId };
        next();
      },
      limiter: (_req, _res, next) => next(),
    }));
    checkoutApp.use('/fake-gateway', createFakeGatewayRouter({
      webhookUrl: 'http://local.test/api/webhooks/payments/fake',
      fetchImpl: async (target, options) => {
        const response = await request(checkoutApp)
          .post(new URL(target).pathname)
          .set(options.headers)
          .send(options.body.toString('utf8'));
        webhookDelivery = { status: response.status, body: response.text?.slice(0, 300) };
        return { status: response.status, ok: response.status >= 200 && response.status < 300 };
      },
    }));
    checkoutApp.use(errorHandler);

    const buyResponse = await request(checkoutApp)
      .post(`/api/listings/${e2eFixture.listingId}/buy`)
      .set('Authorization', `Bearer ${signAccessToken(e2eRecord.buyerId, { secret: JWT_SECRET })}`)
      .send({ address: { ...ADDRESS, cityId: e2eFixture.cityId } })
      .expect(201);
    const e2eOrderId = buyResponse.body.orderId;
    e2eRecord.orderId = e2eOrderId;
    expect(buyResponse.body.status).toBe('reserved');

    const paymentResponse = await request(checkoutApp)
      .post(`/api/orders/${e2eOrderId}/payment`)
      .send({})
      .expect(201);
    expect(paymentResponse.body.status).toBe('pending');
    await request(checkoutApp)
      .get(`/api/orders/${e2eOrderId}/payment`)
      .expect(200)
      .expect((response) => expect(response.body.orderStatus).toBe('payment_pending'));

    const providerPaymentRef = paymentResponse.body.checkoutUrl.split('/').pop();
    const checkoutResponse = await request(checkoutApp)
      .post(`/fake-gateway/checkout/${providerPaymentRef}/complete`)
      .type('form')
      .send({ scenario: 'success' });
    if (checkoutResponse.status !== 303) {
      throw new Error(`Fake checkout webhook response: ${checkoutResponse.status}; route ${webhookDelivery?.status} ${webhookDelivery?.body}`);
    }
    const eventId = `fake:${providerPaymentRef}:success`;
    eventIds.push(eventId);
    const { rows: inboxRows } = await db.query(
      `SELECT id FROM webhook_inbox
       WHERE provider = 'fake' AND provider_event_id = $1`,
      [eventId]
    );
    expect(inboxRows).toHaveLength(1);

    await request(checkoutApp)
      .get(`/api/orders/${e2eOrderId}/payment`)
      .expect(200)
      .expect((response) => expect(response.body.orderStatus).toBe('payment_pending'));
    await escrowPayments.processPaymentWebhookJob({ webhookInboxId: inboxRows[0].id });
    await request(checkoutApp)
      .get(`/api/orders/${e2eOrderId}/payment`)
      .expect(200)
      .expect((response) => {
        expect(response.body.orderStatus).toBe('funded');
        expect(response.body.status).toBe('succeeded');
      });
    expect(await discovery.getListingStatus(e2eFixture.listingId)).toMatchObject({
      status: 'sold',
      sold: true,
    });
    const { rows: searchJobs } = await db.query(
      `SELECT data FROM pgboss.job
       WHERE name = $1 AND data->>'listingId' = $2
       ORDER BY (data->>'searchVersion')::int DESC NULLS LAST`,
      [queue.QUEUES.LISTING_SEARCH, e2eFixture.listingId]
    );
    expect(searchJobs.length).toBeGreaterThan(0);
    await listingSearch.processListingSearchJob(searchJobs[0].data);
    const { rows: indexedRows } = await db.query(
      'SELECT is_sold FROM listing_search WHERE listing_id = $1',
      [e2eFixture.listingId]
    );
    expect(indexedRows).toEqual([{ is_sold: true }]);
  });
});
