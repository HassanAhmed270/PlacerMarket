const eventBus = require('../../src/lib/eventBus');
const {
  authHeader,
  cleanupHarness,
  cleanupScenario,
  createHarness,
  createLegacyOrder,
  createScenario,
  db,
  getApp,
  request,
  restoreHandoverTestEnvironment,
} = require('./delivery-handover.helpers');

let harness;
let scenario;
let extraOrders;
let extraReservations;

async function createExtraReservationOrders(count) {
  const { rows } = await db.query(
    `WITH generated AS (
       SELECT generate_series(1, $1::integer) AS sequence
     ),
     inserted_reservations AS (
       INSERT INTO reservations
         (listing_id, buyer_id, seller_id, status, item_price_snapshot,
          delivery_fee_snapshot, total_amount_snapshot, currency, recipient_name,
          recipient_phone, city_id, address_line1, created_at, expires_at)
       SELECT $2, $3, $4, 'expired', '100.00', '0.00', '100.00', 'PKR',
              'Read fixture recipient', '+15550000000', $5,
              '1 Read Fixture Road',
              now() - generated.sequence * INTERVAL '1 minute',
              now() - generated.sequence * INTERVAL '1 minute'
       FROM generated
       RETURNING id, created_at
     )
     INSERT INTO orders
       (listing_id, buyer_id, seller_id, agreed_item_price, delivery_fee,
        delivery_address, payment_method_preference, status, reservation_id, created_at)
     SELECT $2, $3, $4, '100.00', '0.00', '', 'digital_transfer',
            'cancelled', id, created_at
     FROM inserted_reservations
     RETURNING id, reservation_id`,
    [
      count,
      scenario.listingId,
      scenario.buyerId,
      harness.fixture.userId,
      harness.fixture.cityId,
    ]
  );
  extraOrders = rows.map((row) => row.id);
  extraReservations = rows.map((row) => row.reservation_id);
}

async function cleanupExtraReservationOrders() {
  if (!extraOrders?.length) return;
  await db.query('DELETE FROM orders WHERE id = ANY($1::uuid[])', [extraOrders]);
  await db.query('DELETE FROM reservations WHERE id = ANY($1::uuid[])', [extraReservations]);
  extraOrders = [];
  extraReservations = [];
}

function adminOrderList(query = '') {
  return request(getApp())
    .get(`/api/admin/orders${query}`)
    .set('Authorization', authHeader(harness.adminId));
}

async function cleanupDisputes() {
  if (!scenario) return;
  await db.query(
    `UPDATE payout_holds
     SET state = 'held', dispute_id = NULL
     WHERE order_id = $1`,
    [scenario.orderId]
  );
  await db.query(
    `DELETE FROM dispute_evidence
     WHERE dispute_id IN (SELECT id FROM disputes WHERE order_id = $1)`,
    [scenario.orderId]
  );
  await db.query('DELETE FROM disputes WHERE order_id = $1', [scenario.orderId]);
}

beforeEach(async () => {
  harness = await createHarness();
  scenario = await createScenario(harness);
  extraOrders = [];
  extraReservations = [];
});

afterEach(async () => {
  await cleanupExtraReservationOrders();
  await cleanupDisputes();
  if (scenario) await cleanupScenario(harness, scenario);
  await cleanupHarness(harness);
  scenario = null;
  harness = null;
});

afterAll(async () => {
  restoreHandoverTestEnvironment();
});

