const {
  adminDeliveredRequest,
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

async function getMoneyState(orderId) {
  const { rows: orderRows } = await db.query(
    `SELECT status, agreed_item_price, delivery_fee, total_cod_amount
     FROM orders WHERE id = $1`,
    [orderId]
  );
  const { rows: reservationRows } = await db.query(
    `SELECT item_price_snapshot, delivery_fee_snapshot, total_amount_snapshot
     FROM reservations WHERE id = $1`,
    [scenario.reservationId]
  );
  const { rows: paymentRows } = await db.query(
    'SELECT status, amount, gateway_fee FROM payments WHERE id = $1',
    [scenario.paymentId]
  );
  const { rows: refundRows } = await db.query(
    'SELECT id, payment_id, trigger, amount, status FROM refunds WHERE order_id = $1 ORDER BY id',
    [orderId]
  );
  const { rows: ledgerRows } = await db.query(
    `SELECT id, payment_id, refund_id, amount, entry_type, idempotency_key
     FROM ledger_entries WHERE order_id = $1 ORDER BY id`,
    [orderId]
  );
  const { rows: auditRows } = await db.query(
    `SELECT id, action, actor_id, reason, metadata
     FROM money_audit_events WHERE order_id = $1 ORDER BY id`,
    [orderId]
  );
  const { rows: settlementRows } = await db.query(
    `SELECT order_id, commission_amount, seller_net_payout
     FROM settlements WHERE order_id = $1`,
    [orderId]
  );
  const { rows: codRows } = await db.query(
    `SELECT order_id, collected_amount, collection_method, remitted_to_platform
     FROM cod_collections WHERE order_id = $1`,
    [orderId]
  );
  return {
    order: orderRows[0],
    reservation: reservationRows[0],
    payment: paymentRows[0],
    refunds: refundRows,
    ledger: ledgerRows,
    audits: auditRows,
    settlements: settlementRows,
    codCollections: codRows,
  };
}

async function fileBuyerDispute() {
  const response = await fileDispute(scenario.buyerId, scenario.orderId).expect(201);
  await global.drainIntegrationListeners(5000);
  return response;
}

async function resetDisputeScenario() {
  await db.query(
    `DELETE FROM dispute_evidence
     WHERE dispute_id IN (SELECT id FROM disputes WHERE order_id = $1)`,
    [scenario.orderId]
  );
  await db.query(
    `UPDATE payout_holds
     SET state = 'held', dispute_id = NULL
     WHERE order_id = $1`,
    [scenario.orderId]
  );
  await db.query('DELETE FROM disputes WHERE order_id = $1', [scenario.orderId]);
}

beforeAll(async () => {
  harness = await createHarness();
});

beforeEach(async () => {
  scenario = await createScenario(harness);
  await resetDisputeScenario();
  await db.query(
    `UPDATE orders
     SET status = 'handed_to_delivery', handed_over_at = now()
     WHERE id = $1`,
    [scenario.orderId]
  );
  await adminDeliveredRequest(harness, scenario, { note: 'Delivered for dispute test' }).expect(200);
  const { rows } = await db.query(
    'SELECT state FROM payout_holds WHERE order_id = $1',
    [scenario.orderId]
  );
  expect(rows).toEqual([{ state: 'held' }]);
});

afterEach(async () => {
  await global.drainIntegrationListeners(5000);
  if (scenario) {
    await resetDisputeScenario();
    await cleanupScenario(harness, scenario);
  }
});

afterAll(async () => {
  await cleanupHarness(harness);
  restoreHandoverTestEnvironment();
});

describe('FR-43, FR-45g delivered reservation disputes', () => {
  test('FR-43, FR-45g: buyer dispute pauses the delivered order hold without moving money', async () => {
    const before = await getMoneyState(scenario.orderId);
    expect(before.order).toMatchObject({
      status: 'held',
      agreed_item_price: '1250.50',
    });
    expect(before.payment.status).toBe('succeeded');
    expect(before.refunds).toEqual([]);
    expect(before.ledger).toEqual([]);
    expect(before.settlements).toEqual([]);
    expect(before.codCollections).toEqual([]);

    const response = await fileBuyerDispute();
    expect(response.body).toMatchObject({
      order_id: scenario.orderId,
      raised_by: scenario.buyerId,
      status: 'open',
    });

    const { rows: holdRows } = await db.query(
      'SELECT state, dispute_id FROM payout_holds WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(holdRows).toEqual([{
      state: 'paused_for_dispute',
      dispute_id: response.body.id,
    }]);

    const after = await getMoneyState(scenario.orderId);
    expect(after).toEqual(before);
  });

  test('FR-45g: disputes pause holds across 10 fresh delivered scenarios', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let index = 0; index < 10; index += 1) {
        const freshScenario = await createScenario(harness);
        try {
          await db.query(
            `UPDATE orders
             SET status = 'handed_to_delivery', handed_over_at = now()
             WHERE id = $1`,
            [freshScenario.orderId]
          );
          await adminDeliveredRequest(harness, freshScenario, {
            note: `Delivered for dispute loop ${index + 1}`,
          }).expect(200);
          const response = await fileDispute(freshScenario.buyerId, freshScenario.orderId)
            .expect(201);
          await global.drainIntegrationListeners(5000);

          const { rows } = await db.query(
            'SELECT state, dispute_id FROM payout_holds WHERE order_id = $1',
            [freshScenario.orderId]
          );
          expect(rows).toEqual([{
            state: 'paused_for_dispute',
            dispute_id: response.body.id,
          }]);
        } finally {
          await db.query(
            `DELETE FROM dispute_evidence
             WHERE dispute_id IN (SELECT id FROM disputes WHERE order_id = $1)`,
            [freshScenario.orderId]
          );
          await db.query(
            `UPDATE payout_holds
             SET state = 'held', dispute_id = NULL
             WHERE order_id = $1`,
            [freshScenario.orderId]
          );
          await db.query('DELETE FROM disputes WHERE order_id = $1', [freshScenario.orderId]);
          await cleanupScenario(harness, freshScenario);
        }
      }

      expect(consoleError.mock.calls
        .filter(([message]) => String(message).includes('Failed to pause payout hold')))
        .toHaveLength(0);
    } finally {
      consoleError.mockRestore();
    }
  });

  test('FR-43: seller cannot file a dispute on a delivered reservation order', async () => {
    const response = await fileDispute(harness.fixture.userId, scenario.orderId);
    expect([403, 404]).toContain(response.status);
    const { rows } = await db.query('SELECT count(*)::int AS disputes FROM disputes WHERE order_id = $1', [
      scenario.orderId,
    ]);
    expect(rows[0].disputes).toBe(0);
  });

  test('FR-43: unrelated buyer cannot file a dispute on a delivered reservation order', async () => {
    const response = await fileDispute(harness.unrelatedBuyerId, scenario.orderId);
    expect([403, 404]).toContain(response.status);
    const { rows } = await db.query('SELECT count(*)::int AS disputes FROM disputes WHERE order_id = $1', [
      scenario.orderId,
    ]);
    expect(rows[0].disputes).toBe(0);
  });

  test('FR-43c: another seller cannot submit counter-evidence for this dispute', async () => {
    const dispute = await fileBuyerDispute();
    await db.query("UPDATE users SET role = 'seller' WHERE id = $1", [harness.unrelatedBuyerId]);
    try {
      const response = await request(getApp())
        .post(`/api/disputes/${dispute.body.id}/counter-evidence`)
        .set('Authorization', authHeader(harness.unrelatedBuyerId))
        .send({ responseText: 'This is not my order.', evidenceUrls: [] });
      expect(response.status).toBe(404);
    } finally {
      await db.query("UPDATE users SET role = 'buyer' WHERE id = $1", [harness.unrelatedBuyerId]);
    }
  });

  test('FR-43, FR-45g: a second dispute attempt keeps one paused payout hold and returns 409', async () => {
    const first = await fileBuyerDispute();
    const { rows: firstHoldRows } = await db.query(
      'SELECT state, dispute_id FROM payout_holds WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(firstHoldRows).toEqual([{
      state: 'paused_for_dispute',
      dispute_id: first.body.id,
    }]);

    await fileDispute(scenario.buyerId, scenario.orderId).expect(409);
    await global.drainIntegrationListeners(5000);

    const { rows: disputeRows } = await db.query(
      'SELECT id FROM disputes WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(disputeRows).toEqual([{ id: first.body.id }]);
    const { rows: finalHoldRows } = await db.query(
      'SELECT state, dispute_id FROM payout_holds WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(finalHoldRows).toEqual(firstHoldRows);
  });

  test('FR-43: 10 parallel buyer filings create one dispute and return one 201 with nine 409 responses', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => fileDispute(scenario.buyerId, scenario.orderId))
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(9);
    await global.drainIntegrationListeners(5000);

    const { rows: disputeRows } = await db.query(
      'SELECT id FROM disputes WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(disputeRows).toHaveLength(1);
    const { rows: holdRows } = await db.query(
      'SELECT state, dispute_id FROM payout_holds WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(holdRows).toEqual([{
      state: 'paused_for_dispute',
      dispute_id: disputeRows[0].id,
    }]);
  });
});
