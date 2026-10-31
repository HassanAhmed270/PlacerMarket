const request = require('supertest');
const db = require('../../src/db.service');
const app = require('../../src/app');
const orders = require('../../src/modules/orders.service');
const payments = require('../../src/modules/payments.service');
const payout = require('../../src/modules/payout.service');
const { signAccessToken } = require('../../src/lib/jwt');
const { createFixture } = require('./fixtures');

const JWT_SECRET = 'integration-reservation-access-secret-with-32-bytes';
const ADDRESS = {
  recipientName: '  Test Recipient  ',
  phone: ' +15551234567 ',
  cityId: '',
  addressLine1: '  12 Test Street  ',
  addressLine2: '  Unit 4  ',
  postalCode: '  10001  ',
};
const RESERVATION_SETTING_KEYS = [
  'reservation_minutes',
  'max_unpaid_reservations',
  'delivery_fee_pkr',
];

let fixture;
let buyerId;
let listingIds;
let additionalUserIds;
let originalEnvironment;
let originalSettings;

function authHeader(userId) {
  return `Bearer ${signAccessToken(userId, { secret: JWT_SECRET })}`;
}

function buy(listingId, userId, body = {}) {
  return request(app)
    .post(`/api/listings/${listingId}/buy`)
    .set('Authorization', authHeader(userId))
    .send({ address: { ...ADDRESS, cityId: fixture.cityId }, ...body });
}

async function createBuyer() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const { rows } = await db.query(
    `INSERT INTO users (full_name, phone, password_hash, city_id, role)
     VALUES ($1, $2, 'fixture-hash', $3, 'buyer') RETURNING id`,
    [`Reservation buyer ${suffix}`, `+1557${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 1000)}`, fixture.cityId]
  );
  additionalUserIds.push(rows[0].id);
  return rows[0].id;
}

async function createListing({ status = 'published', askingPrice = '1250.50' } = {}) {
  const { rows } = await db.query(
    `INSERT INTO listings
       (seller_id, main_category_id, sub_category_id, condition, title, asking_price, status)
     VALUES ($1, $2, $3, 'brand_new', $4, $5, $6) RETURNING id`,
    [fixture.userId, fixture.categoryId, fixture.subCategoryId, `Reservation listing ${Date.now()}-${Math.random()}`, askingPrice, status]
  );
  listingIds.push(rows[0].id);
  return rows[0].id;
}

async function createReservation({
  listingId,
  buyer = buyerId,
  status = 'active',
  expires = "now() + interval '30 minutes'",
  price = '1250.50',
  fee = '300.00',
}) {
  const { rows } = await db.query(
    `INSERT INTO reservations
       (listing_id, buyer_id, seller_id, status, item_price_snapshot,
        delivery_fee_snapshot, total_amount_snapshot, currency, recipient_name,
        recipient_phone, city_id, address_line1, expires_at, paid_at)
     VALUES
       ($1, $2, $3, $4, $5::numeric, $6::numeric, $5::numeric + $6::numeric,
        'PKR', 'Existing Recipient', '+15551234567', $7, 'Existing Address',
        ${expires}, CASE WHEN $4 = 'paid' THEN now() ELSE NULL END)
     RETURNING id`,
    [listingId, buyer, fixture.userId, status, price, fee, fixture.cityId]
  );
  return rows[0].id;
}

async function createReservationOrder(reservationId, listingId, status = 'reserved') {
  const { rows } = await db.query(
    `INSERT INTO orders
       (accepted_offer_id, reservation_id, listing_id, buyer_id, seller_id,
        agreed_item_price, delivery_fee, delivery_address, payment_method_preference, status)
     SELECT NULL, r.id, r.listing_id, r.buyer_id, r.seller_id,
            r.item_price_snapshot, r.delivery_fee_snapshot,
            '[reservation snapshot]', 'fixed_price_gateway', $3
     FROM reservations r WHERE r.id = $1 AND r.listing_id = $2
     RETURNING id`,
    [reservationId, listingId, status]
  );
  return rows[0].id;
}

