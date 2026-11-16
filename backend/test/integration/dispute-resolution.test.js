const crypto = require('node:crypto');
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
const { signAccessToken } = require('../../src/lib/jwt');
const eventBus = require('../../src/lib/eventBus');
const events = require('../../src/lib/events');
const notificationService = require('../../src/modules/notifications.service');
const escrowPayments = require('../../src/modules/escrowPayments.service');
const payout = require('../../src/modules/payout.service');
const sellerPayouts = require('../../src/modules/sellerPayouts.service');
const { QUEUES } = require('../../src/lib/queue');

let harness;
let scenario;
let adminSessionId;

function fileDispute(actorId, orderId) {
  return request(getApp())
    .post(`/api/disputes/orders/${orderId}`)
    .set('Authorization', authHeader(actorId))
    .send({
      reasonText: 'The delivered item differs from the listing.',
      evidenceUrls: ['https://media.example.test/dispute-evidence.jpg'],
    });
}

function adminHeader() {
  return `Bearer ${signAccessToken(harness.adminId, {
    secret: 'delivery-handover-integration-secret',
    sessionId: adminSessionId,
  })}`;
}

async function createDecisionGrant() {
  const grant = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO step_up_grants (token_hash, user_id, session_id, action, expires_at)
     VALUES ($1, $2, $3, 'refund.decide', now() + INTERVAL '5 minutes')`,
    [
      crypto.createHash('sha256').update(grant).digest('hex'),
      harness.adminId,
      adminSessionId,
    ]
  );
  return grant;
}

async function decisionInput(outcome, amount, overrides = {}) {
  return {
    outcome,
    ...(amount === undefined ? {} : { amount }),
    reason: 'Decision recorded after reviewing the evidence.',
    sellerAtFault: false,
    stepUpGrant: await createDecisionGrant(),
    ...overrides,
  };
}

function resolveDispute(actorId, disputeId, input) {
  const authorization = actorId === harness.adminId ? adminHeader() : authHeader(actorId);
  return request(getApp())
    .post(`/api/disputes/${disputeId}/resolve`)
    .set('Authorization', authorization)
    .send(input);
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

async function insertInitiatedPayout() {
  const { rows } = await db.query(
    `INSERT INTO seller_payouts
       (order_id, seller_id, attempt, status, amount, currency, initiated_by)
     VALUES ($1, $2, 1, 'initiated', '100.00', 'PKR', $3)
     RETURNING id`,
    [scenario.orderId, scenario.sellerId, harness.adminId]
  );
  return rows[0].id;
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
     WHERE order_id = $1 AND action = 'dispute_outcome_decided'`,
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
  adminSessionId = crypto.randomUUID();
  await db.query(
    `INSERT INTO auth_sessions
       (id, family_id, user_id, refresh_token_hash, expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, now() + INTERVAL '1 hour', now() + INTERVAL '1 day')`,
    [
      adminSessionId,
      crypto.randomUUID(),
      harness.adminId,
      crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
    ]
  );
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

describe('FR-65 reservation-backed dispute-resolution payout outcomes', () => {
  test('FR-69: seller_favor records an outcome and releases the durable hold', async () => {
    const dispute = await fileBuyerDispute();
    expect(await db.query('SELECT state FROM payout_holds WHERE order_id = $1', [scenario.orderId]))
      .toMatchObject({ rows: [{ state: 'paused_for_dispute' }] });

    const response = await resolveDispute(
      harness.adminId,
      dispute.body.id,
      await decisionInput('seller_favor')
    ).expect(200);
    expect(response.body).toMatchObject({
      outcome: 'seller_favor',
      status: 'resolved_release',
      reason: 'Decision recorded after reviewing the evidence.',
    });
    expect(response.body.resolved_by).toBeUndefined();
    expect(response.body.decidedAt).toBeTruthy();
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

  test('FR-69: buyer_favor creates a capped item-only refund in the dispute transaction', async () => {
    const dispute = await fileBuyerDispute();
    const before = await getMoneyState(scenario.orderId);

    const response = await resolveDispute(
      harness.adminId,
      dispute.body.id,
      await decisionInput('buyer_favor', '1250.50')
    ).expect(200);
    expect(response.body).toMatchObject({
      outcome: 'buyer_favor',
      status: 'resolved_refund',
      refund: {
        amount: '1250.50',
        itemAmount: '1250.50',
        deliveryFeeAmount: '0.00',
        refundAfterPayout: false,
      },
    });
    expect(await getMoneyState(scenario.orderId)).toMatchObject({
      ...before,
      refunds: 1,
    });
    expect(await db.query('SELECT state FROM payout_holds WHERE order_id = $1', [scenario.orderId]))
      .toMatchObject({ rows: [{ state: 'held' }] });
    expect(await releasePayout(harness.adminId, scenario.orderId).then((response) => response.status))
      .toBe(409);

    const { rows: refunds } = await db.query(
      `SELECT trigger, status, amount::text, item_amount::text,
              delivery_fee_amount::text, decided_by
       FROM refunds WHERE order_id = $1`,
      [scenario.orderId]
    );
    expect(refunds).toEqual([{
      trigger: 'dispute_admin',
      status: 'approved',
      amount: '1250.50',
      item_amount: '1250.50',
      delivery_fee_amount: '0.00',
      decided_by: harness.adminId,
    }]);
    expect(await getDisputeAuditCount(scenario.orderId)).toBe(1);

    const buyerSummary = await request(getApp())
      .get(`/api/orders/${scenario.orderId}/summary`)
      .set('Authorization', authHeader(scenario.buyerId))
      .expect(200);
    expect(buyerSummary.body.disputeFiling).toMatchObject({
      outcome: 'buyer_favor',
      reason: 'Decision recorded after reviewing the evidence.',
      decidedAt: expect.any(String),
    });
    expect(buyerSummary.body.disputeFiling).not.toHaveProperty('resolvedBy');

    const sellerOrder = await request(getApp())
      .get(`/api/orders/selling/${scenario.orderId}`)
      .set('Authorization', authHeader(scenario.sellerId))
      .expect(200);
    expect(sellerOrder.body).toMatchObject({
      disputeOutcome: 'buyer_favor',
      disputeReason: 'Decision recorded after reviewing the evidence.',
      disputeDecidedAt: expect.any(String),
    });
    expect(sellerOrder.body).not.toHaveProperty('resolvedBy');

    await resolveDispute(
      harness.adminId,
      dispute.body.id,
      await decisionInput('buyer_favor', '1250.50')
    ).expect(409);
    expect(await getDisputeAuditCount(scenario.orderId)).toBe(1);
  });

  test.each(['buyer_favor', 'split'])(
    'FR-69: %s uses the Phase A remaining-refundable cap',
    async (outcome) => {
      const dispute = await fileBuyerDispute();
      await db.query(
        `INSERT INTO refunds
           (payment_id, order_id, trigger, amount, currency, status, idempotency_key, reason)
         VALUES ($1, $2, 'system_cancel', '300.00', 'PKR', 'succeeded', $3, 'Earlier partial refund')`,
        [scenario.paymentId, scenario.orderId, `dispute-cap:${crypto.randomUUID()}`]
      );
      const before = await getMoneyState(scenario.orderId);

      await resolveDispute(
        harness.adminId,
        dispute.body.id,
        await decisionInput(outcome, '1250.51')
      ).expect(409);

      const { rows } = await db.query('SELECT status FROM disputes WHERE id = $1', [dispute.body.id]);
      expect(rows).toEqual([{ status: 'open' }]);
      expect(await getMoneyState(scenario.orderId)).toEqual(before);
    }
  );

  test('FR-45a, FR-69: split creates an exact partial refund and exposes the decision without Admin identity', async () => {
    const dispute = await fileBuyerDispute();
    const response = await resolveDispute(
      harness.adminId,
      dispute.body.id,
      await decisionInput('split', '100.05')
    ).expect(200);
    expect(response.body).toMatchObject({
      outcome: 'split',
      status: 'resolved_other',
      resolutionAmountToBuyer: '100.05',
      refund: {
        amount: '100.05',
        itemAmount: '100.05',
        deliveryFeeAmount: '0.00',
      },
    });
    expect(response.body.resolved_by).toBeUndefined();

    const queue = await request(getApp())
      .get('/api/disputes')
      .set('Authorization', adminHeader())
      .expect(200);
    expect(queue.body.find((row) => row.id === dispute.body.id)).toMatchObject({
      outcome: 'split',
      reason: 'Decision recorded after reviewing the evidence.',
      decidedAt: expect.any(String),
    });
    expect(JSON.stringify(queue.body)).not.toContain(harness.adminId);

    await global.drainIntegrationListeners(5000);
    const { rows: jobs } = await db.query(
      `SELECT data FROM pgboss.job
       WHERE name = $1 AND data->>'eventName' = $2
         AND data->'payload'->>'orderId' = $3`,
      [QUEUES.NOTIFICATIONS, events.DISPUTE_RESOLUTION_COMMITTED, scenario.orderId]
    );
    expect(jobs).toHaveLength(1);
    expect(JSON.stringify(jobs[0].data)).not.toContain(harness.adminId);
    const transactionDb = {
      executeSql: (text, values = []) => transactionDb.client.query(text, values),
    };
    await db.withTransaction(async (client) => {
      transactionDb.client = client;
      await notificationService.processNotificationJob(jobs[0].data, transactionDb);
    });
    const { rows: notificationRows } = await db.query(
      `SELECT user_id, event_type, payload
       FROM notifications
       WHERE user_id = ANY($1::uuid[]) AND event_type = 'dispute_resolved'`,
      [[scenario.buyerId, scenario.sellerId]]
    );
    expect(notificationRows.map((row) => row.user_id).sort()).toEqual(
      [scenario.buyerId, scenario.sellerId].sort()
    );
    expect(JSON.stringify(notificationRows)).not.toContain(harness.adminId);
  });

  test('FR-69: missing step-up is forbidden and a Moderator cannot decide', async () => {
    const dispute = await fileBuyerDispute();
    const body = {
      outcome: 'seller_favor',
      reason: 'Decision recorded after reviewing the evidence.',
    };
    await request(getApp())
      .post(`/api/disputes/${dispute.body.id}/resolve`)
      .set('Authorization', adminHeader())
      .send(body)
      .expect(403);
    await resolveDispute(harness.moderatorId, dispute.body.id, body).expect(403);
    expect(await db.query('SELECT status FROM disputes WHERE id = $1', [dispute.body.id]))
      .toMatchObject({ rows: [{ status: 'open' }] });
  });

  test('FR-43: Moderator cannot resolve disputes but can still list them', async () => {
    const dispute = await fileBuyerDispute();

    await resolveDispute(harness.moderatorId, dispute.body.id, {}).expect(403);
    const response = await request(getApp())
      .get('/api/disputes')
      .set('Authorization', authHeader(harness.moderatorId))
      .expect(200);
    expect(response.body.some((row) => row.id === dispute.body.id)).toBe(true);
  });

  test('FR-43: a failing resolution listener rolls the dispute update back', async () => {
    const dispute = await fileBuyerDispute();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const failResolution = () => {
      throw new Error('forced dispute listener failure');
    };
    eventBus.once(events.DISPUTE_RESOLVED, failResolution);
    try {
      await resolveDispute(
        harness.adminId,
        dispute.body.id,
        await decisionInput('seller_favor')
      ).expect(500);
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

  test('FR-69: refund-step failure rolls back the dispute update and step-up consumption', async () => {
    const dispute = await fileBuyerDispute();
    const grant = await createDecisionGrant();
    const createRefund = jest.spyOn(escrowPayments, 'createDisputeRefund')
      .mockRejectedValueOnce(new Error('forced dispute refund failure'));
    try {
      await resolveDispute(harness.adminId, dispute.body.id, {
        outcome: 'buyer_favor',
        amount: '100.00',
        reason: 'Buyer refund approved after review.',
        stepUpGrant: grant,
      }).expect(500);
    } finally {
      createRefund.mockRestore();
    }
    const { rows: disputeRows } = await db.query(
      'SELECT status FROM disputes WHERE id = $1',
      [dispute.body.id]
    );
    expect(disputeRows).toEqual([{ status: 'open' }]);
    const digest = crypto.createHash('sha256').update(grant).digest('hex');
    const { rows: grants } = await db.query(
      'SELECT consumed_at FROM step_up_grants WHERE token_hash = $1',
      [digest]
    );
    expect(grants[0].consumed_at).toBeNull();
  });

  test('FR-69: durable dispute hold blocks payout creation, approval and payment until decision', async () => {
    const payoutId = await insertInitiatedPayout();
    const dispute = await fileBuyerDispute();
    const payoutResponse = await request(getApp())
      .get(`/api/admin/seller-payouts/${payoutId}`)
      .set('Authorization', adminHeader())
      .expect(200);
    expect(payoutResponse.body.disputeHold).toBe(true);
    const heldList = await request(getApp())
      .get('/api/admin/seller-payouts')
      .set('Authorization', adminHeader())
      .expect(200);
    expect(heldList.body.payouts.find((payout) => payout.id === payoutId).disputeHold).toBe(true);

    await expect(db.withTransaction((client) => sellerPayouts.createInitiatedPayout(client, {
      orderId: scenario.orderId,
      sellerId: scenario.sellerId,
      amount: '100.00',
      currency: 'PKR',
      initiatedBy: harness.adminId,
    }, payout.getDisputePayoutGuards()))).rejects.toThrow(/unresolved dispute hold/i);

    await request(getApp())
      .post(`/api/admin/seller-payouts/${payoutId}/approve`)
      .set('Authorization', adminHeader())
      .send({ stepUpGrant: 'unused-grant' })
      .expect(409)
      .expect(({ body }) => expect(body.error).toMatch(/unresolved dispute hold/i));
    await request(getApp())
      .post(`/api/admin/seller-payouts/${payoutId}/paid`)
      .set('Authorization', adminHeader())
      .send({
        method: 'bank',
        transferReference: 'DISPUTE-HOLD-BLOCK',
        paidOn: new Date().toISOString().slice(0, 10),
        stepUpGrant: 'unused-grant',
      })
      .expect(409)
      .expect(({ body }) => expect(body.error).toMatch(/unresolved dispute hold/i));

    await resolveDispute(
      harness.adminId,
      dispute.body.id,
      await decisionInput('seller_favor')
    ).expect(200);
    const cleared = await request(getApp())
      .get(`/api/admin/seller-payouts/${payoutId}`)
      .set('Authorization', adminHeader())
      .expect(200);
    expect(cleared.body.disputeHold).toBe(false);
    const list = await request(getApp())
      .get('/api/admin/seller-payouts')
      .set('Authorization', adminHeader())
      .expect(200);
    expect(list.body.payouts.find((payout) => payout.id === payoutId).disputeHold).toBe(false);
  });

  test('FR-69: dispute hold survives reloading the seller-payout service module', async () => {
    await fileBuyerDispute();
    const modulePath = require.resolve('../../src/modules/sellerPayouts.service');
    delete require.cache[modulePath];
    const reloadedSellerPayouts = require(modulePath);
    await expect(db.withTransaction((client) => reloadedSellerPayouts.createInitiatedPayout(client, {
      orderId: scenario.orderId,
      sellerId: scenario.sellerId,
      amount: '100.00',
      currency: 'PKR',
      initiatedBy: harness.adminId,
    }, payout.getDisputePayoutGuards()))).rejects.toThrow(/unresolved dispute hold/i);
    expect(await db.query('SELECT state FROM payout_holds WHERE order_id = $1', [scenario.orderId]))
      .toMatchObject({ rows: [{ state: 'paused_for_dispute' }] });
  });

  test('FR-69: disputes filed after a paid payout are audited without changing money', async () => {
    await db.query(
      `UPDATE orders SET status = 'completed', completed_at = now() WHERE id = $1`,
      [scenario.orderId]
    );
    await db.query(
      `UPDATE payout_holds SET state = 'released', released_at = now() WHERE order_id = $1`,
      [scenario.orderId]
    );
    await db.query(
      `INSERT INTO seller_payouts
         (order_id, seller_id, attempt, status, amount, currency, initiated_by,
          method, transfer_reference, paid_on, paid_by, paid_at)
       VALUES ($1, $2, 1, 'paid', '100.00', 'PKR', $3,
               'bank', 'DISPUTE-AFTER-PAYOUT', CURRENT_DATE, $3, now())`,
      [scenario.orderId, scenario.sellerId, harness.adminId]
    );
    await db.query(
      `INSERT INTO ledger_entries
         (order_id, payment_id, currency, amount, entry_type, idempotency_key)
       VALUES ($1, $2, 'PKR', '-100.00', 'seller_payout_manual', $3)`,
      [scenario.orderId, scenario.paymentId, `seller_payout_manual:${scenario.orderId}`]
    );
    const before = await getMoneyState(scenario.orderId);
    const buyerSummary = await request(getApp())
      .get(`/api/orders/${scenario.orderId}/summary`)
      .set('Authorization', authHeader(scenario.buyerId))
      .expect(200);
    expect(buyerSummary.body.disputeFiling.canFileDispute).toBe(true);
    expect(buyerSummary.body.disputeFiling).not.toHaveProperty('resolvedBy');
    const dispute = await fileBuyerDispute();
    expect(dispute.body.dispute_after_payout).toBe(true);
    expect(await getMoneyState(scenario.orderId)).toEqual(before);
    const queue = await request(getApp())
      .get('/api/disputes')
      .set('Authorization', adminHeader())
      .expect(200);
    expect(queue.body.find((row) => row.id === dispute.body.id).disputeAfterPayout).toBe(true);
    const adminOrder = await request(getApp())
      .get(`/api/admin/orders/${scenario.orderId}`)
      .set('Authorization', adminHeader())
      .expect(200);
    expect(adminOrder.body.disputes.find((row) => row.id === dispute.body.id))
      .toMatchObject({ disputeAfterPayout: true, outcome: null, reason: null, decidedAt: null });
    const { rows: auditRows } = await db.query(
      `SELECT action, actor_id, metadata
       FROM money_audit_events
       WHERE order_id = $1 AND action = 'dispute_after_payout'`,
      [scenario.orderId]
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actor_id: scenario.buyerId,
      metadata: { disputeId: dispute.body.id },
    });
  });

  test('FR-69: ten parallel resolutions produce exactly one success', async () => {
    const dispute = await fileBuyerDispute();
    const inputs = await Promise.all(Array.from({ length: 10 }, () => decisionInput('seller_favor')));
    const responses = await Promise.all(
      inputs.map((input) => resolveDispute(harness.adminId, dispute.body.id, input))
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

  test('FR-69: legacy dispute decisions release an existing durable hold', async () => {
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

    await resolveDispute(
      harness.adminId,
      dispute.body.id,
      await decisionInput('seller_favor')
    ).expect(200);
    const { rows: holdRows } = await db.query(
      'SELECT state FROM payout_holds WHERE order_id = $1',
      [legacyOrderId]
    );
    expect(holdRows).toEqual([{ state: 'held' }]);
    expect(await getDisputeAuditCount(legacyOrderId)).toBe(1);
    const { rows: exceptionRows } = await db.query(
      'SELECT id FROM order_exceptions WHERE order_id = $1',
      [legacyOrderId]
    );
    expect(exceptionRows).toEqual([]);
  });
});
