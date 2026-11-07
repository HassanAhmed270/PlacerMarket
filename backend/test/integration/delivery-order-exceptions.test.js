const crypto = require('node:crypto');
const {
  adminHandoverRequest,
  authHeader,
  buyerCancelRequest,
  cleanupHarness,
  cleanupScenario,
  createHarness,
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

const adminExceptions = () => request(getApp())
  .get('/api/admin/order-exceptions')
  .set('Authorization', authHeader(harness.adminId));

let harness;
let scenario;
let additionalScenarios;

async function handoverExceptionId(orderId) {
  const { rows } = await db.query(
    `SELECT id
     FROM order_exceptions
     WHERE order_id = $1 AND kind = 'handover_after_cancel'`,
    [orderId]
  );
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

async function orderMoneySnapshot(orderId) {
  const { rows } = await db.query(
    `SELECT
       (SELECT to_jsonb(order_row) FROM orders order_row WHERE id = $1) AS order_row,
       (SELECT to_jsonb(reservation)
        FROM reservations reservation
        JOIN orders order_row ON order_row.reservation_id = reservation.id
        WHERE order_row.id = $1) AS reservation,
       (SELECT COALESCE(jsonb_agg(to_jsonb(payment) ORDER BY payment.id), '[]'::jsonb)
        FROM payments payment WHERE payment.order_id = $1) AS payments,
       (SELECT COALESCE(jsonb_agg(to_jsonb(refund) ORDER BY refund.id), '[]'::jsonb)
        FROM refunds refund WHERE refund.order_id = $1) AS refunds,
       (SELECT COALESCE(jsonb_agg(to_jsonb(hold) ORDER BY hold.order_id), '[]'::jsonb)
        FROM payout_holds hold WHERE hold.order_id = $1) AS payout_holds`,
    [orderId]
  );
  return rows[0];
}

async function cancelWithBuyer() {
  await buyerCancelRequest(scenario).expect(200);
  await global.drainIntegrationListeners(5000);
}

beforeAll(async () => {
  harness = await createHarness();
});

beforeEach(async () => {
  scenario = await createScenario(harness);
  additionalScenarios = [];
});

afterEach(async () => {
  await global.drainIntegrationListeners(5000);
  for (const candidate of [scenario, ...additionalScenarios]) {
    if (candidate) await cleanupScenario(harness, candidate);
  }
});

afterAll(async () => {
  await cleanupHarness(harness);
  restoreHandoverTestEnvironment();
});

describe('FR-72, FR-72e Admin order exceptions', () => {
  test('FR-72, FR-72e: funded buyer cancellation stays cancelled and refunded when a handover exception is recorded', async () => {
    await cancelWithBuyer();
    const { rows: notificationRowsBefore } = await db.query(
      'SELECT count(*)::int AS count FROM notifications WHERE user_id = ANY($1::uuid[])',
      [[scenario.buyerId, harness.adminId]]
    );
    const body = await validHandoverBody(scenario, {
      handoverConfirmationNote: 'Courier pickup confirmed by Admin',
    });

    const response = await adminHandoverRequest(harness, scenario, body).expect(409);
    expect(response.body.error).toMatch(/cancelled and refunded.*will not be reopened.*exception was recorded.*manual resolution/i);

    const { rows: orderRows } = await db.query(
      `SELECT order_row.status, order_row.funded_at,
              reservation.status AS reservation_status,
              reservation.end_reason,
              count(refund.id)::int AS system_cancel_refunds
       FROM orders order_row
       JOIN reservations reservation ON reservation.id = order_row.reservation_id
       LEFT JOIN refunds refund ON refund.order_id = order_row.id
         AND refund.trigger = 'system_cancel'
       WHERE order_row.id = $1
       GROUP BY order_row.status, order_row.funded_at, reservation.status, reservation.end_reason`,
      [scenario.orderId]
    );
    expect(orderRows[0]).toMatchObject({
      status: 'cancelled',
      reservation_status: 'released',
      end_reason: 'buyer_cancelled',
      system_cancel_refunds: 1,
    });
    expect(orderRows[0].funded_at).toBeInstanceOf(Date);

    const { rows: exceptionRows } = await db.query(
      `SELECT kind, courier_pickup_at, note, recorded_by
       FROM order_exceptions WHERE order_id = $1`,
      [scenario.orderId]
    );
    expect(exceptionRows).toEqual([{
      kind: 'handover_after_cancel',
      courier_pickup_at: new Date(body.courierPickupAt),
      note: `${body.handoverConfirmationNote}\nOrder was cancelled by the buyer`,
      recorded_by: harness.adminId,
    }]);
    const { rows: notificationRowsAfter } = await db.query(
      'SELECT count(*)::int AS count FROM notifications WHERE user_id = ANY($1::uuid[])',
      [[scenario.buyerId, harness.adminId]]
    );
    expect(notificationRowsAfter[0].count).toBe(notificationRowsBefore[0].count);
  });

  test('FR-72, FR-72e: Admin listing take-down records the listing-taken-down cause on the handover exception', async () => {
    await request(getApp())
      .post(`/api/listings/${scenario.listingId}/reject`)
      .set('Authorization', authHeader(harness.adminId))
      .send({ reason: 'Admin listing take-down' })
      .expect(200);
    await global.drainIntegrationListeners(5000);
    const { rows: notificationsBefore } = await db.query(
      'SELECT count(*)::int AS count FROM notifications WHERE user_id = ANY($1::uuid[])',
      [[scenario.buyerId, harness.adminId]]
    );
    const body = await validHandoverBody(scenario);
    const response = await adminHandoverRequest(harness, scenario, body).expect(409);
    expect(response.body.error).toMatch(/cancelled and refunded.*will not be reopened/i);

    const { rows } = await db.query(
      `SELECT exception.kind, exception.note, reservation.end_reason,
              refund.trigger
       FROM order_exceptions exception
       JOIN reservations reservation ON reservation.id = (
         SELECT reservation_id FROM orders WHERE id = exception.order_id
       )
       JOIN refunds refund ON refund.order_id = exception.order_id
       WHERE exception.order_id = $1`,
      [scenario.orderId]
    );
    expect(rows).toEqual([{
      kind: 'handover_after_cancel',
      note: `${body.handoverConfirmationNote}\nOrder was cancelled because the listing was taken down`,
      end_reason: 'listing_taken_down',
      trigger: 'system_cancel',
    }]);
    const { rows: notificationsAfter } = await db.query(
      'SELECT count(*)::int AS count FROM notifications WHERE user_id = ANY($1::uuid[])',
      [[scenario.buyerId, harness.adminId]]
    );
    expect(notificationsAfter[0].count).toBe(notificationsBefore[0].count);
  });

  test('FR-72e: repeated handover attempts return the existing exception without creating another', async () => {
    await cancelWithBuyer();
    const body = await validHandoverBody(scenario);

    await adminHandoverRequest(harness, scenario, body).expect(409);
    const repeated = await adminHandoverRequest(harness, scenario, {
      ...body,
      handoverConfirmationNote: 'Different pickup confirmation',
    }).expect(409);
    expect(repeated.body.error).toMatch(/existing exception/i);

    const { rows } = await db.query(
      `SELECT count(*)::int AS count
       FROM order_exceptions
       WHERE order_id = $1 AND kind = 'handover_after_cancel' AND resolved_at IS NULL`,
      [scenario.orderId]
    );
    expect(rows[0].count).toBe(1);
  });

  test('FR-72: a buyer-cancelled order that was never funded keeps the plain conflict and creates no exception', async () => {
    await db.withTransaction(async (client) => {
      await client.query(
        `UPDATE orders
         SET status = 'payment_pending', funded_at = NULL, handover_deadline_at = NULL
         WHERE id = $1`,
        [scenario.orderId]
      );
      await client.query(
        `UPDATE reservations
         SET status = 'active', paid_at = NULL, ended_at = NULL, end_reason = NULL
         WHERE id = $1`,
        [scenario.reservationId]
      );
      await client.query(
        `UPDATE payments
         SET status = 'created', succeeded_at = NULL
         WHERE id = $1`,
        [scenario.paymentId]
      );
    });
    await cancelWithBuyer();

    const response = await adminHandoverRequest(
      harness,
      scenario,
      await validHandoverBody(scenario)
    ).expect(409);
    expect(response.body.error).toMatch(/not eligible for courier handover/i);
    const { rows } = await db.query(
      'SELECT count(*)::int AS count FROM order_exceptions WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(rows[0].count).toBe(0);
  });

  test('FR-72: invalid pickup timestamps on cancelled funded orders return 400 without an exception', async () => {
    await cancelWithBuyer();
    const future = await validHandoverBody(scenario, {
      courierPickupAt: await pickupTime(scenario, "now() + INTERVAL '1 minute'"),
    });
    const beforeFunding = await validHandoverBody(scenario, {
      courierPickupAt: await pickupTime(scenario, "funded_at - INTERVAL '1 second'"),
    });

    await adminHandoverRequest(harness, scenario, future).expect(400);
    await adminHandoverRequest(harness, scenario, beforeFunding).expect(400);
    const { rows } = await db.query(
      'SELECT count(*)::int AS count FROM order_exceptions WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(rows[0].count).toBe(0);
  });

  test('FR-72e: exception listing filters status and kind, sorts newest-first, and caps limit at 100', async () => {
    await cancelWithBuyer();
    await adminHandoverRequest(harness, scenario, await validHandoverBody(scenario)).expect(409);
    const exceptionId = await handoverExceptionId(scenario.orderId);

    const timedOutScenario = await createScenario(harness);
    additionalScenarios.push(timedOutScenario);
    await setDeadlinePast(timedOutScenario);
    await escrowPayments.refundUnhandedOverOrder({ orderId: timedOutScenario.orderId });
    const timeoutBody = await validHandoverBody(timedOutScenario, {
      courierPickupAt: await pickupTime(timedOutScenario, "handover_deadline_at - INTERVAL '1 minute'"),
    });
    await adminHandoverRequest(harness, timedOutScenario, timeoutBody).expect(409);

    await request(getApp())
      .post(`/api/admin/order-exceptions/${exceptionId}/resolve`)
      .set('Authorization', authHeader(harness.adminId))
      .send({ resolutionNote: 'Verified the buyer cancellation' })
      .expect(200);

    await db.query(
      `INSERT INTO order_exceptions
         (order_id, kind, note, recorded_by, recorded_at, resolved_at, resolved_by, resolution_note)
       SELECT $1, 'handover_after_cancel', 'Resolved listing history', $2,
              now() - make_interval(secs => age_seconds + 1000),
              now() - make_interval(secs => age_seconds + 1000), $2, 'Reviewed historical record'
       FROM generate_series(1, 101) AS age_seconds`,
      [scenario.orderId, harness.adminId]
    );

    const unresolved = await adminExceptions().expect('Cache-Control', 'private, no-store').expect(200);
    expect(unresolved.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orderId: timedOutScenario.orderId,
        kind: 'late_handover_after_auto_cancel',
      }),
    ]));
    expect(unresolved.body).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: exceptionId }),
    ]));

    const resolved = await adminExceptions().query({ status: 'resolved', kind: 'handover_after_cancel' }).expect(200);
    expect(resolved.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: exceptionId,
        resolvedBy: harness.adminId,
        resolutionNote: 'Verified the buyer cancellation',
      }),
    ]));
    expect(resolved.body).toHaveLength(50);
    expect(resolved.body.every((row) => row.kind === 'handover_after_cancel' && row.resolvedAt !== null)).toBe(true);

    const all = await adminExceptions().query({ status: 'all', kind: 'handover_after_cancel', limit: '1000' }).expect(200);
    expect(all.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: exceptionId }),
    ]));
    expect(all.body).toHaveLength(100);
    expect(all.body.every((row, index, rows) =>
      index === 0 || new Date(rows[index - 1].recordedAt) >= new Date(row.recordedAt)
    )).toBe(true);
    expect(all.body.every((row) => row.kind === 'handover_after_cancel')).toBe(true);
    expect(unresolved.body.length).toBeLessThanOrEqual(50);
  });

  test('FR-72e: only an Admin may resolve exceptions with a validated note and an audit-only order change', async () => {
    await cancelWithBuyer();
    await adminHandoverRequest(harness, scenario, await validHandoverBody(scenario)).expect(409);
    const exceptionId = await handoverExceptionId(scenario.orderId);
    const url = `/api/admin/order-exceptions/${exceptionId}/resolve`;
    const send = (body) => request(getApp()).post(url).send(body);

    await send({ resolutionNote: 'Reviewed the exception' }).expect(401);
    await send({ resolutionNote: 'Reviewed the exception' })
      .set('Authorization', authHeader(harness.fixture.userId)).expect(403);
    await send({ resolutionNote: 'Reviewed the exception' })
      .set('Authorization', authHeader(scenario.buyerId)).expect(403);
    await send({ resolutionNote: 'Reviewed the exception' })
      .set('Authorization', authHeader(harness.moderatorId)).expect(403);

    const adminSend = (body) => send(body).set('Authorization', authHeader(harness.adminId));
    await adminSend({ resolutionNote: '  ' }).expect(400);
    await adminSend({ resolutionNote: 'ok' }).expect(400);
    await adminSend({ resolutionNote: 'x'.repeat(501) }).expect(400);
    await adminSend({ resolutionNote: 'Valid resolution note', extra: 'not allowed' }).expect(400);
    await request(getApp())
      .post(`/api/admin/order-exceptions/${crypto.randomUUID()}/resolve`)
      .set('Authorization', authHeader(harness.adminId))
      .send({ resolutionNote: 'Valid resolution note' })
      .expect(404);

    const before = await orderMoneySnapshot(scenario.orderId);
    const { rows: auditsBefore } = await db.query(
      `SELECT count(*)::int AS count FROM money_audit_events
       WHERE order_id = $1 AND action = 'order_exception_resolved'`,
      [scenario.orderId]
    );

    const resolutionNote = 'Confirmed the cancellation and retained the original disposition';
    const response = await adminSend({ resolutionNote })
      .expect('Cache-Control', 'private, no-store')
      .expect(200);
    expect(response.body).toMatchObject({
      id: exceptionId,
      orderId: scenario.orderId,
      kind: 'handover_after_cancel',
      resolvedBy: harness.adminId,
      resolutionNote,
    });
    expect(response.body.resolvedAt).toBeTruthy();
    await adminSend({ resolutionNote: 'Attempt to resolve it again' }).expect(409);

    expect(await orderMoneySnapshot(scenario.orderId)).toEqual(before);
    const { rows: auditsAfter } = await db.query(
      `SELECT count(*)::int AS count FROM money_audit_events
       WHERE order_id = $1 AND action = 'order_exception_resolved'`,
      [scenario.orderId]
    );
    expect(auditsAfter[0].count).toBe(auditsBefore[0].count + 1);
    const { rows: auditRows } = await db.query(
      `SELECT actor_id, action, order_id, reason, metadata
       FROM money_audit_events
       WHERE order_id = $1 AND action = 'order_exception_resolved'`,
      [scenario.orderId]
    );
    expect(auditRows).toEqual([{
      actor_id: harness.adminId,
      action: 'order_exception_resolved',
      order_id: scenario.orderId,
      reason: resolutionNote,
      metadata: { exceptionId, kind: 'handover_after_cancel' },
    }]);
  });

  test('FR-72e: ten concurrent resolutions commit exactly one audit and one success', async () => {
    await cancelWithBuyer();
    await adminHandoverRequest(harness, scenario, await validHandoverBody(scenario)).expect(409);
    const exceptionId = await handoverExceptionId(scenario.orderId);
    const url = `/api/admin/order-exceptions/${exceptionId}/resolve`;
    const responses = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      request(getApp())
        .post(url)
        .set('Authorization', authHeader(harness.adminId))
        .send({ resolutionNote: `Parallel resolution ${index}` })
    ));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(9);
    const { rows } = await db.query(
      `SELECT count(*)::int AS count
       FROM money_audit_events
       WHERE order_id = $1 AND action = 'order_exception_resolved'`,
      [scenario.orderId]
    );
    expect(rows[0].count).toBe(1);
  });
});
