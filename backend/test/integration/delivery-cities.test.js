const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');
const { signAccessToken } = require('../../src/lib/jwt');
const { getSharedRedisClient, setSharedRedisClient } = require('../../src/lib/redis');

const JWT_SECRET = 'delivery-cities-integration-secret';
const ENV_KEYS = [
  'JWT_ACCESS_SECRET',
  'NODE_ENV',
  'PAYMENTS_ENABLED',
  'PAYMENT_GATEWAY_PROVIDER',
  'FAKE_GATEWAY_WEBHOOK_SECRET',
  'PAYMENT_WEBHOOK_URL',
  'PUBLIC_BASE_URL',
  'RATE_LIMIT_ADMIN_OPS_IP_MAX',
  'RATE_LIMIT_ADMIN_OPS_ACCOUNT_MAX',
];
const originalEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalRedisClient = getSharedRedisClient();

process.env.JWT_ACCESS_SECRET = JWT_SECRET;
process.env.NODE_ENV = 'test';
process.env.PAYMENTS_ENABLED = '1';
process.env.PAYMENT_GATEWAY_PROVIDER = 'fake';
process.env.FAKE_GATEWAY_WEBHOOK_SECRET = 'delivery-cities-test-webhook-secret';
process.env.PAYMENT_WEBHOOK_URL = 'http://127.0.0.1:39991/api/webhooks/payments/fake';
process.env.PUBLIC_BASE_URL = 'http://localhost:5173';
process.env.RATE_LIMIT_ADMIN_OPS_IP_MAX = '1000';
process.env.RATE_LIMIT_ADMIN_OPS_ACCOUNT_MAX = '1000';
setSharedRedisClient({ isOpen: true, eval: async () => [1, 1] });

const db = require('../../src/db.service');
const app = require('../../src/app');
const { createFixture, cleanupListingProjections } = require('./fixtures');

let fixture;
let adminId;
let moderatorId;
let buyerId;
let inactiveCityId;
let additionalListingId;
let orderIds;
let reservationIds;

function authHeader(userId) {
  return `Bearer ${signAccessToken(userId, { secret: JWT_SECRET })}`;
}

function adminRequest(method, path, body) {
  const call = request(app)[method](path).set('Authorization', authHeader(adminId));
  return body === undefined ? call : call.send(body);
}

async function createUser(role) {
  const suffix = crypto.randomUUID();
  const { rows } = await db.query(
    `INSERT INTO users (full_name, phone, password_hash, city_id, role)
     VALUES ($1, $2, 'delivery-cities-test-hash', $3, $4)
     RETURNING id`,
    [`Delivery cities ${role} ${suffix}`, `+155${Date.now().toString().slice(-9)}${suffix.replace(/\D/g, '').slice(0, 3)}`, fixture.cityId, role]
  );
  return rows[0].id;
}

async function makeAddress(cityId) {
  return {
    recipientName: 'Delivery Cities Buyer',
    phone: '+15551234567',
    cityId,
    addressLine1: '12 Delivery Street',
  };
}

beforeEach(async () => {
  fixture = await createFixture({ askingPrice: '1250.50', listingStatus: 'published' });
  await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [fixture.otherUserId]);
  adminId = fixture.otherUserId;
  moderatorId = await createUser('moderator');
  buyerId = await createUser('buyer');
  orderIds = [];
  reservationIds = [];
});

afterEach(async () => {
  try {
    if (global.drainIntegrationListeners) await global.drainIntegrationListeners(5000);
    if (orderIds.length) {
      await db.query('DELETE FROM payments WHERE order_id = ANY($1::uuid[])', [orderIds]);
      await db.query('DELETE FROM orders WHERE id = ANY($1::uuid[])', [orderIds]);
    }
    if (reservationIds.length) {
      await db.query('DELETE FROM reservations WHERE id = ANY($1::uuid[])', [reservationIds]);
    }
    if (fixture) {
      if (additionalListingId) await cleanupListingProjections(additionalListingId);
      await db.query(
        'DELETE FROM supported_delivery_cities WHERE city_id = ANY($1::uuid[])',
        [[fixture.cityId, ...(inactiveCityId ? [inactiveCityId] : [])]]
      );
      await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[moderatorId, buyerId].filter(Boolean)]);
      if (inactiveCityId) await db.query('DELETE FROM cities WHERE id = $1', [inactiveCityId]);
      await fixture.cleanup();
    }
  } finally {
    fixture = null;
    adminId = null;
    moderatorId = null;
    buyerId = null;
    inactiveCityId = null;
    additionalListingId = null;
    orderIds = [];
    reservationIds = [];
  }
});