async function createLegacyOrder(orderBuyerId, listingId, status = 'bag') {
  const { rows: conversationRows } = await db.query(
    `INSERT INTO conversations (listing_id, buyer_id, seller_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [listingId, orderBuyerId, fixture.userId]
  );
  const { rows: offerRows } = await db.query(
    `INSERT INTO offers (conversation_id, listing_id, proposed_by, amount, status)
     VALUES ($1, $2, $3, 1250.50, 'accepted') RETURNING id`,
    [conversationRows[0].id, listingId, orderBuyerId]
  );
  const { rows } = await db.query(
    `INSERT INTO orders
       (accepted_offer_id, listing_id, buyer_id, seller_id, agreed_item_price,
        delivery_fee, delivery_address, payment_method_preference, status)
     VALUES ($1, $2, $3, $4, 1250.50, 0, '', 'cash', $5)
     RETURNING id`,
    [offerRows[0].id, listingId, orderBuyerId, fixture.userId, status]
  );
  return rows[0].id;
}

async function countOrdersAndReservations(listingId) {
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*)::int FROM orders WHERE listing_id = $1) AS orders,
       (SELECT count(*)::int FROM reservations WHERE listing_id = $1) AS reservations`,
    [listingId]
  );
  return rows[0];
}

beforeEach(async () => {
  originalEnvironment = {
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
    PAYMENTS_ENABLED: process.env.PAYMENTS_ENABLED,
  };
  process.env.JWT_ACCESS_SECRET = JWT_SECRET;
  process.env.PAYMENTS_ENABLED = '1';

  fixture = await createFixture({ askingPrice: '1250.50', listingStatus: 'published' });
  listingIds = [fixture.listingId];
  additionalUserIds = [];
  buyerId = await createBuyer();

  await db.query(
    `INSERT INTO supported_delivery_cities (city_id, active)
     VALUES ($1, true) ON CONFLICT (city_id) DO UPDATE SET active = true`,
    [fixture.cityId]
  );
  const { rows: settingRows } = await db.query(
    'SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])',
    [RESERVATION_SETTING_KEYS]
  );
  originalSettings = new Map(settingRows.map((row) => [row.key, row.value]));
});

