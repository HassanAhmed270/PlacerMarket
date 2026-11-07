const crypto = require('node:crypto');
const { Pool } = require('pg');
const request = require('supertest');
const { signAccessToken } = require('../../src/lib/jwt');
const { getSharedRedisClient, setSharedRedisClient } = require('../../src/lib/redis');

const JWT_SECRET = 'delivery-handover-integration-secret';
const ENV_KEYS = [
  'NODE_ENV',
  'JWT_ACCESS_SECRET',
  'PAYMENTS_ENABLED',
  'PAYMENT_GATEWAY_PROVIDER',
  'FAKE_GATEWAY_WEBHOOK_SECRET',
  'PAYMENT_WEBHOOK_URL',
  'PUBLIC_BASE_URL',
  'RATE_LIMIT_SECURITY_IP_MAX',
  'RATE_LIMIT_SECURITY_ACCOUNT_MAX',
  'RATE_LIMIT_ADMIN_OPS_IP_MAX',
  'RATE_LIMIT_ADMIN_OPS_ACCOUNT_MAX',
  'RATE_LIMIT_PAYMENTS_IP_MAX',
  'RATE_LIMIT_PAYMENTS_ACCOUNT_MAX',
];
const originalEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalRedisClient = getSharedRedisClient();

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = JWT_SECRET;
process.env.PAYMENTS_ENABLED = '1';
process.env.PAYMENT_GATEWAY_PROVIDER = 'fake';
process.env.FAKE_GATEWAY_WEBHOOK_SECRET = 'delivery-handover-fake-webhook-secret';
process.env.PAYMENT_WEBHOOK_URL = 'http://127.0.0.1:39991/api/webhooks/payments/fake';
process.env.PUBLIC_BASE_URL = 'http://localhost:5173';
process.env.RATE_LIMIT_SECURITY_IP_MAX = '1000';
process.env.RATE_LIMIT_SECURITY_ACCOUNT_MAX = '1000';
process.env.RATE_LIMIT_ADMIN_OPS_IP_MAX = '1000';
process.env.RATE_LIMIT_ADMIN_OPS_ACCOUNT_MAX = '1000';
process.env.RATE_LIMIT_PAYMENTS_IP_MAX = '1000';
process.env.RATE_LIMIT_PAYMENTS_ACCOUNT_MAX = '1000';
setSharedRedisClient({ isOpen: true, eval: async () => [1, 1] });

const db = require('../../src/db.service');
const app = require('../../src/app');
const reservations = require('../../src/modules/reservations.service');
const escrowPayments = require('../../src/modules/escrowPayments.service');
const { createFixture, cleanupListingProjections } = require('./fixtures');

function authHeader(userId) {
  return `Bearer ${signAccessToken(userId, { secret: JWT_SECRET })}`;
}

async function createUser(harness, role) {
  const suffix = crypto.randomUUID();
  const { rows } = await db.query(
    `INSERT INTO users (full_name, phone, password_hash, city_id, role)
     VALUES ($1, $2, 'fixture-hash', $3, $4) RETURNING id`,
    [
      `Handover ${role} ${suffix}`,
      `+1557${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`,
      harness.fixture.cityId,
      role,
    ]
  );
  harness.extraUserIds.push(rows[0].id);
  return rows[0].id;
}

async function createHarness() {
  const fixture = await createFixture({ askingPrice: '1250.50', listingStatus: 'draft' });
  const harness = {
    fixture,
    adminId: fixture.otherUserId,
    moderatorId: null,
    unrelatedBuyerId: null,
    extraUserIds: [],
    retained: false,
  };
  await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [harness.adminId]);
  harness.moderatorId = await createUser(harness, 'moderator');
  harness.unrelatedBuyerId = await createUser(harness, 'buyer');
  await db.query(
    `INSERT INTO supported_delivery_cities (city_id, active)
     VALUES ($1, true) ON CONFLICT (city_id) DO UPDATE SET active = true`,
    [fixture.cityId]
  );
  return harness;
}

