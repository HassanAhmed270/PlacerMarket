const {
  adminDeliveredRequest,
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
const payout = require('../../src/modules/payout.service');
const settlement = require('../../src/modules/settlement.service');

let harness;
let scenario;

function releaseRequest(actorId, orderId, body = {
  payoutReference: 'bank-ref-123',
  note: 'Manual transfer confirmed',
}) {
  const call = request(getApp()).post(`/api/admin/orders/${orderId}/payout/release`).send(body);
  return actorId ? call.set('Authorization', authHeader(actorId)) : call;
}

async function deliverScenario(target, note = 'Delivered for payout test') {
  await db.query(
    `UPDATE orders
     SET status = 'handed_to_delivery', handed_over_at = now() - INTERVAL '5 minutes'
     WHERE id = $1`,
    [target.orderId]
  );
  await adminDeliveredRequest(harness, target, { note }).expect(200);
}

async function elapsePayoutWindows(target) {
  await db.query(
    `UPDATE payout_holds
     SET hold_started_at = now() - INTERVAL '10 days'
     WHERE order_id = $1`,
    [target.orderId]
  );
  await db.query(
    `UPDATE orders SET delivered_at = now() - INTERVAL '10 days' WHERE id = $1`,
    [target.orderId]
  );
}

async function getPayoutState(orderId) {
  const { rows } = await db.query(
    `SELECT
       (SELECT status FROM orders WHERE id = $1) AS order_status,
       (SELECT state FROM payout_holds WHERE order_id = $1) AS hold_state,
       (SELECT count(*)::int FROM settlements WHERE order_id = $1) AS settlements,
       (SELECT count(*)::int FROM ledger_entries WHERE order_id = $1) AS ledger,
       (SELECT count(*)::int FROM money_audit_events WHERE order_id = $1) AS audits,
       (SELECT count(*)::int FROM refunds WHERE order_id = $1) AS refunds`,
    [orderId]
  );
  return rows[0];
}

async function deleteDisputes(orderId) {
  await db.query(
    `UPDATE payout_holds SET state = 'held', dispute_id = NULL
     WHERE order_id = $1 AND state = 'paused_for_dispute'`,
    [orderId]
  );
  await db.query(
    `DELETE FROM dispute_evidence
     WHERE dispute_id IN (SELECT id FROM disputes WHERE order_id = $1)`,
    [orderId]
  );
  await db.query('DELETE FROM disputes WHERE order_id = $1', [orderId]);
}

beforeAll(async () => {
  harness = await createHarness();
});

beforeEach(async () => {
  scenario = await createScenario(harness);
  await deliverScenario(scenario);
});

afterEach(async () => {
  await global.drainIntegrationListeners(5000);
  if (scenario) {
    await deleteDisputes(scenario.orderId);
    await cleanupScenario(harness, scenario);
  }
});

afterAll(async () => {
  await cleanupHarness(harness);
  restoreHandoverTestEnvironment();
});

describe('FR-65 manual reservation-backed payout release', () => {
  test('FR-65: seller, buyer, moderator, and anonymous requests cannot release a payout', async () => {
    const responses = await Promise.all([
      releaseRequest(harness.fixture.userId, scenario.orderId),
      releaseRequest(scenario.buyerId, scenario.orderId),
      releaseRequest(harness.moderatorId, scenario.orderId),
      releaseRequest(null, scenario.orderId),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 401]);
    expect(await getPayoutState(scenario.orderId)).toEqual({
      order_status: 'held',
      hold_state: 'held',
      settlements: 0,
      ledger: 0,
      audits: 1,
      refunds: 0,
    });
  });

  test('FR-65: an early release returns 409 with the earliest release time and no changes', async () => {
    const before = await getPayoutState(scenario.orderId);
    const response = await releaseRequest(harness.adminId, scenario.orderId);
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/earliest release time is .*Z/);
    expect(await getPayoutState(scenario.orderId)).toEqual(before);
  });

  test('FR-65: an order that is not held or has not been delivered returns 409', async () => {
    await db.query("UPDATE orders SET status = 'funded' WHERE id = $1", [scenario.orderId]);
    await releaseRequest(harness.adminId, scenario.orderId).expect(409);
    await db.query(
      `UPDATE orders SET status = 'held', delivered_at = NULL WHERE id = $1`,
      [scenario.orderId]
    );
    await releaseRequest(harness.adminId, scenario.orderId).expect(409);
    expect(await getPayoutState(scenario.orderId)).toMatchObject({
      order_status: 'held',
      hold_state: 'held',
      settlements: 0,
      ledger: 0,
      refunds: 0,
    });
  });

  test('FR-65: non-reservation orders are not found and payout input is trimmed and validated', async () => {
    const legacyOrderId = await createLegacyOrder(harness, scenario);
    await releaseRequest(harness.adminId, legacyOrderId).expect(404);
    await releaseRequest(harness.adminId, scenario.orderId, {
      payoutReference: '  x  ',
      note: 'Valid transfer note',
    }).expect(400);
    await releaseRequest(harness.adminId, scenario.orderId, {
      payoutReference: 'valid-ref',
      note: 'Valid transfer note',
      extra: true,
    }).expect(400);
    expect(await getPayoutState(scenario.orderId)).toMatchObject({
      order_status: 'held',
      hold_state: 'held',
      settlements: 0,
      ledger: 0,
      refunds: 0,
    });
  });

  test('FR-45g, FR-65: an open dispute blocks manual payout release', async () => {
    await request(getApp())
      .post(`/api/disputes/orders/${scenario.orderId}`)
      .set('Authorization', authHeader(scenario.buyerId))
      .send({
        reasonText: 'The delivered item differs from the listing.',
        evidenceUrls: ['https://media.example.test/dispute-evidence.jpg'],
      })
      .expect(201);
    await global.drainIntegrationListeners(5000);

    const response = await releaseRequest(harness.adminId, scenario.orderId);
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/dispute is open/i);
    expect(await getPayoutState(scenario.orderId)).toMatchObject({
      order_status: 'held',
      hold_state: 'paused_for_dispute',
      settlements: 0,
      ledger: 0,
      refunds: 0,
    });
  });

  test('FR-65: release stores snapshot settlement amounts, one audit, and leaves payment and refund state unchanged', async () => {
    await elapsePayoutWindows(scenario);
    const { rows: beforePaymentRows } = await db.query(
      'SELECT id, status, amount, gateway_fee, updated_at FROM payments WHERE order_id = $1',
      [scenario.orderId]
    );
    const { rows: reservationRows } = await db.query(
      `SELECT item_price_snapshot, delivery_fee_snapshot, currency
       FROM reservations WHERE id = $1`,
      [scenario.reservationId]
    );
    const { rows: settingRows } = await db.query(
      "SELECT value FROM platform_settings WHERE key = 'commission_percent'"
    );
    const { rows: notificationRowsBefore } = await db.query(
      'SELECT count(*)::int AS count FROM notifications WHERE user_id = $1',
      [scenario.buyerId]
    );
    const expected = settlement.calculateReservationSettlement(
      reservationRows[0].item_price_snapshot,
      settingRows[0].value
    );
    const logSpies = ['log', 'info', 'warn', 'error'].map((method) =>
      jest.spyOn(console, method).mockImplementation(() => {})
    );
    let response;
    let loggedText = '';
    try {
      response = await releaseRequest(harness.adminId, scenario.orderId, {
        payoutReference: '  bank-ref-123  ',
        note: '  Manual transfer confirmed  ',
      });
      loggedText = logSpies.flatMap((spy) => spy.mock.calls)
        .flat()
        .map((value) => String(value))
        .join(' ');
    } finally {
      for (const spy of logSpies) spy.mockRestore();
    }

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('private');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toEqual({
      orderId: scenario.orderId,
      status: 'completed',
      payout: {
        sellerNetAmount: expected.sellerNetAmount,
        commissionAmount: expected.commissionAmount,
        currency: reservationRows[0].currency,
      },
      releasedAt: expect.any(String),
      payoutReference: 'bank-ref-123',
    });
    expect(typeof response.body.payout.sellerNetAmount).toBe('string');
    expect(typeof response.body.payout.commissionAmount).toBe('string');
    expect(Object.keys(response.body)).toEqual([
      'orderId', 'status', 'payout', 'releasedAt', 'payoutReference',
    ]);
    expect(new Date(response.body.releasedAt).toISOString()).toBe(response.body.releasedAt);

    expect(loggedText).not.toContain('bank-ref-123');
    expect(loggedText).not.toContain('Manual transfer confirmed');

    const { rows: orderRows } = await db.query(
      'SELECT status FROM orders WHERE id = $1',
      [scenario.orderId]
    );
    const { rows: holdRows } = await db.query(
      'SELECT state, released_at FROM payout_holds WHERE order_id = $1',
      [scenario.orderId]
    );
    const { rows: settlementRows } = await db.query(
      `SELECT commission_percent, commission_amount::text, seller_net_payout::text,
              payout_initiated_by, payout_initiated_at
       FROM settlements WHERE order_id = $1`,
      [scenario.orderId]
    );
    const { rows: auditRows } = await db.query(
      `SELECT actor_id, action, reason, metadata
       FROM money_audit_events
       WHERE order_id = $1 AND action = 'seller_payout_manual_released'`,
      [scenario.orderId]
    );
    const { rows: afterPaymentRows } = await db.query(
      'SELECT id, status, amount, gateway_fee, updated_at FROM payments WHERE order_id = $1',
      [scenario.orderId]
    );
    const { rows: refundRows } = await db.query(
      'SELECT id FROM refunds WHERE order_id = $1',
      [scenario.orderId]
    );
    const { rows: codRows } = await db.query(
      'SELECT order_id FROM cod_collections WHERE order_id = $1',
      [scenario.orderId]
    );
    const { rows: notificationRowsAfter } = await db.query(
      'SELECT count(*)::int AS count FROM notifications WHERE user_id = $1',
      [scenario.buyerId]
    );
    expect(orderRows).toEqual([{ status: 'completed' }]);
    expect(holdRows[0].state).toBe('released');
    expect(holdRows[0].released_at.toISOString()).toBe(response.body.releasedAt);
    expect(settlementRows).toEqual([{
      commission_percent: Number(settingRows[0].value).toFixed(2),
      commission_amount: expected.commissionAmount,
      seller_net_payout: expected.sellerNetAmount,
      payout_initiated_by: harness.adminId,
      payout_initiated_at: expect.any(Date),
    }]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actor_id: harness.adminId,
      action: 'seller_payout_manual_released',
      reason: 'Manual transfer confirmed',
      metadata: {
        payoutReference: 'bank-ref-123',
        note: 'Manual transfer confirmed',
        itemPrice: reservationRows[0].item_price_snapshot,
        deliveryFee: reservationRows[0].delivery_fee_snapshot,
        sellerNetAmount: expected.sellerNetAmount,
        commissionAmount: expected.commissionAmount,
        currency: reservationRows[0].currency,
      },
    });
    expect(afterPaymentRows).toEqual(beforePaymentRows);
    expect(refundRows).toEqual([]);
    expect(codRows).toEqual([]);
    expect(notificationRowsAfter).toEqual(notificationRowsBefore);
  });

  test('FR-65: repeating a successful release returns 409 without a second financial record', async () => {
    await elapsePayoutWindows(scenario);
    await releaseRequest(harness.adminId, scenario.orderId).expect(200);
    await releaseRequest(harness.adminId, scenario.orderId).expect(409);
    expect(await getPayoutState(scenario.orderId)).toEqual({
      order_status: 'completed',
      hold_state: 'released',
      settlements: 1,
      ledger: 3,
      audits: 2,
      refunds: 0,
    });
  });

  test('FR-65: 20 parallel releases have exactly one 200 response', async () => {
    await elapsePayoutWindows(scenario);
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => releaseRequest(harness.adminId, scenario.orderId))
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(19);
    expect(await getPayoutState(scenario.orderId)).toEqual({
      order_status: 'completed',
      hold_state: 'released',
      settlements: 1,
      ledger: 3,
      audits: 2,
      refunds: 0,
    });
  });

  test('FR-43, FR-65: release and dispute filing race has exactly one winner across 20 orders', async () => {
    const { rows: originalWindowRows } = await db.query(
      "SELECT value FROM platform_settings WHERE key = 'complaint_window_days'"
    );
    await db.query(
      "UPDATE platform_settings SET value = '3' WHERE key = 'complaint_window_days'"
    );
    try {
      for (let index = 0; index < 20; index += 1) {
        const target = await createScenario(harness);
        try {
          await deliverScenario(target, `Delivered for payout race ${index + 1}`);
          await db.query(
            `UPDATE payout_holds
             SET hold_started_at = now() - INTERVAL '2 days',
                 hold_window_days = 1,
                 complaint_window_days = 1
             WHERE order_id = $1`,
            [target.orderId]
          );
          await db.query(
            `UPDATE orders SET delivered_at = now() - INTERVAL '2 days'
             WHERE id = $1`,
            [target.orderId]
          );
          const [releaseResponse, disputeResponse] = await Promise.all([
            releaseRequest(harness.adminId, target.orderId),
            request(getApp())
              .post(`/api/disputes/orders/${target.orderId}`)
              .set('Authorization', authHeader(target.buyerId))
              .send({
                reasonText: 'The delivered item differs from the listing.',
                evidenceUrls: ['https://media.example.test/dispute-evidence.jpg'],
              }),
          ]);
          if (releaseResponse.status === 200) {
            expect(disputeResponse.status).toBe(409);
          } else {
            expect(releaseResponse.status).toBe(409);
            expect(disputeResponse.status).toBe(201);
          }
          await global.drainIntegrationListeners(5000);
          const { rows: orderRows } = await db.query(
            `SELECT status,
                    (SELECT state FROM payout_holds WHERE order_id = $1) AS hold_state,
                    (SELECT count(*)::int FROM disputes WHERE order_id = $1) AS disputes
             FROM orders WHERE id = $1`,
            [target.orderId]
          );
          if (releaseResponse.status === 200) {
            expect(orderRows).toEqual([{
              status: 'completed',
              hold_state: 'released',
              disputes: 0,
            }]);
          } else {
            expect(orderRows).toEqual([{
              status: 'held',
              hold_state: 'paused_for_dispute',
              disputes: 1,
            }]);
            await deleteDisputes(target.orderId);
          }
        } finally {
          await cleanupScenario(harness, target);
        }
      }
    } finally {
      await db.query(
        'UPDATE platform_settings SET value = $1 WHERE key = $2',
        [originalWindowRows[0].value, 'complaint_window_days']
      );
    }
  });

  test('FR-63a, FR-65: legacy payout operations refuse or skip reservation-backed orders', async () => {
    await elapsePayoutWindows(scenario);
    await expect(payout.forceReleasePayoutEarly(scenario.orderId, {
      adminId: harness.adminId,
      reasonNote: 'Approved legacy test',
    })).rejects.toMatchObject({ statusCode: 409 });
    await expect(payout.checkAndReleaseDuePayouts()).resolves.toEqual([]);
    expect(await getPayoutState(scenario.orderId)).toMatchObject({
      order_status: 'held',
      hold_state: 'held',
      settlements: 0,
      ledger: 0,
      refunds: 0,
    });
  });
});
