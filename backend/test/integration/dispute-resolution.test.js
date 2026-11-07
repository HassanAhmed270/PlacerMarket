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
const eventBus = require('../../src/lib/eventBus');
const events = require('../../src/lib/events');

let harness;
let scenario;

function fileDispute(actorId, orderId) {
  return request(getApp())
    .post(`/api/disputes/orders/${orderId}`)
    .set('Authorization', authHeader(actorId))
    .send({
      reasonText: 'The delivered item differs from the listing.',
      evidenceUrls: ['https://media.example.test/dispute-evidence.jpg'],
    });
}

function resolveDispute(actorId, disputeId, resolutionAmountToBuyer) {
  return request(getApp())
    .post(`/api/disputes/${disputeId}/resolve`)
    .set('Authorization', authHeader(actorId))
    .send({
      resolutionAmountToBuyer,
      resolutionNote: 'Decision recorded after reviewing the evidence.',
    });
}

function releasePayout(actorId, orderId) {
  return request(getApp())
    .post(`/api/admin/orders/${orderId}/payout/release`)
    .set('Authorization', authHeader(actorId))
    .send({ payoutReference: 'bank-ref-123', note: 'Manual transfer confirmed' });
}

async function deliverScenario(target) {
  await db.query(
    `UPDATE orders
     SET status = 'handed_to_delivery', handed_over_at = now() - INTERVAL '5 minutes'
     WHERE id = $1`,
    [target.orderId]
  );
  await adminDeliveredRequest(harness, target, { note: 'Delivered for dispute resolution test' })
    .expect(200);
}