async function createListing(harness, sellerId = harness.fixture.userId) {
  const { rows } = await db.query(
    `INSERT INTO listings
       (seller_id, main_category_id, sub_category_id, condition, title, asking_price, status, published_at)
     VALUES ($1, $2, $3, 'brand_new', $4, '1250.50', 'published', now())
     RETURNING id`,
    [
      sellerId,
      harness.fixture.categoryId,
      harness.fixture.subCategoryId,
      `Handover listing ${crypto.randomUUID()}`,
    ]
  );
  return rows[0].id;
}

async function createScenario(harness, sellerId = harness.fixture.userId) {
  const listingId = await createListing(harness, sellerId);
  const buyerId = await createUser(harness, 'buyer');
  const reservation = await reservations.buyListing(listingId, buyerId, {
    address: {
      recipientName: 'Handover Test Recipient',
      phone: '+15551234567',
      cityId: harness.fixture.cityId,
      addressLine1: '12 Handover Test Street',
    },
  });
  const payment = await escrowPayments.createOrReusePayment({
    orderId: reservation.orderId,
    buyerId,
  });
  const scenario = {
    listingId,
    buyerId,
    orderId: reservation.orderId,
    reservationId: reservation.reservationId,
    paymentId: payment.paymentId,
    fixture: harness.fixture,
  };
  await db.withTransaction(async (client) => {
    await client.query(
      `UPDATE reservations SET status = 'paid', paid_at = now()
       WHERE id = $1`,
      [scenario.reservationId]
    );
    await client.query(
      `UPDATE orders
       SET status = 'funded', funded_at = now() - INTERVAL '10 minutes',
           handover_deadline_at = now() + INTERVAL '71 hours 50 minutes'
       WHERE id = $1`,
      [scenario.orderId]
    );
    await client.query(
      `UPDATE payments SET status = 'succeeded', succeeded_at = now()
       WHERE id = $1`,
      [scenario.paymentId]
    );
  });
  harness.scenarios ||= [];
  harness.scenarios.push(scenario);
  return scenario;
}

async function setDeadlinePast(scenario) {
  await db.query(
    `UPDATE orders
     SET funded_at = now() - INTERVAL '74 hours',
         handover_deadline_at = now() - INTERVAL '2 hours'
     WHERE id = $1`,
    [scenario.orderId]
  );
}

async function pickupTime(scenario, expression = "now() - INTERVAL '5 minutes'") {
  const { rows } = await db.query(
    `SELECT ${expression} AS pickup_at
     FROM orders WHERE id = $1`,
    [scenario.orderId]
  );
  return rows[0].pickup_at.toISOString();
}

async function validHandoverBody(scenario, overrides = {}) {
  return {
    status: 'handed_to_delivery',
    courierPickupAt: await pickupTime(scenario),
    handoverConfirmationNote: 'Courier pickup confirmed by Admin',
    ...overrides,
  };
}

function adminHandoverRequest(harness, scenario, body) {
  return request(app)
    .patch(`/api/admin/orders/${scenario.orderId}/delivery`)
    .set('Authorization', authHeader(harness.adminId))
    .send(body);
}

function adminDeliveredRequest(harness, scenario, body) {
  return request(app)
    .post(`/api/admin/orders/${scenario.orderId}/delivered`)
    .set('Authorization', authHeader(harness.adminId))
    .send(body);
}

function buyerCancelRequest(scenario) {
  return request(app)
    .post(`/api/orders/${scenario.orderId}/cancel`)
    .set('Authorization', authHeader(scenario.buyerId));
}