describe('FR-68 Admin reservation-backed order reads', () => {
  test('FR-68: list access is Admin-only, private/no-store, and excludes legacy orders', async () => {
    const legacyOrderId = await createLegacyOrder(harness, scenario);
    await request(getApp())
      .get('/api/admin/orders')
      .expect(401)
      .expect('Cache-Control', 'private, no-store');
    for (const roleId of [harness.fixture.userId, scenario.buyerId, harness.moderatorId]) {
      await request(getApp())
        .get('/api/admin/orders')
        .set('Authorization', authHeader(roleId))
        .expect(403);
    }

    const response = await adminOrderList().expect(200).expect('Cache-Control', 'private, no-store');
    expect(response.body.orders.map((order) => order.orderId)).toContain(scenario.orderId);
    expect(response.body.orders.map((order) => order.orderId)).not.toContain(legacyOrderId);
    expect(response.body.orders[0]).toMatchObject({
      orderId: scenario.orderId,
      listing: { id: scenario.listingId },
      amounts: {
        itemPrice: '1250.50',
        deliveryFee: '300.00',
        total: '1550.50',
      },
    });
    expect(Object.values(response.body.orders[0].amounts).every((amount) => typeof amount === 'string')).toBe(true);
  });

  test('FR-68: validates status against order_status and caps the keyset page at 50', async () => {
    await adminOrderList('?status=funded&limit=2').expect(200).then(({ body }) => {
      expect(body.orders.some((order) => order.orderId === scenario.orderId)).toBe(true);
    });
    await adminOrderList('?status=not_a_real_order_status').expect(400);

    await createExtraReservationOrders(55);
    const response = await adminOrderList('?limit=500').expect(200);
    expect(response.body.orders).toHaveLength(50);
    expect(response.body.nextBefore).toBe(response.body.orders[49].orderId);
  });

  test('FR-68: cursor pages are stable, ordered, and non-overlapping', async () => {
    await createExtraReservationOrders(4);
    const first = await adminOrderList('?limit=2').expect(200);
    expect(first.body.orders).toHaveLength(2);
    expect(first.body.nextBefore).toBe(first.body.orders[1].orderId);

    const second = await adminOrderList(`?limit=2&before=${first.body.nextBefore}`).expect(200);
    expect(second.body.orders).toHaveLength(2);
    const firstIds = first.body.orders.map((order) => order.orderId);
    const secondIds = second.body.orders.map((order) => order.orderId);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(4);
  });

  test('FR-68, FR-72e: detail exposes delivery, hold, and issue metadata without changing state or emitting events', async () => {
    const detailUrl = `/api/admin/orders/${scenario.orderId}`;
    await request(getApp())
      .get(detailUrl)
      .expect(401)
      .expect('Cache-Control', 'private, no-store');
    for (const roleId of [harness.fixture.userId, scenario.buyerId, harness.moderatorId]) {
      await request(getApp())
        .get(detailUrl)
        .set('Authorization', authHeader(roleId))
        .expect(403);
    }

    const sentinels = {
      email: `private-${scenario.buyerId}@example.test`,
      passwordHash: 'order-read-password-hash-must-not-leak',
      providerPaymentId: 'provider-payment-id-must-not-leak',
      providerReference: 'provider-reference-must-not-leak',
      providerToken: 'provider-token-must-not-leak',
      gatewayPayload: 'raw-gateway-payload-must-not-leak',
      exceptionNote: 'private exception note must not leak',
      disputeReason: 'private dispute reason must not leak',
    };
    await db.query(
      'UPDATE users SET email = $1, password_hash = $2 WHERE id = $3',
      [sentinels.email, sentinels.passwordHash, scenario.buyerId]
    );
    await db.query(
      `UPDATE payments
       SET provider_payment_id = $1, provider_reference = $2
       WHERE id = $3`,
      [sentinels.providerPaymentId, sentinels.providerReference, scenario.paymentId]
    );
    await db.query(
      `UPDATE orders
       SET status = 'held', handed_over_at = now() - INTERVAL '1 hour',
           delivered_at = now() - INTERVAL '30 minutes',
           courier_pickup_at = now() - INTERVAL '2 hours',
           handover_recorded_at = now() - INTERVAL '90 minutes'
       WHERE id = $1`,
      [scenario.orderId]
    );
    const { rows: disputeRows } = await db.query(
      `INSERT INTO disputes (order_id, raised_by, reason_text, status)
       VALUES ($1, $2, $3, 'open')
       RETURNING id`,
      [scenario.orderId, scenario.buyerId, sentinels.disputeReason]
    );
    await db.query(
      `INSERT INTO payout_holds
         (order_id, hold_started_at, hold_window_days, complaint_window_days,
          state, dispute_id)
       VALUES ($1, now() - INTERVAL '1 day', 5, 3, 'paused_for_dispute', $2)`,
      [scenario.orderId, disputeRows[0].id]
    );
    await db.query(
      `INSERT INTO order_exceptions (order_id, kind, note, recorded_by)
       VALUES ($1, 'handover_after_cancel', $2, $3)`,
      [scenario.orderId, sentinels.exceptionNote, harness.adminId]
    );
    await db.query(
      `INSERT INTO delivery_status_log (order_id, status, entered_by, note)
       VALUES ($1, 'picked_up', $2, E'Courier pickup confirmed\\nTracking number: PK-ADMIN-123')`,
      [scenario.orderId, harness.adminId]
    );
    await db.query(
      `INSERT INTO refunds
         (payment_id, order_id, trigger, amount, currency, status, idempotency_key)
       VALUES ($1, $2, 'system_expiry', '50.25', 'PKR', 'failed', $3)`,
      [scenario.paymentId, scenario.orderId, `admin-read-refund:${scenario.orderId}`]
    );
    const stateQuery = `SELECT o.status, o.delivered_at, ph.state, ph.released_at,
                               r.status AS reservation_status,
                               p.status AS payment_status,
                               (SELECT count(*)::int FROM disputes d WHERE d.order_id = o.id) AS dispute_count,
                               (SELECT count(*)::int FROM order_exceptions oe WHERE oe.order_id = o.id) AS exception_count,
                               (SELECT count(*)::int FROM refunds rf WHERE rf.order_id = o.id) AS refund_count
       FROM orders o
       JOIN reservations r ON r.id = o.reservation_id
       JOIN payments p ON p.order_id = o.id
       JOIN payout_holds ph ON ph.order_id = o.id
       WHERE o.id = $1`;
    const { rows: beforeRows } = await db.query(stateQuery, [scenario.orderId]);
    const emit = jest.spyOn(eventBus, 'emit');
    const emitAsync = jest.spyOn(eventBus, 'emitAsync');
    const consoleSpies = ['error', 'warn', 'log'].map((method) =>
      jest.spyOn(console, method).mockImplementation(() => {})
    );
    try {
      const response = await request(getApp())
        .get(`/api/admin/orders/${scenario.orderId}`)
        .set('Authorization', authHeader(harness.adminId))
        .expect(200)
        .expect('Cache-Control', 'private, no-store');
      expect(response.body).toMatchObject({
        orderId: scenario.orderId,
        status: 'held',
        listing: { id: scenario.listingId },
        buyer: { id: scenario.buyerId },
        seller: { id: harness.fixture.userId },
        deliveryAddress: {
          recipientName: 'Handover Test Recipient',
          phone: '+15551234567',
          city: expect.any(String),
          addressLine1: '12 Handover Test Street',
          addressLine2: null,
          postalCode: null,
        },
        reservation: { id: scenario.reservationId, status: 'paid' },
        payment: { status: 'succeeded', amount: '1550.50' },
        courierPickupAt: expect.any(String),
        handoverRecordedAt: expect.any(String),
        trackingNumber: 'PK-ADMIN-123',
        payoutHold: {
          state: 'paused_for_dispute',
          holdWindowDays: 5,
          complaintWindowDays: 3,
          releasedAt: null,
        },
        hasOpenDispute: true,
        hasUnresolvedException: true,
        disputes: [{ id: disputeRows[0].id, status: 'open', createdAt: expect.any(String) }],
        exceptions: [{
          kind: 'handover_after_cancel',
          recordedAt: expect.any(String),
          resolvedAt: null,
        }],
        refunds: [{
          trigger: 'system_expiry',
          status: 'failed',
          amount: '50.25',
        }],
      });
      expect(typeof response.body.amounts.itemPrice).toBe('string');
      expect(typeof response.body.amounts.deliveryFee).toBe('string');
      expect(typeof response.body.amounts.total).toBe('string');
      expect(typeof response.body.payment.amount).toBe('string');
      expect(typeof response.body.refunds[0].amount).toBe('string');
      const expectedHold = await db.query(
        `SELECT GREATEST(
                  hold_started_at + (hold_window_days::text || ' days')::interval,
                  o.delivered_at + (complaint_window_days::text || ' days')::interval
                ) AS earliest_release_at
         FROM payout_holds ph
         JOIN orders o ON o.id = ph.order_id
         WHERE ph.order_id = $1`,
        [scenario.orderId]
      );
      expect(new Date(response.body.payoutHold.earliestReleaseAt).getTime())
        .toBe(expectedHold.rows[0].earliest_release_at.getTime());

      const serialized = JSON.stringify(response.body);
      for (const secret of Object.values(sentinels)) expect(serialized).not.toContain(secret);
      expect(response.body).not.toHaveProperty('provider');
      expect(response.body).not.toHaveProperty('webhook');
      expect(response.body).not.toHaveProperty('token');
      const logOutput = JSON.stringify(consoleSpies.flatMap((spy) => spy.mock.calls));
      for (const pii of [sentinels.email, sentinels.passwordHash, '+15551234567', '12 Handover Test Street']) {
        expect(logOutput).not.toContain(pii);
      }
      expect(emit).not.toHaveBeenCalled();
      expect(emitAsync).not.toHaveBeenCalled();
      const { rows: afterRows } = await db.query(stateQuery, [scenario.orderId]);
      expect(afterRows).toEqual(beforeRows);
    } finally {
      emit.mockRestore();
      emitAsync.mockRestore();
      consoleSpies.forEach((spy) => spy.mockRestore());
    }
  });

  test('FR-68: detail returns 404 for legacy and missing orders and 400 for malformed ids', async () => {
    const legacyOrderId = await createLegacyOrder(harness, scenario);
    const missingOrderId = '123e4567-e89b-42d3-a456-426614174000';
    const url = (id) => request(getApp())
      .get(`/api/admin/orders/${id}`)
      .set('Authorization', authHeader(harness.adminId));
    await url(legacyOrderId).expect(404);
    await url(missingOrderId).expect(404);
    await url('not-a-uuid').expect(400);
  });
});