afterAll(() => {
  setSharedRedisClient(originalRedisClient);
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('FR-86 Admin delivery-city management', () => {
  test('FR-86: only an Admin can list delivery cities and Admin responses are not cached', async () => {
    const responses = await Promise.all([
      request(app).get('/api/admin/delivery-cities').set('Authorization', authHeader(adminId)),
      request(app).get('/api/admin/delivery-cities').set('Authorization', authHeader(moderatorId)),
      request(app).get('/api/admin/delivery-cities').set('Authorization', authHeader(buyerId)),
      request(app).get('/api/admin/delivery-cities'),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([200, 403, 403, 401]);
    expect(responses[0].headers['cache-control']).toBe('private, no-store');
    expect(responses[0].body).toEqual(expect.arrayContaining([
      expect.objectContaining({ cityId: fixture.cityId, active: false }),
    ]));
  });

  test('FR-86: lists every city, including an inactive city with no supported-delivery row', async () => {
    const { rows } = await db.query(
      'INSERT INTO cities (name) VALUES ($1) RETURNING id',
      [`Unconfigured delivery city ${fixture.suffix}`]
    );
    inactiveCityId = rows[0].id;

    const response = await request(app)
      .get('/api/admin/delivery-cities')
      .set('Authorization', authHeader(adminId))
      .expect(200);
    const expected = await db.query(
      `SELECT city.id AS "cityId", city.name,
              COALESCE(supported.active, false) AS active
       FROM cities city
       LEFT JOIN supported_delivery_cities supported ON supported.city_id = city.id
       ORDER BY city.name, city.id`
    );

    expect(response.body).toEqual(expected.rows);
    expect(response.body.find((city) => city.cityId === inactiveCityId)).toMatchObject({
      cityId: inactiveCityId,
      active: false,
    });
  });

  test('FR-86: activates and deactivates a city idempotently and the public list updates immediately', async () => {
    const path = `/api/admin/delivery-cities/${fixture.cityId}`;
    await adminRequest('put', path, { active: true })
      .expect(200)
      .expect('Cache-Control', 'private, no-store')
      .expect(({ body }) => expect(body).toEqual({ cityId: fixture.cityId, active: true }));
    const { rows: beforeRows } = await db.query(
      'SELECT active, created_at, updated_at FROM supported_delivery_cities WHERE city_id = $1',
      [fixture.cityId]
    );
    await adminRequest('put', path, { active: true }).expect(200);
    const { rows: afterRows } = await db.query(
      'SELECT active, created_at, updated_at FROM supported_delivery_cities WHERE city_id = $1',
      [fixture.cityId]
    );
    expect(afterRows).toEqual(beforeRows);
    const { rows: countRows } = await db.query(
      'SELECT count(*)::int AS count FROM supported_delivery_cities WHERE city_id = $1',
      [fixture.cityId]
    );
    expect(countRows[0].count).toBe(1);

    const activePublicList = await request(app).get('/api/delivery-cities')
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(activePublicList.body).toContainEqual({ id: fixture.cityId, name: expect.any(String) });

    await adminRequest('put', path, { active: false })
      .expect(200)
      .expect(({ body }) => expect(body).toEqual({ cityId: fixture.cityId, active: false }));
    const inactivePublicList = await request(app).get('/api/delivery-cities').expect(200);
    expect(inactivePublicList.body.some((city) => city.id === fixture.cityId)).toBe(false);
  });

  test('FR-86: unknown city ids return 404 and malformed ids or active values return 400', async () => {
    await adminRequest('put', `/api/admin/delivery-cities/${crypto.randomUUID()}`, { active: true }).expect(404);
    await adminRequest('put', '/api/admin/delivery-cities/not-a-uuid', { active: true }).expect(400);
    await adminRequest('put', `/api/admin/delivery-cities/${fixture.cityId}`, { active: 'true' }).expect(400);
    await adminRequest('put', `/api/admin/delivery-cities/${fixture.cityId}`, { active: true, note: 'not allowed' }).expect(400);
  });

  test('FR-86: Buy accepts a supported city, while deactivation blocks new buys without changing existing orders', async () => {
    await adminRequest('put', `/api/admin/delivery-cities/${fixture.cityId}`, { active: true }).expect(200);
    const address = await makeAddress(fixture.cityId);
    const created = await request(app)
      .post(`/api/listings/${fixture.listingId}/buy`)
      .set('Authorization', authHeader(buyerId))
      .send({ address })
      .expect(201);
    orderIds.push(created.body.orderId);
    reservationIds.push(created.body.reservationId);

    const { rows: listingRows } = await db.query(
      `INSERT INTO listings
         (seller_id, main_category_id, sub_category_id, condition, title, asking_price, status, published_at)
       VALUES ($1, $2, $3, 'brand_new', $4, '1250.50', 'published', now())
       RETURNING id`,
      [fixture.userId, fixture.categoryId, fixture.subCategoryId, `Second delivery city listing ${fixture.suffix}`]
    );
    additionalListingId = listingRows[0].id;
    await adminRequest('put', `/api/admin/delivery-cities/${fixture.cityId}`, { active: false }).expect(200);

    await request(app)
      .post(`/api/listings/${additionalListingId}/buy`)
      .set('Authorization', authHeader(buyerId))
      .send({ address })
      .expect(422);
    const { rows: orderRows } = await db.query(
      `SELECT orders.status AS order_status, reservations.status AS reservation_status
       FROM orders
       JOIN reservations ON reservations.id = orders.reservation_id
       WHERE orders.id = $1`,
      [created.body.orderId]
    );
    expect(orderRows[0]).toEqual({ order_status: 'reserved', reservation_status: 'active' });
  });
});
