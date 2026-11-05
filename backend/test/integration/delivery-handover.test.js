const {
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
  getApp,
  pickupTime,
  request,
  restoreHandoverTestEnvironment,
  setDeadlinePast,
  validHandoverBody,
} = require('./delivery-handover.helpers');

let harness;
let scenario;

beforeAll(async () => {
  harness = await createHarness();
});

beforeEach(async () => {
  scenario = await createScenario(harness);
});

afterEach(async () => {
  await global.drainIntegrationListeners(5000);
  if (scenario) await cleanupScenario(harness, scenario);
});

afterAll(async () => {
  await cleanupHarness(harness);
  restoreHandoverTestEnvironment();
});

describe('FR-72 Admin courier handover and delivery route access', () => {
  test('FR-72: only Admins can record handover; seller, buyer, moderator, and anonymous users are rejected', async () => {
    const body = await validHandoverBody(scenario);
    const route = () => request(getApp())
      .patch(`/api/admin/orders/${scenario.orderId}/delivery`)
      .send(body);

    await route().expect(401);
    await route().set('Authorization', authHeader(harness.fixture.userId)).expect(403);
    await route().set('Authorization', authHeader(scenario.buyerId)).expect(403);
    await route().set('Authorization', authHeader(harness.moderatorId)).expect(403);
  });

  test('FR-72: future pickup, pickup before funding, and an empty confirmation note are rejected', async () => {
    const futureBody = await validHandoverBody(scenario, {
      courierPickupAt: await pickupTime(scenario, "now() + INTERVAL '1 minute'"),
    });
    await adminHandoverRequest(harness, scenario, futureBody).expect(400);

    const beforeFundingBody = await validHandoverBody(scenario, {
      courierPickupAt: await pickupTime(scenario, 'funded_at - INTERVAL \'1 second\''),
    });
    await adminHandoverRequest(harness, scenario, beforeFundingBody).expect(400);

    const emptyNoteBody = await validHandoverBody(scenario, { handoverConfirmationNote: '   ' });
    await adminHandoverRequest(harness, scenario, emptyNoteBody).expect(400);

    const unsupportedBody = await validHandoverBody(scenario, { status: 'delivered' });
    await adminHandoverRequest(harness, scenario, unsupportedBody).expect(400);

    const { rows } = await db.query(
      'SELECT status, courier_pickup_at, handover_recorded_at, handed_over_at FROM orders WHERE id = $1',
      [scenario.orderId]
    );
    expect(rows[0]).toMatchObject({
      status: 'funded',
      courier_pickup_at: null,
      handover_recorded_at: null,
      handed_over_at: null,
    });
  });

  test('FR-72: a timely pickup is recorded with database timestamps and one delivery log row', async () => {
    const note = 'Courier pickup confirmed by Admin';
    const trackingNumber = 'PK-HANDOVER-2026';
    const body = await validHandoverBody(scenario, {
      handoverConfirmationNote: note,
      trackingNumber,
    });
    const { rows: notificationsBefore } = await db.query(
      'SELECT count(*)::int AS count FROM notifications WHERE user_id = ANY($1::uuid[])',
      [[scenario.buyerId, harness.fixture.userId]]
    );
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnLog = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const infoLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const response = await adminHandoverRequest(harness, scenario, body)
        .expect('Cache-Control', 'private, no-store')
        .expect(200);
      expect(response.body).toMatchObject({
        orderId: scenario.orderId,
        deliveryStatus: 'handed_to_delivery',
        courierPickupAt: new Date(body.courierPickupAt).toISOString(),
        trackingNumber,
      });
      expect(new Date(response.body.handoverRecordedAt).getTime()).toBeGreaterThan(0);
      expect(response.body.updatedAt).toBe(response.body.handoverRecordedAt);

      const { rows: orderRows } = await db.query(
        `SELECT status, courier_pickup_at, handover_recorded_at, handed_over_at
         FROM orders WHERE id = $1`,
        [scenario.orderId]
      );
      expect(orderRows[0]).toMatchObject({
        status: 'handed_to_delivery',
        courier_pickup_at: new Date(body.courierPickupAt),
      });
      expect(orderRows[0].handover_recorded_at).toBeInstanceOf(Date);
      expect(orderRows[0].handed_over_at).toBeInstanceOf(Date);

      const { rows: logRows } = await db.query(
        `SELECT status, note, entered_by, created_at
         FROM delivery_status_log WHERE order_id = $1`,
        [scenario.orderId]
      );
      expect(logRows).toHaveLength(1);
      expect(logRows[0]).toMatchObject({
        status: 'picked_up',
        note: `${note}\nTracking number: ${trackingNumber}`,
        entered_by: harness.adminId,
      });
      expect(logRows[0].created_at).toEqual(orderRows[0].handover_recorded_at);

      const { rows: auditRows } = await db.query(
        `SELECT actor_id, action FROM money_audit_events WHERE order_id = $1`,
        [scenario.orderId]
      );
      expect(auditRows).toEqual([{
        actor_id: harness.adminId,
        action: 'courier_handover_recorded',
      }]);
      const { rows: notificationsAfter } = await db.query(
        'SELECT count(*)::int AS count FROM notifications WHERE user_id = ANY($1::uuid[])',
        [[scenario.buyerId, harness.fixture.userId]]
      );
      expect(notificationsAfter[0].count).toBe(notificationsBefore[0].count);

      const loggedOutput = JSON.stringify([
        ...errorLog.mock.calls,
        ...warnLog.mock.calls,
        ...infoLog.mock.calls,
      ]);
      expect(loggedOutput).not.toContain(note);
      expect(loggedOutput).not.toContain(trackingNumber);
    } finally {
      errorLog.mockRestore();
      warnLog.mockRestore();
      infoLog.mockRestore();
    }
  });

  test('FR-72: a timely pickup may be recorded after the deadline until timeout cancellation commits', async () => {
    await setDeadlinePast(scenario);
    const body = await validHandoverBody(scenario, {
      courierPickupAt: await pickupTime(scenario, "handover_deadline_at - INTERVAL '1 minute'"),
    });
    const response = await adminHandoverRequest(harness, scenario, body).expect(200);
    expect(response.body.deliveryStatus).toBe('handed_to_delivery');
  });

  test('FR-72: a pickup after the deadline conflicts without changing the order', async () => {
    await setDeadlinePast(scenario);
    const body = await validHandoverBody(scenario, {
      courierPickupAt: await pickupTime(scenario, "handover_deadline_at + INTERVAL '1 minute'"),
    });
    await adminHandoverRequest(harness, scenario, body).expect(409);
    const { rows } = await db.query(
      'SELECT status, courier_pickup_at, handover_recorded_at FROM orders WHERE id = $1',
      [scenario.orderId]
    );
    expect(rows[0]).toMatchObject({
      status: 'funded',
      courier_pickup_at: null,
      handover_recorded_at: null,
    });
  });

  test('FR-72, FR-72e: a timeout-refunded order is not reopened and creates one unresolved exception', async () => {
    await setDeadlinePast(scenario);
    await expect(escrowPayments.refundUnhandedOverOrder({ orderId: scenario.orderId }))
      .resolves.toMatchObject({ outcome: 'refunded' });
    const body = await validHandoverBody(scenario, {
      courierPickupAt: await pickupTime(scenario, "handover_deadline_at - INTERVAL '1 minute'"),
    });

    const first = await adminHandoverRequest(harness, scenario, body).expect(409);
    expect(first.body.error).toMatch(/will not be reopened.*manual resolution/i);
    await adminHandoverRequest(harness, scenario, body).expect(409);

    const { rows: stateRows } = await db.query(
      `SELECT order_row.status, reservation.status AS reservation_status,
              count(DISTINCT refund.id)::int AS timeout_refunds
       FROM orders order_row
       JOIN reservations reservation ON reservation.id = order_row.reservation_id
       LEFT JOIN refunds refund ON refund.order_id = order_row.id
         AND refund.trigger = 'system_handover_timeout'
       WHERE order_row.id = $1
       GROUP BY order_row.status, reservation.status`,
      [scenario.orderId]
    );
    expect(stateRows[0]).toMatchObject({
      status: 'cancelled',
      reservation_status: 'released',
      timeout_refunds: 1,
    });
    const { rows: exceptionRows } = await db.query(
      `SELECT kind, courier_pickup_at, note, recorded_by, resolved_at
       FROM order_exceptions WHERE order_id = $1`,
      [scenario.orderId]
    );
    expect(exceptionRows).toHaveLength(1);
    expect(exceptionRows[0]).toMatchObject({
      kind: 'late_handover_after_auto_cancel',
      courier_pickup_at: new Date(body.courierPickupAt),
      note: body.handoverConfirmationNote,
      recorded_by: harness.adminId,
      resolved_at: null,
    });

    const issueList = await request(getApp())
      .get('/api/admin/order-exceptions?resolved=false')
      .set('Authorization', authHeader(harness.adminId))
      .expect('Cache-Control', 'private, no-store')
      .expect(200);
    expect(issueList.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orderId: scenario.orderId,
        kind: 'late_handover_after_auto_cancel',
        courierPickupAt: new Date(body.courierPickupAt).toISOString(),
        note: body.handoverConfirmationNote,
        resolvedAt: null,
      }),
    ]));
  });

  test('FR-33a, FR-72: buyer cancellation is refused after handover commits', async () => {
    const body = await validHandoverBody(scenario);
    await adminHandoverRequest(harness, scenario, body).expect(200);
    await buyerCancelRequest(scenario).expect(409);
  });

  test('FR-42: tracking is available to order parties and Admins but returns 404 to unrelated users', async () => {
    const path = `/api/delivery/orders/${scenario.orderId}/tracking`;
    await request(getApp()).get(path)
      .set('Authorization', authHeader(scenario.buyerId))
      .expect('Cache-Control', 'private, no-store')
      .expect(200);
    await request(getApp()).get(path)
      .set('Authorization', authHeader(harness.fixture.userId))
      .expect(200);
    await request(getApp()).get(path)
      .set('Authorization', authHeader(harness.adminId))
      .expect(200);
    const unrelated = await request(getApp()).get(path)
      .set('Authorization', authHeader(harness.unrelatedBuyerId))
      .expect(404);
    const nonexistent = await request(getApp()).get(`/api/delivery/orders/${crypto.randomUUID()}/tracking`)
      .set('Authorization', authHeader(harness.unrelatedBuyerId))
      .expect(404);
    expect(unrelated.body.error).toMatch(/^order not found:/);
    expect(nonexistent.body.error).toMatch(/^order not found:/);
  });

  test('FR-41, FR-72: legacy status logging is Admin-only and rejects reservation-backed orders', async () => {
    const path = `/api/delivery/orders/${scenario.orderId}/status`;
    await request(getApp()).post(path)
      .set('Authorization', authHeader(scenario.buyerId))
      .send({ status: 'in_transit' })
      .expect(403);
    await request(getApp()).post(path)
      .set('Authorization', authHeader(harness.adminId))
      .send({ status: 'in_transit' })
      .expect(409);

    const legacyOrderId = await createLegacyOrder(harness, scenario);
    const response = await request(getApp()).post(`/api/delivery/orders/${legacyOrderId}/status`)
      .set('Authorization', authHeader(harness.adminId))
      .send({ status: 'in_transit', note: 'Legacy COD delivery update' })
      .expect(201);
    expect(response.body.status).toBe('in_transit');
  });
});
