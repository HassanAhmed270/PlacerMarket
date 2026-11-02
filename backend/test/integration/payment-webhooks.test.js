const crypto = require('node:crypto');
const request = require('supertest');
const db = require('../../src/db.service');
const queue = require('../../src/lib/queue');
const app = require('../../src/app');
const reservations = require('../../src/modules/reservations.service');
const escrowPayments = require('../../src/modules/escrowPayments.service');
const { buildSignedFakeEvent } = require('../../src/lib/adapters/fakePaymentGateway');
const { createFixture } = require('./fixtures');

const ADDRESS = {
  recipientName: 'Webhook Test Recipient',
  phone: '+15551234567',
  cityId: '',
  addressLine1: '12 Webhook Test Street',
};
const ENV_KEYS = [
  'NODE_ENV',
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

async function createSignedEvent(id = eventId()) {
  return buildSignedFakeEvent({
    type: 'payment.succeeded',
    providerPaymentRef: paymentRef,
    amount: '1550.50',
    currency: 'PKR',
    eventId: id,
    now: new Date(),
  });
}

beforeEach(async () => {
  originalEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = 'test';
  process.env.PAYMENT_GATEWAY_PROVIDER = 'fake';
  process.env.FAKE_GATEWAY_WEBHOOK_SECRET =
    `integration-fake-webhook-secret-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  process.env.PAYMENT_WEBHOOK_URL = 'http://127.0.0.1:39991/api/webhooks/payments/fake';
  process.env.FAKE_GATEWAY_WEBHOOK_TOLERANCE_SECONDS = '300';
  process.env.PUBLIC_BASE_URL = 'http://localhost:5173';

  fixture = await createFixture({ askingPrice: '1250.50', listingStatus: 'published' });
  eventIds = [];
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
    if (orderId) await db.query('DELETE FROM payments WHERE order_id = $1', [orderId]);
    if (fixture) {
      await db.query('DELETE FROM orders WHERE listing_id = $1', [fixture.listingId]);
      await db.query('DELETE FROM reservations WHERE listing_id = $1', [fixture.listingId]);
      await db.query('DELETE FROM supported_delivery_cities WHERE city_id = $1', [fixture.cityId]);
      if (buyerId) await db.query('DELETE FROM users WHERE id = $1', [buyerId]);
      await fixture.cleanup();
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
