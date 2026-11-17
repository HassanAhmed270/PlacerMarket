const {
  authHeader,
  cleanupHarness,
  cleanupScenario,
  createHarness,
  createScenario,
  db,
  getApp,
  request,
  restoreHandoverTestEnvironment,
} = require('./delivery-handover.helpers');
const events = require('../../src/lib/events');
const notifications = require('../../src/modules/notifications.service');
const queue = require('../../src/lib/queue');

let harness;
let scenario;

async function prepareDeliveryAttempt(target) {
  await db.query(
    `UPDATE orders
     SET status = 'handed_to_delivery', handed_over_at = now() - INTERVAL '5 minutes'
     WHERE id = $1`,
    [target.orderId]
  );
  await db.query(
    `INSERT INTO delivery_status_log (order_id, status, entered_by, note)
     VALUES ($1, 'delivery_failed', $2, 'Courier attempted delivery; buyer refused.')`,
    [target.orderId, harness.adminId]
  );
}

function recordRefusal(target, actorId, note) {
  return request(getApp())
    .post(`/api/admin/orders/${target.orderId}/refused-delivery`)
    .set('Authorization', authHeader(actorId))
    .send({ note });
}

beforeAll(async () => {
  harness = await createHarness();
});

beforeEach(async () => {
  scenario = await createScenario(harness);
  await prepareDeliveryAttempt(scenario);
});

afterEach(async () => {
  await global.drainIntegrationListeners(5000);
  if (scenario) await cleanupScenario(harness, scenario);
});

afterAll(async () => {
  await cleanupHarness(harness);
  restoreHandoverTestEnvironment();
});

describe('record-only refused delivery', () => {
  test('FR-33b: Admin records a refusal without changing money or payout state and notifies the seller without Admin identity', async () => {
    await db.query(
      `INSERT INTO seller_payouts
         (order_id, seller_id, attempt, status, amount, currency, initiated_by)
       VALUES ($1, $2, 1, 'initiated', '5.00', 'PKR', $3)`,
      [scenario.orderId, scenario.sellerId, harness.adminId]
    );
    const { rows: beforeRows } = await db.query(
      `SELECT
         (SELECT count(*)::int FROM ledger_entries WHERE order_id = $1) AS ledger_count,
         (SELECT status FROM seller_payouts WHERE order_id = $1) AS payout_status,
         (SELECT count(*)::int FROM refunds WHERE order_id = $1) AS refund_count`,
      [scenario.orderId]
    );

    const response = await recordRefusal(
      scenario,
      harness.adminId,
      '  Buyer refused delivery at the door.  '
    ).expect(201);
    expect(response.body).toMatchObject({
      orderId: scenario.orderId,
      outcome: 'refused',
      recordedBy: harness.adminId,
      note: 'Buyer refused delivery at the door.',
      recordedAt: expect.any(String),
    });

    const { rows: orderRows } = await db.query(
      `SELECT status,
              (SELECT count(*)::int FROM ledger_entries WHERE order_id = $1) AS ledger_count,
              (SELECT status FROM seller_payouts WHERE order_id = $1) AS payout_status,
              (SELECT count(*)::int FROM refunds WHERE order_id = $1) AS refund_count
       FROM orders WHERE id = $1`,
      [scenario.orderId]
    );
    expect(orderRows[0]).toEqual({
      status: 'refused_at_door',
      ledger_count: beforeRows[0].ledger_count,
      payout_status: beforeRows[0].payout_status,
      refund_count: beforeRows[0].refund_count,
    });

    const { rows: auditRows } = await db.query(
      `SELECT action FROM money_audit_events
       WHERE order_id = $1 AND action = 'delivery_refused_recorded'`,
      [scenario.orderId]
    );
    expect(auditRows).toEqual([{ action: 'delivery_refused_recorded' }]);

    const adminOrder = await request(getApp())
      .get(`/api/admin/orders/${scenario.orderId}`)
      .set('Authorization', authHeader(harness.adminId))
      .expect(200);
    expect(adminOrder.body.deliveryOutcomes).toEqual([expect.objectContaining({
      outcome: 'refused',
      recordedBy: harness.adminId,
      note: 'Buyer refused delivery at the door.',
    })]);
    const moderatorOutcomes = await request(getApp())
      .get(`/api/admin/orders/${scenario.orderId}/delivery-outcomes`)
      .set('Authorization', authHeader(harness.moderatorId))
      .expect(200);
    expect(moderatorOutcomes.body.deliveryOutcomes).toHaveLength(1);

    await global.drainIntegrationListeners(5000);
    const { rows: jobs } = await db.query(
      `SELECT data FROM pgboss.job
       WHERE name = $1 AND data->>'eventName' = $2
         AND data->'payload'->>'orderId' = $3`,
      [queue.QUEUES.NOTIFICATIONS, events.ORDER_STATUS_CHANGED, scenario.orderId]
    );
    expect(jobs).toHaveLength(1);
    const transactionDb = {
      executeSql: (text, values = []) => transactionDb.client.query(text, values),
    };
    await db.withTransaction(async (client) => {
      transactionDb.client = client;
      await notifications.processNotificationJob(jobs[0].data, transactionDb);
    });
    const { rows: sellerNotifications } = await db.query(
      `SELECT payload FROM notifications
       WHERE user_id = $1 AND event_type = 'order_status'
         AND payload->>'orderId' = $2 AND payload->>'status' = 'refused_at_door'`,
      [scenario.sellerId, scenario.orderId]
    );
    expect(sellerNotifications).toHaveLength(1);
    expect(JSON.stringify(sellerNotifications[0].payload)).not.toContain(harness.adminId);
  });

  test('FR-33b: refusal note length and order state are validated', async () => {
    await recordRefusal(scenario, harness.adminId, 'ab').expect(400);
    await recordRefusal(scenario, harness.adminId, 'x'.repeat(301)).expect(400);
    await db.query("UPDATE orders SET status = 'funded' WHERE id = $1", [scenario.orderId]);
    await recordRefusal(scenario, harness.adminId, 'Valid refusal note.').expect(409);

    const { rows } = await db.query(
      'SELECT count(*)::int AS count FROM delivery_outcomes WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(rows[0].count).toBe(0);
  });

  test('FR-33b: Moderators cannot record a refusal and a second record returns 409', async () => {
    await recordRefusal(scenario, harness.moderatorId, 'Valid refusal note.').expect(403);
    await recordRefusal(scenario, harness.adminId, 'Valid refusal note.').expect(201);
    await recordRefusal(scenario, harness.adminId, 'Second refusal note.').expect(409);

    const { rows } = await db.query(
      'SELECT count(*)::int AS count FROM delivery_outcomes WHERE order_id = $1 AND outcome = $2',
      [scenario.orderId, 'refused']
    );
    expect(rows[0].count).toBe(1);
  });

  test('FR-33b: refusal does not require step-up, matching the existing Admin delivery status mutations', async () => {
    await recordRefusal(scenario, harness.adminId, 'Valid refusal note.').expect(201);
  });
});