afterEach(async () => {
  try {
    if (listingIds?.length) {
      await db.query(
        'DELETE FROM payout_holds WHERE order_id IN (SELECT id FROM orders WHERE listing_id = ANY($1::uuid[]))',
        [listingIds]
      );
      await db.query(
        'DELETE FROM cod_collections WHERE order_id IN (SELECT id FROM orders WHERE listing_id = ANY($1::uuid[]))',
        [listingIds]
      );
      await db.query('DELETE FROM orders WHERE listing_id = ANY($1::uuid[])', [listingIds]);
      await db.query('DELETE FROM reservations WHERE listing_id = ANY($1::uuid[])', [listingIds]);
      await db.query(
        `DELETE FROM messages WHERE conversation_id IN (
           SELECT id FROM conversations WHERE listing_id = ANY($1::uuid[])
         )`,
        [listingIds]
      );
      await db.query('DELETE FROM offers WHERE listing_id = ANY($1::uuid[])', [listingIds]);
      await db.query('DELETE FROM conversations WHERE listing_id = ANY($1::uuid[])', [listingIds]);
    }
    if (additionalUserIds?.length) {
      await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [additionalUserIds]);
    }
    if (fixture) {
      await db.query('DELETE FROM supported_delivery_cities WHERE city_id = $1', [fixture.cityId]);
      await fixture.cleanup();
    }
    for (const key of RESERVATION_SETTING_KEYS) {
      if (originalSettings?.has(key)) {
        await db.query(
          `INSERT INTO platform_settings (key, value)
           VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [key, originalSettings.get(key)]
        );
      } else {
        await db.query('DELETE FROM platform_settings WHERE key = $1', [key]);
      }
    }
  } finally {
    for (const [key, value] of Object.entries(originalEnvironment || {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

describe('FR-32a, FR-63 and FR-63a reservation Buy', () => {
  test('FR-32a, FR-63: Buy returns exact server snapshots, persists matching rows, and sets no-store', async () => {
    const response = await buy(fixture.listingId, buyerId)
      .expect(201)
      .expect('Cache-Control', 'private, no-store');

    expect(response.body).toEqual({
      orderId: expect.any(String),
      reservationId: expect.any(String),
      status: 'reserved',
      expiresAt: expect.any(String),
      itemPrice: '1250.50',
      deliveryFee: '300.00',
      total: '1550.50',
      currency: 'PKR',
      payment: null,
    });
    const { rows: reservationRows } = await db.query(
      'SELECT * FROM reservations WHERE id = $1',
      [response.body.reservationId]
    );
    expect(reservationRows[0]).toMatchObject({
      listing_id: fixture.listingId,
      buyer_id: buyerId,
      seller_id: fixture.userId,
      status: 'active',
      item_price_snapshot: '1250.50',
      delivery_fee_snapshot: '300.00',
      total_amount_snapshot: '1550.50',
      currency: 'PKR',
      recipient_name: 'Test Recipient',
      recipient_phone: '+15551234567',
      city_id: fixture.cityId,
      address_line1: '12 Test Street',
      address_line2: 'Unit 4',
      postal_code: '10001',
    });
    const { rows: orderRows } = await db.query('SELECT * FROM orders WHERE id = $1', [response.body.orderId]);
    expect(orderRows[0]).toMatchObject({
      accepted_offer_id: null,
      reservation_id: response.body.reservationId,
      listing_id: fixture.listingId,
      buyer_id: buyerId,
      seller_id: fixture.userId,
      agreed_item_price: '1250.50',
      delivery_fee: '300.00',
      delivery_address: '[reservation snapshot]',
      payment_method_preference: 'fixed_price_gateway',
      status: 'reserved',
      total_cod_amount: '1550.50',
    });
    expect(Date.parse(response.body.expiresAt)).toBeGreaterThan(Date.now());
  });

  test('FR-32a, SEC-34: client fee, total, amount, seller, status, expiry, and payment fields cannot alter server totals or order state', async () => {
    const response = await buy(fixture.listingId, buyerId, {
      fee: '0',
      deliveryFee: '0',
      total: '1',
      amount: '1',
      sellerId: fixture.otherUserId,
      status: 'funded',
      expiresAt: '2000-01-01T00:00:00.000Z',
      payment: { status: 'succeeded' },
      paymentMethodPreference: 'cash',
    }).expect(201);
    expect(response.body).toMatchObject({
      status: 'reserved',
      itemPrice: '1250.50',
      deliveryFee: '300.00',
      total: '1550.50',
      payment: null,
    });
    const { rows } = await db.query(
      'SELECT seller_id, status, delivery_fee, total_cod_amount FROM orders WHERE id = $1',
      [response.body.orderId]
    );
    expect(rows[0]).toEqual({
      seller_id: fixture.userId,
      status: 'reserved',
      delivery_fee: '300.00',
      total_cod_amount: '1550.50',
    });
  });

  test('FR-63: an expected price that differs from the locked current price returns 409 without writing', async () => {
    const before = await countOrdersAndReservations(fixture.listingId);
    await buy(fixture.listingId, buyerId, { expectedPrice: '1250.49' }).expect(409);
    expect(await countOrdersAndReservations(fixture.listingId)).toEqual(before);
  });

  test('FR-63: the listing owner receives 403 when attempting to buy their listing', async () => {
    await buy(fixture.listingId, fixture.userId).expect(403);
    expect(await countOrdersAndReservations(fixture.listingId)).toEqual({ orders: 0, reservations: 0 });
  });

  test.each(['draft', 'paused'])(
    'FR-63: a %s listing cannot be bought',
    async (status) => {
      await db.query('UPDATE listings SET status = $1 WHERE id = $2', [status, fixture.listingId]);
      await buy(fixture.listingId, buyerId).expect(409);
      expect(await countOrdersAndReservations(fixture.listingId)).toEqual({ orders: 0, reservations: 0 });
    }
  );

  test('FR-32a: unsupported and inactive cities return 422, while an unknown city returns 404', async () => {
    await db.query('DELETE FROM supported_delivery_cities WHERE city_id = $1', [fixture.cityId]);
    await buy(fixture.listingId, buyerId).expect(422);

    await db.query(
      'INSERT INTO supported_delivery_cities (city_id, active) VALUES ($1, false)',
      [fixture.cityId]
    );
    await buy(fixture.listingId, buyerId).expect(422);

    const unknownCity = '123e4567-e89b-42d3-a456-426614174000';
    const response = await buy(fixture.listingId, buyerId, {
      address: { ...ADDRESS, cityId: unknownCity },
    }).expect(404);
    expect(response.body.error).toMatch(/city not found/i);
  });

  test('FR-32a: malformed or incomplete address fields return 400', async () => {
    for (const address of [
      null,
      { ...ADDRESS, recipientName: 'A' },
      { ...ADDRESS, phone: 'not a phone' },
      { ...ADDRESS, addressLine1: '1234' },
      { ...ADDRESS, addressLine2: 'x'.repeat(201) },
      { ...ADDRESS, postalCode: 'x'.repeat(21) },
      { ...ADDRESS, cityId: 'not-a-uuid' },
    ]) {
      await buy(fixture.listingId, buyerId, { address }).expect(400);
    }
    expect(await countOrdersAndReservations(fixture.listingId)).toEqual({ orders: 0, reservations: 0 });
  });

  test('FR-63: PAYMENTS_ENABLED other than 1 returns payments_disabled 503 before database access or writes', async () => {
    process.env.PAYMENTS_ENABLED = 'true';
    const before = await countOrdersAndReservations(fixture.listingId);
    const querySpy = jest.spyOn(db, 'query');
    const transactionSpy = jest.spyOn(db, 'withTransaction');
    try {
      const response = await request(app)
        .post(`/api/listings/${fixture.listingId}/buy`)
        .send({ address: { ...ADDRESS, cityId: fixture.cityId } })
        .expect(503);
      expect(response.body.code).toBe('payments_disabled');
      expect(querySpy).not.toHaveBeenCalled();
      expect(transactionSpy).not.toHaveBeenCalled();
    } finally {
      querySpy.mockRestore();
      transactionSpy.mockRestore();
    }
    expect(await countOrdersAndReservations(fixture.listingId)).toEqual(before);
  });

  test('FR-63a: eight concurrent buyers racing one listing produce exactly one reservation', async () => {
    const secondBuyerId = await createBuyer();
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, index) => (
        buy(fixture.listingId, index % 2 ? buyerId : secondBuyerId)
      ))
    );
    expect(attempts.filter((response) => response.status === 201)).toHaveLength(1);
    expect(attempts.filter((response) => response.status === 409)).toHaveLength(7);
    expect(await countOrdersAndReservations(fixture.listingId)).toEqual({ orders: 1, reservations: 1 });
  });

  test('FR-63c: five parallel buys by one buyer on different listings respect the cap of three', async () => {
    const additionalListings = await Promise.all(
      Array.from({ length: 4 }, () => createListing())
    );
    const attempts = await Promise.all(
      [fixture.listingId, ...additionalListings].map((id) => buy(id, buyerId))
    );
    expect(attempts.filter((response) => response.status === 201)).toHaveLength(3);
    expect(attempts.filter((response) => response.status === 409)).toHaveLength(2);
  });

  test('FR-63a: a paid or active unexpired reservation blocks a new Buy', async () => {
    const paidListingId = await createListing();
    const activeListingId = await createListing();
    const paidReservationId = await createReservation({ listingId: paidListingId, status: 'paid' });
    await createReservationOrder(paidReservationId, paidListingId, 'funded');
    const activeReservationId = await createReservation({ listingId: activeListingId });
    await createReservationOrder(activeReservationId, activeListingId);

    await buy(paidListingId, buyerId).expect(409);
    await buy(activeListingId, buyerId).expect(409);
  });

  test('FR-63a: Buy expires stale reservation state and cancels its unpaid order before reserving again', async () => {
    const oldReservationId = await createReservation({
      listingId: fixture.listingId,
      expires: "now() - interval '1 minute'",
    });
    const oldOrderId = await createReservationOrder(oldReservationId, fixture.listingId);

    const response = await buy(fixture.listingId, buyerId).expect(201);
    const { rows: oldReservationRows } = await db.query(
      'SELECT status, end_reason, ended_at FROM reservations WHERE id = $1',
      [oldReservationId]
    );
    const { rows: oldOrderRows } = await db.query(
      'SELECT status, cancelled_at FROM orders WHERE id = $1',
      [oldOrderId]
    );
    expect(oldReservationRows[0]).toMatchObject({ status: 'expired', end_reason: 'expired' });
    expect(oldReservationRows[0].ended_at).toBeInstanceOf(Date);
    expect(oldOrderRows[0].status).toBe('cancelled');
    expect(oldOrderRows[0].cancelled_at).toBeInstanceOf(Date);
    expect(response.body.reservationId).not.toBe(oldReservationId);
  });

  test('FR-63c: only active unexpired reservations count against the buyer cap', async () => {
    const listings = await Promise.all(Array.from({ length: 5 }, () => createListing()));
    await createReservation({
      listingId: listings[0],
      expires: "now() + interval '30 minutes'",
    });
    await createReservation({
      listingId: listings[1],
      expires: "now() + interval '30 minutes'",
    });
    await createReservation({
      listingId: listings[2],
      expires: "now() - interval '1 minute'",
    });
    await createReservation({
      listingId: listings[3],
      status: 'paid',
    });

    await buy(listings[4], buyerId).expect(201);
    const lastListingId = await createListing();
    await buy(lastListingId, buyerId).expect(409);
  });

  test('FR-63: missing reservation settings use their documented defaults', async () => {
    await db.query('DELETE FROM platform_settings WHERE key = ANY($1::text[])', [RESERVATION_SETTING_KEYS]);
    const response = await buy(fixture.listingId, buyerId).expect(201);
    expect(response.body.deliveryFee).toBe('300.00');
    const { rows } = await db.query(
      'SELECT extract(epoch FROM (expires_at - created_at)) AS seconds FROM reservations WHERE id = $1',
      [response.body.reservationId]
    );
    expect(Number(rows[0].seconds)).toBeCloseTo(3600, 0);
  });

  test.each([
    ['reservation_minutes', '0'],
    ['max_unpaid_reservations', '3.5'],
    ['delivery_fee_pkr', '-1'],
    ['delivery_fee_pkr', '10000000000.00'],
    ['delivery_fee_pkr', '300.001'],
  ])('FR-63: invalid setting %s=%s fails closed without writing', async (key, value) => {
    await db.query('UPDATE platform_settings SET value = $2 WHERE key = $1', [key, value]);
    const before = await countOrdersAndReservations(fixture.listingId);
    await buy(fixture.listingId, buyerId).expect(500);
    expect(await countOrdersAndReservations(fixture.listingId)).toEqual(before);
  });

  test('FR-63a: legacy guards refuse reservation-backed orders while legacy orders still work', async () => {
    const reservationId = await createReservation({ listingId: fixture.listingId });
    const reservationOrderId = await createReservationOrder(reservationId, fixture.listingId);

    await expect(orders.checkoutFromBag(reservationOrderId, buyerId, {
      deliveryAddress: 'Ignored',
      paymentMethodPreference: 'cash',
      deliveryFee: 0,
    })).rejects.toMatchObject({ statusCode: 409 });
    await expect(orders.cancelOrder(reservationOrderId, buyerId))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(payments.confirmCodCollection(reservationOrderId, {
      collectedAmount: '1550.50',
      collectionMethod: 'cash',
      collectedBy: fixture.userId,
    })).rejects.toMatchObject({ statusCode: 409 });
    await expect(payout.startHold(reservationOrderId)).rejects.toMatchObject({ statusCode: 409 });
    const { rows: guardedRows } = await db.query(
      `SELECT
         (SELECT count(*)::int FROM cod_collections WHERE order_id = $1) AS cod,
         (SELECT count(*)::int FROM payout_holds WHERE order_id = $1) AS holds`,
      [reservationOrderId]
    );
    expect(guardedRows[0]).toEqual({ cod: 0, holds: 0 });

    const checkoutListingId = await createListing();
    const checkoutOrderId = await createLegacyOrder(buyerId, checkoutListingId);
    const checkedOut = await orders.checkoutFromBag(checkoutOrderId, buyerId, {
      deliveryAddress: 'Legacy address',
      paymentMethodPreference: 'cash',
      deliveryFee: '300.00',
    });
    expect(checkedOut.status).toBe('order_placed');
    const cancelled = await orders.cancelOrder(checkoutOrderId, buyerId);
    expect(cancelled.status).toBe('cancelled');

    const codListingId = await createListing();
    const codOrderId = await createLegacyOrder(buyerId, codListingId, 'seller_preparing');
    await payments.confirmCodCollection(codOrderId, {
      collectedAmount: '1250.50',
      collectionMethod: 'cash',
      collectedBy: fixture.userId,
    });
    const { rows: legacyCodRows } = await db.query(
      `SELECT
         (SELECT count(*)::int FROM cod_collections WHERE order_id = $1) AS cod,
         (SELECT count(*)::int FROM payout_holds WHERE order_id = $1) AS holds`,
      [codOrderId]
    );
    expect(legacyCodRows[0]).toEqual({ cod: 1, holds: 1 });
  });

  test('FR-63: Buy rejects unauthenticated callers with 401 and private no-store headers', async () => {
    await request(app)
      .post(`/api/listings/${fixture.listingId}/buy`)
      .send({ address: { ...ADDRESS, cityId: fixture.cityId } })
      .expect(401)
      .expect('Cache-Control', 'private, no-store');
  });
});
