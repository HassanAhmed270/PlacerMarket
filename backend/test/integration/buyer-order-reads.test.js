const express = require('express');
const request = require('supertest');
const db = require('../../src/db.service');
const routes = require('../../src/routes');
const { cachePolicy } = require('../../src/middleware/cachePolicy');
const errorHandler = require('../../src/middleware/errorHandler');
const { getSharedRedisClient, setSharedRedisClient } = require('../../src/lib/redis');
const reservations = require('../../src/modules/reservations.service');
const { signAccessToken } = require('../../src/lib/jwt');
const { createFixture, cleanupListingProjections } = require('./fixtures');

const JWT_SECRET = 'integration-buyer-order-reads-access-secret';
const ADDRESS = {
  recipientName: 'Demo Buyer',
  phone: '+15551234567',
  cityId: '',
  addressLine1: '12 Demo Street',
  addressLine2: 'Apartment 4',
  postalCode: '54000',
};
const ENV_KEYS = ['JWT_ACCESS_SECRET', 'PAYMENTS_ENABLED', 'NODE_ENV'];

let originalEnvironment;
let fixture;
let buyerId;
let otherBuyerId;
let extraCityId;
let orderIds;
let reservationIds;
let originalRedisClient;

function authHeader(userId) {
  return `Bearer ${signAccessToken(userId, { secret: JWT_SECRET })}`;
}

function mountedApiApp() {
  const app = express();
  app.use('/api', cachePolicy);
  app.use(express.json());
  app.use('/api', routes);
  app.use(errorHandler);
  return app;
}

async function createBuyer(label) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const { rows } = await db.query(
    `INSERT INTO users (full_name, phone, password_hash, city_id, role)
     VALUES ($1, $2, 'fixture-hash', $3, 'buyer') RETURNING id`,
    [`${label} ${suffix}`, `+1557${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 1000)}`, fixture.cityId]
  );
  return rows[0].id;
}

async function createReservation() {
  const result = await reservations.buyListing(fixture.listingId, buyerId, {
    address: { ...ADDRESS, cityId: fixture.cityId },
  });
  orderIds.push(result.orderId);
  reservationIds.push(result.reservationId);
  return result;
}

beforeEach(async () => {
  originalEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  originalRedisClient = getSharedRedisClient();
  setSharedRedisClient({ isOpen: true, eval: async () => [1, 1] });
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET = JWT_SECRET;
  process.env.PAYMENTS_ENABLED = '0';

  fixture = await createFixture({ askingPrice: '1250.50', listingStatus: 'published' });
  orderIds = [];
  reservationIds = [];
  buyerId = await createBuyer('Order-read buyer');
  otherBuyerId = await createBuyer('Other order-read buyer');
  await db.query(
    `INSERT INTO supported_delivery_cities (city_id, active)
     VALUES ($1, true) ON CONFLICT (city_id) DO UPDATE SET active = true`,
    [fixture.cityId]
  );
});