async function fileBuyerDispute() {
  const response = await fileDispute(scenario.buyerId, scenario.orderId).expect(201);
  await global.drainIntegrationListeners(5000);
  return response;
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

async function getMoneyState(orderId) {
  const { rows } = await db.query(
    `SELECT
       (SELECT status FROM orders WHERE id = $1) AS order_status,
       (SELECT status FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1) AS payment_status,
       (SELECT amount::text FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1) AS payment_amount,
       (SELECT updated_at FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1) AS payment_updated_at,
       (SELECT count(*)::int FROM refunds WHERE order_id = $1) AS refunds,
       (SELECT count(*)::int FROM ledger_entries WHERE order_id = $1) AS ledger,
       (SELECT count(*)::int FROM settlements WHERE order_id = $1) AS settlements`,
    [orderId]
  );
  return rows[0];
}

async function getDisputeAuditCount(orderId) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS count
     FROM money_audit_events
     WHERE order_id = $1 AND action IN ('dispute_resolved_release', 'dispute_refund_required')`,
    [orderId]
  );
  return rows[0].count;
}

async function getDisputeExceptionRows(orderId) {
  const { rows } = await db.query(
    `SELECT kind, courier_pickup_at, note, recorded_by, resolved_at
     FROM order_exceptions
     WHERE order_id = $1 AND kind = 'dispute_refund_required'
     ORDER BY recorded_at, id`,
    [orderId]
  );
  return rows;
}

async function resetDisputeScenario(orderId) {
  await db.query(
    `UPDATE payout_holds
     SET state = 'held', dispute_id = NULL
     WHERE order_id = $1`,
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
    await resetDisputeScenario(scenario.orderId);
    await cleanupScenario(harness, scenario);
  }
});

afterAll(async () => {
  await cleanupHarness(harness);
  restoreHandoverTestEnvironment();
});

describe('FR-45 dispute resolution with reservation-backed payouts', () => {
  test('FR-45, FR-65: seller resolution resumes the hold and allows stage 9 manual payout release', async () => {
    const dispute = await fileBuyerDispute();
    expect(await db.query('SELECT state FROM payout_holds WHERE order_id = $1', [scenario.orderId]))
      .toMatchObject({ rows: [{ state: 'paused_for_dispute' }] });

    await resolveDispute(harness.adminId, dispute.body.id, 0).expect(200);
    const { rows: holdRows } = await db.query(
      'SELECT state, dispute_id FROM payout_holds WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(holdRows).toEqual([{ state: 'held', dispute_id: dispute.body.id }]);
    expect(await getDisputeAuditCount(scenario.orderId)).toBe(1);

    await elapsePayoutWindows(scenario);
    await releasePayout(harness.adminId, scenario.orderId).expect(200);
    const { rows: orderRows } = await db.query(
      `SELECT o.status, hold.state AS hold_state
       FROM orders o JOIN payout_holds hold ON hold.order_id = o.id
       WHERE o.id = $1`,
      [scenario.orderId]
    );
    expect(orderRows).toEqual([{ status: 'completed', hold_state: 'released' }]);
  });

  test('FR-45, FR-72e: buyer resolution records one manual exception and moves no money', async () => {
    const dispute = await fileBuyerDispute();
    const before = await getMoneyState(scenario.orderId);

    await resolveDispute(harness.adminId, dispute.body.id, '1250.50').expect(200);
    expect(await getMoneyState(scenario.orderId)).toEqual(before);
    expect(await db.query('SELECT state FROM payout_holds WHERE order_id = $1', [scenario.orderId]))
      .toMatchObject({ rows: [{ state: 'paused_for_dispute' }] });
    expect(await releasePayout(harness.adminId, scenario.orderId).then((response) => response.status))
      .toBe(409);

    const exceptionRows = await getDisputeExceptionRows(scenario.orderId);
    expect(exceptionRows).toEqual([{
      kind: 'dispute_refund_required',
      courier_pickup_at: null,
      note: 'Dispute resolved in the buyer\'s favour; refund must be made manually',
      recorded_by: harness.adminId,
      resolved_at: null,
    }]);
    expect(await getDisputeAuditCount(scenario.orderId)).toBe(1);

    await resolveDispute(harness.adminId, dispute.body.id, '1250.50').expect(409);
    expect(await getDisputeExceptionRows(scenario.orderId)).toHaveLength(1);
    expect(await getDisputeAuditCount(scenario.orderId)).toBe(1);

    const exceptionList = await request(getApp())
      .get('/api/admin/order-exceptions?kind=dispute_refund_required')
      .set('Authorization', authHeader(harness.adminId))
      .expect(200);
    const listedException = exceptionList.body.find((exception) => exception.orderId === scenario.orderId);
    expect(listedException).toMatchObject({ kind: 'dispute_refund_required' });
    await request(getApp())
      .post(`/api/admin/order-exceptions/${listedException.id}/resolve`)
      .set('Authorization', authHeader(harness.adminId))
      .send({ resolutionNote: 'Manual refund completed outside the system.' })
      .expect(200);
  });

  test('FR-45: Moderator cannot resolve disputes but can still list them', async () => {
    const dispute = await fileBuyerDispute();

    await resolveDispute(harness.moderatorId, dispute.body.id, 0).expect(403);
    const response = await request(getApp())
      .get('/api/disputes')
      .set('Authorization', authHeader(harness.moderatorId))
      .expect(200);
    expect(response.body.some((row) => row.id === dispute.body.id)).toBe(true);
  });

  test('FR-45: a failing resolution listener rolls the dispute update back', async () => {
    const dispute = await fileBuyerDispute();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const failResolution = () => {
      throw new Error('forced dispute listener failure');
    };
    eventBus.once(events.DISPUTE_RESOLVED, failResolution);
    try {
      await resolveDispute(harness.adminId, dispute.body.id, 0).expect(500);
    } finally {
      eventBus.removeListener(events.DISPUTE_RESOLVED, failResolution);
      consoleError.mockRestore();
    }

    const { rows: disputeRows } = await db.query(
      'SELECT status FROM disputes WHERE id = $1',
      [dispute.body.id]
    );
    expect(disputeRows).toEqual([{ status: 'open' }]);
    expect(await getDisputeAuditCount(scenario.orderId)).toBe(0);
    expect(await getDisputeExceptionRows(scenario.orderId)).toEqual([]);
  });

  test('FR-45: ten parallel resolves produce exactly one success', async () => {
    const dispute = await fileBuyerDispute();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => resolveDispute(harness.adminId, dispute.body.id, 0))
    );

    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(9);
    expect(await getDisputeAuditCount(scenario.orderId)).toBe(1);
    const { rows } = await db.query(
      'SELECT status FROM disputes WHERE id = $1',
      [dispute.body.id]
    );
    expect(rows).toEqual([{ status: 'resolved_release' }]);
  });

  test('FR-45: legacy non-reservation dispute resolution leaves its payout hold unchanged', async () => {
    const legacyOrderId = await createLegacyOrder(harness, scenario);
    await db.query(
      `UPDATE orders SET status = 'delivered', delivered_at = now() WHERE id = $1`,
      [legacyOrderId]
    );
    await db.query(
      `INSERT INTO payout_holds (order_id, hold_started_at, state)
       VALUES ($1, now(), 'held')`,
      [legacyOrderId]
    );
    const dispute = await fileDispute(scenario.buyerId, legacyOrderId).expect(201);
    await global.drainIntegrationListeners(5000);

    await resolveDispute(harness.adminId, dispute.body.id, 0).expect(200);
    const { rows: holdRows } = await db.query(
      'SELECT state FROM payout_holds WHERE order_id = $1',
      [legacyOrderId]
    );
    expect(holdRows).toEqual([{ state: 'paused_for_dispute' }]);
    expect(await getDisputeAuditCount(legacyOrderId)).toBe(0);
    const { rows: exceptionRows } = await db.query(
      'SELECT id FROM order_exceptions WHERE order_id = $1',
      [legacyOrderId]
    );
    expect(exceptionRows).toEqual([]);
  });
});