async function createLegacyOrder(harness, scenario) {
  const { rows: conversations } = await db.query(
    `INSERT INTO conversations (listing_id, buyer_id, seller_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [scenario.listingId, scenario.buyerId, harness.fixture.userId]
  );
  const { rows: offers } = await db.query(
    `INSERT INTO offers (conversation_id, listing_id, proposed_by, amount, status)
     VALUES ($1, $2, $3, 1250.50, 'accepted') RETURNING id`,
    [conversations[0].id, scenario.listingId, scenario.buyerId]
  );
  const { rows } = await db.query(
    `INSERT INTO orders
       (accepted_offer_id, listing_id, buyer_id, seller_id, agreed_item_price,
        delivery_fee, delivery_address, payment_method_preference, status)
     VALUES ($1, $2, $3, $4, 1250.50, 0, '', 'cash', 'order_placed')
     RETURNING id`,
    [offers[0].id, scenario.listingId, scenario.buyerId, harness.fixture.userId]
  );
  scenario.legacyOrderId = rows[0].id;
  return rows[0].id;
}

async function cleanupScenario(harness, scenario) {
  const { rows } = await db.query(
    'SELECT EXISTS (SELECT 1 FROM money_audit_events WHERE order_id = $1) AS retained',
    [scenario.orderId]
  );
  if (rows[0].retained) {
    await db.query(
      `UPDATE refunds
       SET requested_at = now() + INTERVAL '1 day',
           updated_at = now() + INTERVAL '1 day'
       WHERE order_id = $1 AND status IN ('requested', 'pending', 'failed')`,
      [scenario.orderId]
    );
    await db.query(
      'DELETE FROM webhook_inbox WHERE payment_id = $1',
      [scenario.paymentId]
    );
    harness.retained = true;
    return;
  }
  await db.query('DELETE FROM order_exceptions WHERE order_id = $1', [scenario.orderId]);
  await db.query('DELETE FROM payout_holds WHERE order_id = $1', [scenario.orderId]);
  await db.query(
    'DELETE FROM delivery_status_log WHERE order_id IN (SELECT id FROM orders WHERE listing_id = $1)',
    [scenario.listingId]
  );
  await db.query('DELETE FROM webhook_inbox WHERE payment_id = $1', [scenario.paymentId]);
  await db.query('DELETE FROM refunds WHERE order_id = $1', [scenario.orderId]);
  await db.query('DELETE FROM payments WHERE order_id = $1', [scenario.orderId]);
  if (scenario.legacyOrderId) {
    await db.query('DELETE FROM orders WHERE id = $1', [scenario.legacyOrderId]);
  }
  await db.query('DELETE FROM orders WHERE id = $1', [scenario.orderId]);
  await db.query('DELETE FROM reservations WHERE id = $1', [scenario.reservationId]);
  await db.query(
    `DELETE FROM offers WHERE conversation_id IN (
       SELECT id FROM conversations WHERE listing_id = $1
     )`,
    [scenario.listingId]
  );
  await db.query('DELETE FROM conversations WHERE listing_id = $1', [scenario.listingId]);
  await db.query('DELETE FROM notifications WHERE user_id = $1', [scenario.buyerId]);
  await cleanupListingProjections(scenario.listingId);
  await db.query('DELETE FROM listings WHERE id = $1', [scenario.listingId]);
  await db.query('DELETE FROM users WHERE id = $1', [scenario.buyerId]);
}

async function cleanupHarness(harness) {
  if (!harness) return;
  if (harness.retained) {
    const cleanupPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      await cleanupPool.query("UPDATE users SET role = 'seller' WHERE id = $1", [harness.adminId]);
    } finally {
      await cleanupPool.end();
    }
    return;
  }
  await db.query('DELETE FROM supported_delivery_cities WHERE city_id = $1', [harness.fixture.cityId]);
  await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [harness.extraUserIds]);
  await harness.fixture.cleanup();
}

function restoreHandoverTestEnvironment() {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setSharedRedisClient(originalRedisClient);
}

module.exports = {
  adminDeliveredRequest,
  adminHandoverRequest,
  authHeader,
  buyerCancelRequest,
  cleanupHarness,
  cleanupScenario,
  createHarness,
  createLegacyOrder,
  createScenario,
  db,
  escrowPayments,
  getApp: () => app,
  pickupTime,
  request,
  restoreHandoverTestEnvironment,
  setDeadlinePast,
  validHandoverBody,
};
