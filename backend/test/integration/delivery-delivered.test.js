const {
  adminDeliveredRequest,
  authHeader,
  buyerCancelRequest,
  cleanupHarness,
  cleanupScenario,
  createHarness,
  createScenario,
  db,
  getApp,
  request,
  restoreHandoverTestEnvironment,
} = require('./delivery-handover.helpers');
const listings = require('../../src/modules/listings.service');
const eventBus = require('../../src/lib/eventBus');
const events = require('../../src/lib/events');

let harness;
let scenario;
let additionalScenarios;

async function setHandedOver(orderId, status = 'handed_to_delivery') {
  await db.query(
    `UPDATE orders
     SET status = $2, handed_over_at = now()
     WHERE id = $1`,
    [orderId, status]
  );
}

async function countsForOrder(orderId) {
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*)::int FROM payout_holds WHERE order_id = $1) AS holds,
       (SELECT count(*)::int FROM delivery_status_log WHERE order_id = $1) AS delivery_logs,
       (SELECT count(*)::int FROM money_audit_events WHERE order_id = $1) AS audit_rows`,
    [orderId]
  );
  return rows[0];
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

describe('FR-68 Admin delivery and payout hold', () => {
  test('FR-68: only Admin can mark a handed-over reservation order delivered', async () => {
    await setHandedOver(scenario.orderId);
    const url = `/api/admin/orders/${scenario.orderId}/delivered`;
    const send = () => request(getApp()).post(url).send({ note: 'Delivered to recipient' });

    await send().expect(401);
    await send().set('Authorization', authHeader(harness.fixture.userId)).expect(403);
    await send().set('Authorization', authHeader(scenario.buyerId)).expect(403);
    await send().set('Authorization', authHeader(harness.moderatorId)).expect(403);
    const delivered = await send().set('Authorization', authHeader(harness.adminId))
      .expect('Cache-Control', 'private, no-store');
    expect({ status: delivered.status, body: delivered.body }).toMatchObject({ status: 200 });
  });

  test('FR-68: ineligible order states return 409 without a hold or state change', async () => {
    const other = await createScenario(harness);
    additionalScenarios.push(other);
    await setHandedOver(other.orderId);

    const cases = [
      { orderId: scenario.orderId },
      { orderId: scenario.orderId, mutate: async () => {
        await db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [scenario.orderId]);
      } },
      { orderId: scenario.orderId, mutate: async () => {
        await db.query(
          `UPDATE orders SET status = 'held', handed_over_at = now(), delivered_at = now()
           WHERE id = $1`,
          [scenario.orderId]
        );
      } },
      { orderId: scenario.orderId, mutate: async () => {
        await db.query(
          `UPDATE orders SET status = 'handed_to_delivery', handed_over_at = NULL
           WHERE id = $1`,
          [scenario.orderId]
        );
      } },
    ];

    for (const item of cases) {
      if (item.mutate) await item.mutate();
      const { rows: beforeRows } = await db.query(
        'SELECT status, delivered_at, handed_over_at FROM orders WHERE id = $1',
        [item.orderId]
      );
      await adminDeliveredRequest(harness, scenario, { note: 'Delivery check' }).expect(409);
      const { rows: afterRows } = await db.query(
        'SELECT status, delivered_at, handed_over_at FROM orders WHERE id = $1',
        [item.orderId]
      );
      expect(afterRows[0]).toEqual(beforeRows[0]);
      expect(await countsForOrder(item.orderId)).toEqual({
        holds: 0,
        delivery_logs: 0,
        audit_rows: 0,
      });
    }

    expect(await countsForOrder(other.orderId)).toEqual({
      holds: 0,
      delivery_logs: 0,
      audit_rows: 0,
    });
  });

  test('FR-68, FR-45b, FR-45c: delivery starts one configured hold and writes one delivery log and audit', async () => {
    await setHandedOver(scenario.orderId);
    const { rows: settings } = await db.query(
      `SELECT key, value FROM platform_settings
       WHERE key IN ('payout_hold_days', 'complaint_window_days')`
    );
    const settingValues = Object.fromEntries(settings.map(({ key, value }) => [key, Number(value)]));
    const emit = jest.spyOn(eventBus, 'emit');
    try {
      const response = await adminDeliveredRequest(harness, scenario, {
        note: '  Delivered to the recipient  ',
      }).expect('Cache-Control', 'private, no-store');
      expect({ status: response.status, body: response.body }).toMatchObject({ status: 200 });
      expect(response.body).toMatchObject({
        orderId: scenario.orderId,
        status: 'held',
        payoutHold: {
          state: 'held',
          holdWindowDays: settingValues.payout_hold_days,
          complaintWindowDays: settingValues.complaint_window_days,
        },
      });
      expect(new Date(response.body.deliveredAt).getTime()).toBeGreaterThan(0);
      expect(new Date(response.body.payoutHold.holdStartedAt).getTime()).toBeGreaterThan(0);

      const { rows: orderRows } = await db.query(
        'SELECT status, delivered_at, handed_over_at FROM orders WHERE id = $1',
        [scenario.orderId]
      );
      expect(orderRows[0]).toMatchObject({ status: 'held' });
      expect(orderRows[0].delivered_at).toBeInstanceOf(Date);
      expect(orderRows[0].handed_over_at).toBeInstanceOf(Date);

      const { rows: holdRows } = await db.query(
        `SELECT state, hold_started_at, hold_window_days, complaint_window_days, released_at
         FROM payout_holds WHERE order_id = $1`,
        [scenario.orderId]
      );
      expect(holdRows).toHaveLength(1);
      expect(holdRows[0]).toMatchObject({
        state: 'held',
        hold_window_days: settingValues.payout_hold_days,
        complaint_window_days: settingValues.complaint_window_days,
        released_at: null,
      });

      const { rows: logRows } = await db.query(
        `SELECT status, note, entered_by
         FROM delivery_status_log WHERE order_id = $1`,
        [scenario.orderId]
      );
      expect(logRows).toEqual([{
        status: 'delivered',
        note: 'Delivered to the recipient',
        entered_by: harness.adminId,
      }]);

      const { rows: auditRows } = await db.query(
        `SELECT actor_id, action, reason, metadata
         FROM money_audit_events WHERE order_id = $1`,
        [scenario.orderId]
      );
      expect(auditRows).toEqual([{
        actor_id: harness.adminId,
        action: 'order_delivered',
        reason: 'Admin marked reservation-backed order delivered',
        metadata: {},
      }]);

      const { rows: moneyRows } = await db.query(
        `SELECT
           (SELECT count(*)::int FROM settlements WHERE order_id = $1) AS settlements,
           (SELECT count(*)::int FROM refunds WHERE order_id = $1) AS refunds`,
        [scenario.orderId]
      );
      expect(moneyRows[0]).toEqual({ settlements: 0, refunds: 0 });
      expect(emit).toHaveBeenCalledWith(events.PAYOUT_HELD, { orderId: scenario.orderId });
      expect(emit).not.toHaveBeenCalledWith(events.PAYOUT_RELEASED, expect.anything());
      expect(emit).not.toHaveBeenCalledWith(events.PAYOUT_FORCE_RELEASED, expect.anything());
    } finally {
      emit.mockRestore();
    }
  });

  test('FR-68: empty, whitespace-only, oversized, and extra-field notes return 400', async () => {
    await setHandedOver(scenario.orderId);
    for (const body of [
      {},
      { note: '' },
      { note: '   ' },
      { note: 'x'.repeat(501) },
      { note: 'Delivered', extra: 'not accepted' },
    ]) {
      await adminDeliveredRequest(harness, scenario, body).expect(400);
    }
    expect(await countsForOrder(scenario.orderId)).toEqual({
      holds: 0,
      delivery_logs: 0,
      audit_rows: 0,
    });
  });

  test('FR-68: 20 concurrent delivered calls produce one success and one hold', async () => {
    await setHandedOver(scenario.orderId, 'out_for_delivery');
    const responses = await Promise.all(Array.from({ length: 20 }, () =>
      adminDeliveredRequest(harness, scenario, { note: 'Delivered in a race' })));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(19);
    expect(responses.every((response) => [200, 409].includes(response.status))).toBe(true);
    expect(await countsForOrder(scenario.orderId)).toEqual({
      holds: 1,
      delivery_logs: 1,
      audit_rows: 1,
    });
  });

  test('FR-68: delivery racing buyer cancellation after handover has no refund', async () => {
    await setHandedOver(scenario.orderId);
    const [delivered, cancellation] = await Promise.all([
      adminDeliveredRequest(harness, scenario, { note: 'Delivered during cancellation race' }),
      buyerCancelRequest(scenario),
    ]);
    expect({ status: delivered.status, body: delivered.body }).toMatchObject({ status: 200 });
    expect(cancellation.status).toBe(409);
    const { rows } = await db.query(
      `SELECT order_row.status,
              (SELECT count(*)::int FROM payout_holds WHERE order_id = $1) AS holds,
              (SELECT count(*)::int FROM refunds WHERE order_id = $1) AS refunds
       FROM orders order_row WHERE order_row.id = $1`,
      [scenario.orderId]
    );
    expect(rows[0]).toEqual({ status: 'held', holds: 1, refunds: 0 });
  });

  test('FR-68: delivery racing take-down leaves a hold and no refund', async () => {
    await setHandedOver(scenario.orderId);
    const [delivered] = await Promise.all([
      adminDeliveredRequest(harness, scenario, { note: 'Delivered during take-down race' }),
      listings.rejectOrUnpublishListing(scenario.listingId, {
        reviewerId: harness.adminId,
        reason: 'Admin take-down race',
      }),
    ]);
    expect({ status: delivered.status, body: delivered.body }).toMatchObject({ status: 200 });
    const { rows } = await db.query(
      `SELECT order_row.status,
              (SELECT count(*)::int FROM payout_holds WHERE order_id = $1) AS holds,
              (SELECT count(*)::int FROM refunds WHERE order_id = $1) AS refunds,
              (SELECT count(*)::int FROM money_audit_events
               WHERE order_id = $1 AND action = 'order_delivered') AS delivered_audits
       FROM orders order_row WHERE order_row.id = $1`,
      [scenario.orderId]
    );
    expect(rows[0]).toEqual({
      status: 'held',
      holds: 1,
      refunds: 0,
      delivered_audits: 1,
    });
  });
});
