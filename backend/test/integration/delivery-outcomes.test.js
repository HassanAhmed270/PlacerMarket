const crypto = require('node:crypto');
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
const { signAccessToken } = require('../../src/lib/jwt');
const events = require('../../src/lib/events');
const notifications = require('../../src/modules/notifications.service');
const queue = require('../../src/lib/queue');
const JWT_SECRET = 'delivery-handover-integration-secret';

let harness;
let scenario;
let stepUpGrantHashes = [];
let sessionIds = [];

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

function markDeliveryLost(target, actorId, sessionId, reason, stepUpGrant) {
  return request(getApp())
    .post(`/api/admin/orders/${target.orderId}/lost-delivery`)
    .set('Authorization', `Bearer ${signAccessToken(actorId, { secret: JWT_SECRET, sessionId })}`)
    .send({ reason, ...(stepUpGrant ? { stepUpGrant } : {}) });
}

async function createAdminSession(adminId) {
  const sessionId = crypto.randomUUID();
  sessionIds.push(sessionId);
  await db.query(
    `INSERT INTO auth_sessions (id, family_id, user_id, refresh_token_hash, expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 hour', now() + interval '1 day')`,
    [
      sessionId,
      crypto.randomUUID(),
      adminId,
      crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
    ]
  );
  return sessionId;
}

async function insertStepUpGrant(userId, sessionId, action = 'refund.decide') {
  const grant = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(grant).digest('hex');
  stepUpGrantHashes.push(tokenHash);
  await db.query(
    `INSERT INTO step_up_grants (token_hash, user_id, session_id, action, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '5 minutes')`,
    [tokenHash, userId, sessionId, action]
  );
  return grant;
}

async function createInitiatedPayout(target) {
  const { rows } = await db.query(
    `INSERT INTO seller_payouts
       (order_id, seller_id, attempt, status, amount, currency, initiated_by)
     VALUES ($1, $2, 1, 'initiated', '5.00', 'PKR', $3)
     RETURNING id`,
    [target.orderId, target.sellerId, harness.adminId]
  );
  return rows[0].id;
}

async function createPaidPayout(target) {
  const { rows } = await db.query(
    `INSERT INTO seller_payouts
       (order_id, seller_id, attempt, status, amount, currency, initiated_by,
        method, transfer_reference, paid_on, paid_by, paid_at)
     VALUES ($1, $2, 1, 'paid', '5.00', 'PKR', $3,
             'bank', 'LOST-TEST-TRANSFER', DATE '2024-01-01', $3, now())
     RETURNING id`,
    [target.orderId, target.sellerId, harness.adminId]
  );
  await db.query(
    `INSERT INTO ledger_entries
       (order_id, payment_id, currency, amount, entry_type, idempotency_key)
     VALUES ($1, $2, 'PKR', '-5.00', 'seller_payout_manual', $3)`,
    [target.orderId, target.paymentId, `seller_payout_manual:${target.orderId}`]
  );
  return rows[0].id;
}

async function getRefundAmounts(target) {
  const { rows } = await db.query(
    `SELECT p.amount::text AS amount,
            r.item_price_snapshot::text AS item_amount,
            r.delivery_fee_snapshot::text AS delivery_fee
     FROM payments p
     JOIN reservations r ON r.id = $2
     WHERE p.id = $1`,
    [target.paymentId, target.reservationId]
  );
  return rows[0];
}

function minorUnits(amount) {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
}