afterEach(async () => {
  try {
    if (fixture) await cleanupListingProjections(fixture.listingId);
    if (orderIds?.length) {
      await db.query('DELETE FROM payments WHERE order_id = ANY($1::uuid[])', [orderIds]);
      await db.query('DELETE FROM orders WHERE id = ANY($1::uuid[])', [orderIds]);
    }
    if (reservationIds?.length) {
      await db.query('DELETE FROM reservations WHERE id = ANY($1::uuid[])', [reservationIds]);
    }
    if (fixture) {
      await db.query(
        'DELETE FROM supported_delivery_cities WHERE city_id = ANY($1::uuid[])',
        [[fixture.cityId, ...(extraCityId ? [extraCityId] : [])]]
      );
      await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[buyerId, otherBuyerId].filter(Boolean)]);
      if (extraCityId) await db.query('DELETE FROM cities WHERE id = $1', [extraCityId]);
      await fixture.cleanup();
    }
  } finally {
    extraCityId = null;
    setSharedRedisClient(originalRedisClient);
    for (const [key, value] of Object.entries(originalEnvironment || {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

describe('FR-60a public delivery cities', () => {
  test('FR-60a: the public list contains only active supported cities in name order', async () => {
    const { rows: cityRows } = await db.query(
      'INSERT INTO cities (name) VALUES ($1) RETURNING id',
      [`Unsupported city ${fixture.suffix}`]
    );
    extraCityId = cityRows[0].id;
    await db.query(
      'INSERT INTO supported_delivery_cities (city_id, active) VALUES ($1, false)',
      [extraCityId]
    );

    const { rows: expected } = await db.query(
      `SELECT city.id, city.name
       FROM supported_delivery_cities supported
       JOIN cities city ON city.id = supported.city_id
       WHERE supported.active = true
       ORDER BY city.name, city.id`
    );
    const response = await request(mountedApiApp()).get('/api/delivery-cities').expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual(expected);
    expect(response.body.some((city) => city.id === extraCityId)).toBe(false);
    expect(response.body.every((city) => Object.keys(city).sort().join(',') === 'id,name')).toBe(true);
  });
});

describe('FR-61, FR-62 buyer order reads', () => {
  test('FR-43, FR-61, FR-62: summary returns filing eligibility and only safe order fields', async () => {
    const reservation = await createReservation();
    await db.query(
      `INSERT INTO payments
         (order_id, provider, provider_payment_id, provider_reference, status,
          amount, currency, gateway_fee_currency, idempotency_key, hosted_checkout_url)
       VALUES ($1, 'fake', 'internal-provider-id-must-not-leak',
               'internal-reference-must-not-leak', 'pending', $2, 'PKR', 'PKR',
               $3, 'https://payments.example.test/session')`,
      [reservation.orderId, reservation.total, `reads:${reservation.reservationId}`]
    );

    const response = await request(mountedApiApp())
      .get(`/api/orders/${reservation.orderId}/summary`)
      .set('Authorization', authHeader(buyerId))
      .expect(200);

    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(Object.keys(response.body).sort()).toEqual([
      'address', 'createdAt', 'currency', 'deliveryFee', 'disputeFiling', 'handoverDeadlineAt',
      'itemPrice', 'listing', 'orderId', 'payment', 'reservation', 'status', 'total',
    ]);
    expect(response.body).toMatchObject({
      orderId: reservation.orderId,
      disputeFiling: {
        canFileDispute: false,
        disputeStatus: null,
        complaintWindowClosesAt: null,
        maxEvidenceUrls: 2,
      },
      listing: { id: fixture.listingId, title: expect.stringContaining('Fixture listing'), imageUrl: null },
      status: 'reserved',
      itemPrice: '1250.50',
      deliveryFee: '300.00',
      total: '1550.50',
      currency: 'PKR',
      reservation: { status: 'active' },
      payment: { status: 'pending', checkoutUrl: 'https://payments.example.test/session' },
      handoverDeadlineAt: null,
      address: {
        recipientName: ADDRESS.recipientName,
        city: expect.any(String),
        addressLine1: ADDRESS.addressLine1,
      },
    });
    expect(Object.keys(response.body.payment).sort()).toEqual(['checkoutUrl', 'status']);
    expect(JSON.stringify(response.body)).not.toContain('internal-provider-id-must-not-leak');
    expect(JSON.stringify(response.body)).not.toContain('internal-reference-must-not-leak');
    expect(JSON.stringify(response.body)).not.toContain(fixture.userId);
    expect(JSON.stringify(response.body)).not.toContain(otherBuyerId);
    expect(response.body.address).not.toHaveProperty('addressLine2');
    expect(response.body.address).not.toHaveProperty('postalCode');
  });

  test('FR-61, FR-62: mine contains only the caller reservation-backed orders with decimal-string totals', async () => {
    const reservation = await createReservation();
    const response = await request(mountedApiApp())
      .get('/api/orders/mine?limit=20')
      .set('Authorization', authHeader(buyerId))
      .expect(200);

    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toHaveLength(1);
    expect(Object.keys(response.body[0]).sort()).toEqual([
      'createdAt', 'currency', 'listingId', 'orderId', 'reservationExpiresAt', 'status', 'title', 'total',
    ]);
    expect(response.body[0]).toMatchObject({
      orderId: reservation.orderId,
      listingId: fixture.listingId,
      title: expect.stringContaining('Fixture listing'),
      status: 'reserved',
      total: '1550.50',
      currency: 'PKR',
    });
    expect(typeof response.body[0].reservationExpiresAt).toBe('string');
    expect(JSON.stringify(response.body)).not.toContain(fixture.userId);
    expect(JSON.stringify(response.body)).not.toContain(otherBuyerId);

    const otherBuyerOrders = await request(mountedApiApp())
      .get('/api/orders/mine')
      .set('Authorization', authHeader(otherBuyerId))
      .expect(200);
    expect(otherBuyerOrders.body).toEqual([]);
    await request(mountedApiApp())
      .get(`/api/orders/${reservation.orderId}/summary`)
      .set('Authorization', authHeader(otherBuyerId))
      .expect(404);
  });

  test('FR-61, FR-62: private order reads require authentication and work while payments are disabled', async () => {
    const reservation = await createReservation();

    const summary = await request(mountedApiApp())
      .get(`/api/orders/${reservation.orderId}/summary`)
      .set('Authorization', authHeader(buyerId))
      .expect(200);
    const mine = await request(mountedApiApp())
      .get('/api/orders/mine')
      .set('Authorization', authHeader(buyerId))
      .expect(200);

    expect(summary.body.payment).toBeNull();
    expect(mine.body).toHaveLength(1);
    await request(mountedApiApp()).get('/api/orders/mine').expect(401);
    await request(mountedApiApp())
      .get(`/api/orders/${reservation.orderId}/summary`)
      .expect(401);
  });
});