async function processLostDeliveryNotifications(target) {
  await global.drainIntegrationListeners(5000);
  const { rows: jobs } = await db.query(
    `SELECT data FROM pgboss.job
     WHERE name = $1 AND data->>'eventName' = $2
       AND data->'payload'->>'orderId' = $3
       AND data->'payload'->>'status' = 'delivery_lost'`,
    [queue.QUEUES.NOTIFICATIONS, events.DELIVERY_STATUS_CHANGED, target.orderId]
  );
  expect(jobs).toHaveLength(1);
  const transactionDb = {
    executeSql: (text, values = []) => transactionDb.client.query(text, values),
  };
  await db.withTransaction(async (client) => {
    transactionDb.client = client;
    await notifications.processNotificationJob(jobs[0].data, transactionDb);
  });
  const { rows } = await db.query(
    `SELECT user_id, payload FROM notifications
     WHERE user_id = ANY($1::uuid[]) AND event_type = 'delivery_update'
       AND payload->>'orderId' = $2 AND payload->>'status' = 'delivery_lost'
     ORDER BY user_id`,
    [[target.buyerId, target.sellerId], target.orderId]
  );
  expect(rows.map((row) => row.user_id).sort()).toEqual([target.buyerId, target.sellerId].sort());
  expect(rows.every((row) => !JSON.stringify(row.payload).includes(harness.adminId))).toBe(true);
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
  if (stepUpGrantHashes.length) {
    await db.query('DELETE FROM step_up_grants WHERE token_hash = ANY($1::text[])', [stepUpGrantHashes]);
  }
  if (sessionIds.length) {
    await db.query('DELETE FROM auth_sessions WHERE id = ANY($1::uuid[])', [sessionIds]);
  }
  stepUpGrantHashes = [];
  sessionIds = [];
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
    const sellerOutcome = await request(getApp())
      .get(`/api/orders/selling/${scenario.orderId}`)
      .set('Authorization', authHeader(scenario.sellerId))
      .expect(200);
    expect(sellerOutcome.body.deliveryOutcome).toEqual({
      outcome: 'refused',
      recordedAt: expect.any(String),
    });
    expect(Object.keys(sellerOutcome.body.deliveryOutcome).sort()).toEqual(['outcome', 'recordedAt']);
    expect(sellerOutcome.body.deliveryOutcome).not.toHaveProperty('note');
    expect(sellerOutcome.body.deliveryOutcome).not.toHaveProperty('recordedBy');

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

describe('Admin lost-parcel handling', () => {
  test('FR-33b: marking a parcel lost fails an initiated payout and approves the exact full refund', async () => {
    const sessionId = await createAdminSession(harness.adminId);
    const stepUpGrant = await insertStepUpGrant(harness.adminId, sessionId);
    const payoutId = await createInitiatedPayout(scenario);
    const amounts = await getRefundAmounts(scenario);

    const response = await markDeliveryLost(
      scenario,
      harness.adminId,
      sessionId,
      'Carrier confirmed the parcel is lost.',
      stepUpGrant
    ).expect(201);
    expect(response.body).toMatchObject({
      orderId: scenario.orderId,
      outcome: 'lost',
      recordedBy: harness.adminId,
      note: 'Carrier confirmed the parcel is lost.',
      lostAfterPayout: false,
      failedPayoutIds: [payoutId],
      refund: {
        amount: amounts.amount,
        itemAmount: amounts.item_amount,
        deliveryFeeAmount: amounts.delivery_fee,
        sellerAtFault: false,
      },
    });
    for (const [userId, path] of [
      [scenario.sellerId, `/api/orders/selling/${scenario.orderId}`],
      [scenario.buyerId, `/api/orders/${scenario.orderId}/summary`],
    ]) {
      const ownerRead = await request(getApp())
        .get(path)
        .set('Authorization', authHeader(userId))
        .expect(200);
      const deliveryOutcome = ownerRead.body.deliveryOutcome;
      expect(deliveryOutcome).toEqual({
        outcome: 'lost',
        recordedAt: expect.any(String),
      });
      expect(Object.keys(deliveryOutcome).sort()).toEqual(['outcome', 'recordedAt']);
      expect(deliveryOutcome).not.toHaveProperty('note');
      expect(deliveryOutcome).not.toHaveProperty('recordedBy');
    }
    expect(minorUnits(response.body.refund.amount)).toBe(
      minorUnits(response.body.refund.itemAmount) +
      minorUnits(response.body.refund.deliveryFeeAmount)
    );

    const { rows: payoutRows } = await db.query(
      `SELECT status, failure_reason, failed_by
       FROM seller_payouts WHERE id = $1`,
      [payoutId]
    );
    expect(payoutRows).toEqual([{
      status: 'failed',
      failure_reason: 'delivery_lost',
      failed_by: harness.adminId,
    }]);
    const { rows: refundRows } = await db.query(
      `SELECT trigger, status, amount::text AS amount, item_amount::text AS item_amount,
              delivery_fee_amount::text AS delivery_fee_amount, seller_at_fault
       FROM refunds WHERE order_id = $1`,
      [scenario.orderId]
    );
    expect(refundRows).toEqual([{
      trigger: 'delivery_lost',
      status: 'approved',
      amount: amounts.amount,
      item_amount: amounts.item_amount,
      delivery_fee_amount: amounts.delivery_fee,
      seller_at_fault: false,
    }]);
    const { rows: auditRows } = await db.query(
      `SELECT action FROM money_audit_events
       WHERE order_id = $1
         AND action IN (
           'delivery_lost_recorded',
           'delivery_lost_refund_approved',
           'seller_payout_failed_by_lost_delivery'
         )
       ORDER BY action`,
      [scenario.orderId]
    );
    expect(auditRows.map((row) => row.action)).toEqual([
      'delivery_lost_recorded',
      'delivery_lost_refund_approved',
      'seller_payout_failed_by_lost_delivery',
    ]);

    const adminOrder = await request(getApp())
      .get(`/api/admin/orders/${scenario.orderId}`)
      .set('Authorization', authHeader(harness.adminId))
      .expect(200);
    expect(adminOrder.body.deliveryOutcomes).toEqual([expect.objectContaining({
      outcome: 'lost',
      lostAfterPayout: false,
    })]);
    await processLostDeliveryNotifications(scenario);
  });

  test('FR-33b: a paid payout is untouched and Admin detail surfaces lost-after-payout without clawback', async () => {
    const sessionId = await createAdminSession(harness.adminId);
    const stepUpGrant = await insertStepUpGrant(harness.adminId, sessionId);
    const payoutId = await createPaidPayout(scenario);

    const response = await markDeliveryLost(
      scenario,
      harness.adminId,
      sessionId,
      'Carrier confirmed the parcel is lost.',
      stepUpGrant
    ).expect(201);
    expect(response.body.lostAfterPayout).toBe(true);
    expect(response.body.failedPayoutIds).toEqual([]);

    const { rows: payoutRows } = await db.query(
      `SELECT status, amount::text AS amount, failure_reason, transfer_reference, paid_on::text AS paid_on
       FROM seller_payouts WHERE id = $1`,
      [payoutId]
    );
    expect(payoutRows).toEqual([{
      status: 'paid',
      amount: '5.00',
      failure_reason: null,
      transfer_reference: 'LOST-TEST-TRANSFER',
      paid_on: '2024-01-01',
    }]);
    const { rows: ledgerRows } = await db.query(
      `SELECT entry_type, amount::text AS amount
       FROM ledger_entries WHERE order_id = $1`,
      [scenario.orderId]
    );
    expect(ledgerRows).toEqual([{ entry_type: 'seller_payout_manual', amount: '-5.00' }]);
    const { rows: auditRows } = await db.query(
      `SELECT action FROM money_audit_events
       WHERE order_id = $1 AND action = 'lost_after_payout'`,
      [scenario.orderId]
    );
    expect(auditRows).toEqual([{ action: 'lost_after_payout' }]);

    const adminOrder = await request(getApp())
      .get(`/api/admin/orders/${scenario.orderId}`)
      .set('Authorization', authHeader(harness.adminId))
      .expect(200);
    expect(adminOrder.body.deliveryOutcomes[0].lostAfterPayout).toBe(true);
    await request(getApp())
      .post(`/api/admin/orders/${scenario.orderId}/delivered`)
      .set('Authorization', authHeader(harness.adminId))
      .send({ note: 'Delivery confirmation after a lost report.' })
      .expect(409);
  });

  test('FR-33b: refund enqueue failure rolls back the lost record, payout failure, audit, and step-up consumption', async () => {
    const sessionId = await createAdminSession(harness.adminId);
    const stepUpGrant = await insertStepUpGrant(harness.adminId, sessionId);
    const payoutId = await createInitiatedPayout(scenario);
    const enqueueSpy = jest.spyOn(queue, 'enqueue').mockRejectedValue(
      new Error('synthetic delivery-lost refund enqueue failure')
    );
    try {
      await markDeliveryLost(
        scenario,
        harness.adminId,
        sessionId,
        'Carrier confirmed the parcel is lost.',
        stepUpGrant
      ).expect(500);
    } finally {
      enqueueSpy.mockRestore();
    }

    const { rows } = await db.query(
      `SELECT
         (SELECT count(*)::int FROM delivery_outcomes WHERE order_id = $1) AS outcome_count,
         (SELECT count(*)::int FROM refunds WHERE order_id = $1) AS refund_count,
         (SELECT status FROM seller_payouts WHERE id = $2) AS payout_status,
         (SELECT consumed_at FROM step_up_grants WHERE token_hash = $3) AS grant_consumed_at,
         (SELECT count(*)::int FROM money_audit_events
          WHERE order_id = $1 AND action IN (
            'delivery_lost_recorded',
            'delivery_lost_refund_approved',
            'seller_payout_failed_by_lost_delivery'
          )) AS audit_count`,
      [
        scenario.orderId,
        payoutId,
        crypto.createHash('sha256').update(stepUpGrant).digest('hex'),
      ]
    );
    expect(rows[0]).toEqual({
      outcome_count: 0,
      refund_count: 0,
      payout_status: 'initiated',
      grant_consumed_at: null,
      audit_count: 0,
    });
  });

  test('FR-33b: Moderator is denied, a missing step-up grant is denied, and a second lost call returns 409', async () => {
    const sessionId = await createAdminSession(harness.adminId);
    const stepUpGrant = await insertStepUpGrant(harness.adminId, sessionId);
    await request(getApp())
      .post(`/api/admin/orders/${scenario.orderId}/lost-delivery`)
      .set('Authorization', authHeader(harness.moderatorId))
      .send({ reason: 'Carrier confirmed the parcel is lost.', stepUpGrant })
      .expect(403);
    await markDeliveryLost(
      scenario,
      harness.adminId,
      sessionId,
      'ab',
      stepUpGrant
    ).expect(400);
    await markDeliveryLost(
      scenario,
      harness.adminId,
      sessionId,
      'Carrier confirmed the parcel is lost.'
    ).expect(403);
    await markDeliveryLost(
      scenario,
      harness.adminId,
      sessionId,
      'Carrier confirmed the parcel is lost.',
      stepUpGrant
    ).expect(201);
    await markDeliveryLost(
      scenario,
      harness.adminId,
      sessionId,
      'Carrier confirmed the parcel is lost.',
      stepUpGrant
    ).expect(409);
  });

  test('FR-33b: a fully refunded order cannot be marked lost', async () => {
    const sessionId = await createAdminSession(harness.adminId);
    const stepUpGrant = await insertStepUpGrant(harness.adminId, sessionId);
    const amounts = await getRefundAmounts(scenario);
    await db.query(
      `INSERT INTO refunds
         (payment_id, order_id, trigger, amount, currency, status, idempotency_key,
          item_amount, delivery_fee_amount)
       VALUES ($1, $2, 'system_cancel', $3::numeric, 'PKR', 'succeeded', $4, $5::numeric, $6::numeric)`,
      [
        scenario.paymentId,
        scenario.orderId,
        amounts.amount,
        `test-full-refund:${scenario.orderId}`,
        amounts.item_amount,
        amounts.delivery_fee,
      ]
    );
    await db.query("UPDATE payments SET status = 'refunded' WHERE id = $1", [scenario.paymentId]);

    await markDeliveryLost(
      scenario,
      harness.adminId,
      sessionId,
      'Carrier confirmed the parcel is lost.',
      stepUpGrant
    ).expect(409);
    const { rows } = await db.query(
      `SELECT
         (SELECT count(*)::int FROM delivery_outcomes WHERE order_id = $1) AS outcomes,
         (SELECT consumed_at FROM step_up_grants WHERE token_hash = $2) AS grant_consumed_at`,
      [scenario.orderId, crypto.createHash('sha256').update(stepUpGrant).digest('hex')]
    );
    expect(rows[0]).toEqual({ outcomes: 0, grant_consumed_at: null });
  });

  test('FR-33b: lost delivery is refused with 409 while a dispute is open', async () => {
    const sessionId = await createAdminSession(harness.adminId);
    const stepUpGrant = await insertStepUpGrant(harness.adminId, sessionId);
    await db.query(
      `INSERT INTO disputes (order_id, raised_by, reason_text, status)
       VALUES ($1, $2, 'The buyer reported a delivery problem.', 'open')`,
      [scenario.orderId, scenario.buyerId]
    );

    await markDeliveryLost(
      scenario,
      harness.adminId,
      sessionId,
      'Carrier confirmed the parcel is lost.',
      stepUpGrant
    ).expect(409);
    const { rows } = await db.query(
      `SELECT (SELECT count(*)::int FROM delivery_outcomes WHERE order_id = $1) AS outcome_count,
              (SELECT consumed_at FROM step_up_grants WHERE token_hash = $2) AS grant_consumed_at`,
      [scenario.orderId, crypto.createHash('sha256').update(stepUpGrant).digest('hex')]
    );
    expect(rows[0]).toEqual({ outcome_count: 0, grant_consumed_at: null });
  });

  test('FR-33b: concurrent lost-delivery calls produce exactly one winner', async () => {
    const sessionId = await createAdminSession(harness.adminId);
    const stepUpGrant = await insertStepUpGrant(harness.adminId, sessionId);
    const responses = await Promise.all([
      markDeliveryLost(
        scenario,
        harness.adminId,
        sessionId,
        'Carrier confirmed the parcel is lost.',
        stepUpGrant
      ),
      markDeliveryLost(
        scenario,
        harness.adminId,
        sessionId,
        'Carrier confirmed the parcel is lost.',
        stepUpGrant
      ),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const { rows } = await db.query(
      `SELECT
         (SELECT count(*)::int FROM delivery_outcomes WHERE order_id = $1 AND outcome = 'lost') AS outcomes,
         (SELECT count(*)::int FROM refunds WHERE order_id = $1 AND trigger = 'delivery_lost') AS refunds`,
      [scenario.orderId]
    );
    expect(rows[0]).toEqual({ outcomes: 1, refunds: 1 });
  });
});
