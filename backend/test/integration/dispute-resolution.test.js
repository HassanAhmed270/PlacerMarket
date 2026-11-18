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
  getBusinessDate,
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
const disputes = require('../../src/modules/disputes.service');
const { QUEUES } = require('../../src/lib/queue');

let harness;
let scenario;
let adminSessionId;
let businessDate;
let extraScenarios;

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

async function createDecisionGrant(action = 'refund.decide') {
  const grant = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO step_up_grants (token_hash, user_id, session_id, action, expires_at)
     VALUES ($1, $2, $3, $4, now() + INTERVAL '5 minutes')`,
    [
      crypto.createHash('sha256').update(grant).digest('hex'),
      harness.adminId,
      adminSessionId,
      action,
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

function addDisputeEvidence(actorId, disputeId, input) {
  return request(getApp())
    .post(`/api/disputes/${disputeId}/evidence`)
    .set('Authorization', authHeader(actorId))
    .send(input);
}

function readPartyDisputeEvidence(actorId, disputeId) {
  return request(getApp())
    .get(`/api/disputes/${disputeId}/party-evidence`)
    .set('Authorization', authHeader(actorId));
}

function withdrawDispute(actorId, disputeId) {
  return request(getApp())
    .post(`/api/disputes/${disputeId}/withdraw`)
    .set('Authorization', authHeader(actorId));
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

async function insertInitiatedPayout({
  initiatedBy = harness.adminId,
  amount = '100.00',
} = {}) {
  const { rows } = await db.query(
    `INSERT INTO seller_payouts
       (order_id, seller_id, attempt, status, amount, currency, initiated_by)
     VALUES ($1, $2, 1, 'initiated', $3::numeric, 'PKR', $4)
     RETURNING id`,
    [scenario.orderId, scenario.sellerId, amount, initiatedBy]
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

async function withDisputeSlaDays(value, callback) {
  const { rows } = await db.query(
    `SELECT value, updated_by, updated_at
     FROM platform_settings WHERE key = 'dispute_sla_business_days'`
  );
  if (!rows[0]) throw new Error('dispute_sla_business_days setting is missing.');
  const original = rows[0];
  try {
    await db.query(
      `UPDATE platform_settings
       SET value = $1, updated_by = NULL, updated_at = now()
       WHERE key = 'dispute_sla_business_days'`,
      [value]
    );
    return await callback();
  } finally {
    await db.query(
      `UPDATE platform_settings
       SET value = $1, updated_by = $2, updated_at = $3
       WHERE key = 'dispute_sla_business_days'`,
      [original.value, original.updated_by, original.updated_at]
    );
  }
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
  businessDate = await getBusinessDate();
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
  extraScenarios = [];
  scenario = await createScenario(harness);
  await deliverScenario(scenario);
});

afterEach(async () => {
  await global.drainIntegrationListeners(5000);
  if (scenario) {
    await resetDisputeScenario(scenario.orderId);
    await cleanupScenario(harness, scenario);
  }
  for (const extraScenario of extraScenarios) {
    await resetDisputeScenario(extraScenario.orderId);
    await cleanupScenario(harness, extraScenario);
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

  test('FR-69: seller_favor clears the hold and allows an initiated payout to be approved and paid', async () => {
    const { rows: thresholdRows } = await db.query(
      'SELECT value FROM platform_settings WHERE key = $1',
      ['payout_two_admin_threshold']
    );
    const { rows: roleRows } = await db.query(
      'SELECT role FROM users WHERE id = $1',
      [harness.moderatorId]
    );
    const originalThreshold = thresholdRows[0].value;
    const originalRole = roleRows[0].role;

    try {
      await db.query(
        'UPDATE platform_settings SET value = $1 WHERE key = $2',
        ['99.99', 'payout_two_admin_threshold']
      );
      await db.query(
        'UPDATE users SET role = $1 WHERE id = $2',
        ['admin', harness.moderatorId]
      );
      const payoutId = await insertInitiatedPayout({ initiatedBy: harness.moderatorId });
      const dispute = await fileBuyerDispute();
      await resolveDispute(
        harness.adminId,
        dispute.body.id,
        await decisionInput('seller_favor')
      ).expect(200);

      const { rows: heldPayoutRows } = await db.query(
        `SELECT status, failure_reason, failed_by, failed_at, approved_by
         FROM seller_payouts WHERE id = $1`,
        [payoutId]
      );
      expect(heldPayoutRows).toEqual([{
        status: 'initiated',
        failure_reason: null,
        failed_by: null,
        failed_at: null,
        approved_by: null,
      }]);
      expect(await db.query(
        'SELECT state FROM payout_holds WHERE order_id = $1',
        [scenario.orderId]
      )).toMatchObject({ rows: [{ state: 'held' }] });

      await request(getApp())
        .post(`/api/admin/seller-payouts/${payoutId}/approve`)
        .set('Authorization', adminHeader())
        .send({ stepUpGrant: await createDecisionGrant('payout.approve') })
        .expect(200);
      await request(getApp())
        .post(`/api/admin/seller-payouts/${payoutId}/paid`)
        .set('Authorization', adminHeader())
        .send({
          method: 'bank',
          transferReference: 'DISPUTE-SELLER-FAVOR-PAID',
          paidOn: businessDate,
          stepUpGrant: await createDecisionGrant('payout.record'),
        })
        .expect(200);

      const { rows: paidRows } = await db.query(
        `SELECT status, approved_by, paid_by, failure_reason, failed_by, failed_at
         FROM seller_payouts WHERE id = $1`,
        [payoutId]
      );
      expect(paidRows).toEqual([{
        status: 'paid',
        approved_by: harness.adminId,
        paid_by: harness.adminId,
        failure_reason: null,
        failed_by: null,
        failed_at: null,
      }]);
    } finally {
      await db.query(
        'UPDATE platform_settings SET value = $1 WHERE key = $2',
        [originalThreshold, 'payout_two_admin_threshold']
      );
      await db.query(
        'UPDATE users SET role = $1 WHERE id = $2',
        [originalRole, harness.moderatorId]
      );
    }
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
    'FR-69: %s fails an initiated payout and audits it before creating the dispute refund',
    async (outcome) => {
      const payoutId = await insertInitiatedPayout();
      const dispute = await fileBuyerDispute();
      const response = await resolveDispute(
        harness.adminId,
        dispute.body.id,
        await decisionInput(outcome, '100.00')
      ).expect(200);

      expect(response.body.outcome).toBe(outcome);
      expect(response.body.refund).toMatchObject({
        amount: '100.00',
        refundAfterPayout: false,
      });
      const { rows: payoutRows } = await db.query(
        `SELECT status, failure_reason, failed_by, failed_at
         FROM seller_payouts WHERE id = $1`,
        [payoutId]
      );
      expect(payoutRows).toEqual([{
        status: 'failed',
        failure_reason: 'dispute_decision',
        failed_by: harness.adminId,
        failed_at: expect.any(Date),
      }]);
      const { rows: refundRows } = await db.query(
        `SELECT trigger, status, amount::text
         FROM refunds WHERE order_id = $1`,
        [scenario.orderId]
      );
      expect(refundRows).toEqual([{
        trigger: 'dispute_admin',
        status: 'approved',
        amount: '100.00',
      }]);
      expect(await db.query(
        'SELECT state FROM payout_holds WHERE order_id = $1',
        [scenario.orderId]
      )).toMatchObject({ rows: [{ state: 'held' }] });
      const { rows: auditRows } = await db.query(
        `SELECT actor_id, action, reason, metadata
         FROM money_audit_events
         WHERE order_id = $1 AND action = 'seller_payout_failed_by_dispute'`,
        [scenario.orderId]
      );
      expect(auditRows).toEqual([{
        actor_id: harness.adminId,
        action: 'seller_payout_failed_by_dispute',
        reason: 'dispute_decision',
        metadata: { payoutId, disputeId: dispute.body.id },
      }]);
    }
  );

  test('FR-69: failed dispute refund stays decided, is surfaced to Admin, and permits a new manual request', async () => {
    const dispute = await fileBuyerDispute();
    const resolution = await resolveDispute(
      harness.adminId,
      dispute.body.id,
      await decisionInput('buyer_favor', '100.00')
    ).expect(200);
    const refundId = resolution.body.refund.refundId;
    await db.query(
      `UPDATE refunds
       SET status = 'failed',
           attempt_count = 6,
           last_error_code = 'gateway_unavailable',
           last_attempt_at = now(),
           needs_attention_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [refundId]
    );

    const attention = await request(getApp())
      .get('/api/admin/refunds/attention')
      .set('Authorization', adminHeader())
      .expect(200);
    expect(attention.body.refunds).toEqual(expect.arrayContaining([
      expect.objectContaining({
        refundId,
        trigger: 'dispute_admin',
        amount: '100.00',
      }),
    ]));
    expect(await db.query('SELECT status FROM disputes WHERE id = $1', [dispute.body.id]))
      .toMatchObject({ rows: [{ status: 'resolved_refund' }] });

    const manualRequest = await request(getApp())
      .post(`/api/admin/orders/${scenario.orderId}/refunds`)
      .set('Authorization', adminHeader())
      .send({
        amount: '1.00',
        reason: 'Manual refund after the dispute refund failed.',
        stepUpGrant: await createDecisionGrant('refund.request'),
      })
      .expect(201);
    expect(manualRequest.body).toMatchObject({
      status: 'requested',
      amount: '1.00',
      currency: 'PKR',
    });
  });

  describe('FR-43 dispute evidence and buyer withdrawal', () => {
    test('FR-43c: buyer and seller can append notes and existing media references', async () => {
      const dispute = await fileBuyerDispute();
      const buyerEvidence = await addDisputeEvidence(
        scenario.buyerId,
        dispute.body.id,
        { note: 'The lining is damaged.' }
      ).expect(201);
      const sellerEvidence = await addDisputeEvidence(
        scenario.sellerId,
        dispute.body.id,
        { mediaReference: 'https://media.example.test/seller-inspection.jpg' }
      ).expect(201);

      expect(buyerEvidence.body).toMatchObject({ note: 'The lining is damaged.', submittedBy: 'buyer' });
      expect(sellerEvidence.body).toMatchObject({
        mediaReference: 'https://media.example.test/seller-inspection.jpg',
        submittedBy: 'seller',
      });
    });
  });

  describe('FR-44, FR-45, FR-56 dispute queue and timeline', () => {
      test('FR-44: status filters and cursor pagination return the matching dispute queue', async () => {
        const cursorAnchor = await fileBuyerDispute();
        await db.query(
          "UPDATE disputes SET created_at = '9998-12-31 23:59:59.999999+00' WHERE id = $1",
          [cursorAnchor.body.id]
        );
        const extraScenario = await createScenario(harness);
        extraScenarios.push(extraScenario);
        await deliverScenario(extraScenario);
        const firstDispute = await fileDispute(extraScenario.buyerId, extraScenario.orderId).expect(201);
        await db.query(
          "UPDATE disputes SET created_at = '9999-01-01 10:00:00.000123+00' WHERE id = $1",
          [firstDispute.body.id]
        );
        const lastScenario = await createScenario(harness);
        extraScenarios.push(lastScenario);
        await deliverScenario(lastScenario);
        const secondDispute = await fileDispute(lastScenario.buyerId, lastScenario.orderId).expect(201);
        await db.query(
          "UPDATE disputes SET created_at = '9999-01-01 10:00:00.000456+00' WHERE id = $1",
          [secondDispute.body.id]
        );

        const openIds = new Set();
        let before;
        let pages = 0;
        do {
          const path = `/api/disputes?status=open&limit=1&before=${before || cursorAnchor.body.id}`;
          const page = await request(getApp())
            .get(path)
            .set('Authorization', adminHeader())
            .expect(200);
          if (pages === 0) expect(page.headers['cache-control']).toBe('private, no-store');
          expect(page.body).toHaveLength(1);
          expect(openIds.has(page.body[0].id)).toBe(false);
          openIds.add(page.body[0].id);
          before = page.headers['x-next-before'] || null;
          pages += 1;
          expect(pages).toBeLessThan(3);
        } while (before);

        expect(pages).toBe(2);
        expect([...openIds]).toEqual([firstDispute.body.id, secondDispute.body.id]);
        const decided = await request(getApp())
          .get('/api/disputes?status=decided&limit=100')
          .set('Authorization', adminHeader())
          .expect(200);
        expect(decided.body.every((row) =>
          ['resolved_refund', 'resolved_release', 'resolved_other'].includes(row.status)
        )).toBe(true);
        expect(decided.body.map((row) => row.id)).not.toContain(firstDispute.body.id);
        expect(decided.body.map((row) => row.id)).not.toContain(secondDispute.body.id);
      });

      test('FR-44: microsecond dispute timestamps paginate each cursor exactly once', async () => {
        const cursorAnchor = await fileBuyerDispute();
        await db.query(
          "UPDATE disputes SET created_at = '9998-12-31 23:59:59.999999+00' WHERE id = $1",
          [cursorAnchor.body.id]
        );

        const timestamps = [
          '9999-01-01 10:00:00.000123+00',
          '9999-01-01 10:00:00.000456+00',
          '9999-01-01 10:00:00.000789+00',
        ];
        const disputeIds = [];
        for (const createdAt of timestamps) {
          const target = await createScenario(harness);
          extraScenarios.push(target);
          await deliverScenario(target);
          const dispute = await fileDispute(target.buyerId, target.orderId).expect(201);
          await db.query(
            'UPDATE disputes SET created_at = $2::timestamptz WHERE id = $1',
            [dispute.body.id, createdAt]
          );
          disputeIds.push(dispute.body.id);
        }

        const receivedIds = [];
        let before = cursorAnchor.body.id;
        let pageCount = 0;
        do {
          const page = await request(getApp())
            .get(`/api/disputes?status=open&limit=1&before=${before}`)
            .set('Authorization', adminHeader())
            .expect(200);
          expect(page.body).toHaveLength(1);
          receivedIds.push(page.body[0].id);
          before = page.headers['x-next-before'] || null;
          pageCount += 1;
          expect(pageCount).toBeLessThan(4);
        } while (before);

        expect(receivedIds).toEqual(disputeIds);
        expect(new Set(receivedIds).size).toBe(3);
        expect(pageCount).toBe(3);
        expect(before).toBeNull();
      });

      test('FR-56: buyer, seller, and Admin reads expose event timelines without Admin IDs', async () => {
        const dispute = await fileBuyerDispute();
        await addDisputeEvidence(scenario.buyerId, dispute.body.id, {
          note: 'The seam is coming apart.',
        }).expect(201);
        await request(getApp())
          .post(`/api/disputes/${dispute.body.id}/counter-evidence`)
          .set('Authorization', authHeader(scenario.sellerId))
          .send({ responseText: 'The item matched the listing.', evidenceUrls: [] })
          .expect(200);
        await resolveDispute(
          harness.adminId,
          dispute.body.id,
          await decisionInput('seller_favor')
        ).expect(200);

        const buyer = await request(getApp())
          .get(`/api/orders/${scenario.orderId}/summary`)
          .set('Authorization', authHeader(scenario.buyerId))
          .expect(200);
        const seller = await request(getApp())
          .get(`/api/orders/selling/${scenario.orderId}`)
          .set('Authorization', authHeader(scenario.sellerId))
          .expect(200);
        const adminQueue = await request(getApp())
          .get('/api/disputes?status=decided')
          .set('Authorization', adminHeader())
          .expect(200);
        const adminOrder = await request(getApp())
          .get(`/api/admin/orders/${scenario.orderId}`)
          .set('Authorization', adminHeader())
          .expect(200);
        const buyerTimeline = buyer.body.disputeFiling.timeline;
        const sellerTimeline = seller.body.disputeTimeline;
        const queueTimeline = adminQueue.body.find((row) => row.id === dispute.body.id).timeline;
        const orderTimeline = adminOrder.body.disputes.find((row) => row.id === dispute.body.id).timeline;
        const expectedEvents = ['filed', 'evidence_added', 'evidence_added', 'seller_responded', 'decided'];

        for (const timeline of [buyerTimeline, sellerTimeline, queueTimeline, orderTimeline]) {
          expect(timeline.map((item) => item.event)).toEqual(expectedEvents);
          expect(JSON.stringify(timeline)).not.toContain(harness.adminId);
        }
      });

      test('FR-56: SLA attention uses the business date and restores the setting', async () => {
        await withDisputeSlaDays('1', async () => {
          const dispute = await fileBuyerDispute();
          const currentBusinessDate = await getBusinessDate();
          await db.query(
            `UPDATE disputes
             SET created_at = (($2::date - 8)::timestamp AT TIME ZONE 'Asia/Karachi') + INTERVAL '12 hours'
             WHERE id = $1`,
            [dispute.body.id, currentBusinessDate]
          );

          const response = await request(getApp())
            .get('/api/disputes?status=open&ageBucket=needs_attention')
            .set('Authorization', adminHeader())
            .expect(200);
          const item = response.body.find((row) => row.id === dispute.body.id);
          expect(item).toMatchObject({
            ageBucket: 'needs_attention',
            needsAttention: true,
          });
          expect(item.ageBusinessDays).toBeGreaterThan(1);
          const withinSla = await request(getApp())
            .get('/api/disputes?status=open&ageBucket=within_sla')
            .set('Authorization', adminHeader())
            .expect(200);
          expect(withinSla.body.map((row) => row.id)).not.toContain(dispute.body.id);
        });
      });

      test('FR-56: SLA reminder runs twice enqueue one Admin notification job and one notification', async () => {
        let disputeId;
        let previouslyUnreminded = [];
        try {
          await withDisputeSlaDays('1', async () => {
            const dispute = await fileBuyerDispute();
            disputeId = dispute.body.id;
            const currentBusinessDate = await getBusinessDate();
            await db.query(
              `UPDATE disputes
               SET created_at = (($2::date - 8)::timestamp AT TIME ZONE 'Asia/Karachi') + INTERVAL '12 hours'
               WHERE id = $1`,
              [disputeId, currentBusinessDate]
            );
            const { rows: otherDisputes } = await db.query(
              `SELECT id
               FROM disputes
               WHERE id <> $1 AND status IN ('open', 'seller_responded')
                 AND sla_reminded_at IS NULL`,
              [disputeId]
            );
            previouslyUnreminded = otherDisputes.map((row) => row.id);
            if (previouslyUnreminded.length) {
              await db.query(
                'UPDATE disputes SET sla_reminded_at = now() WHERE id = ANY($1::uuid[])',
                [previouslyUnreminded]
              );
            }

            await expect(disputes.processDisputeSlaReminders({
              getBusinessDate: sellerPayouts.getBusinessDate,
            })).resolves.toBe(1);
            await expect(disputes.processDisputeSlaReminders({
              getBusinessDate: sellerPayouts.getBusinessDate,
            })).resolves.toBe(0);

            const { rows: jobs } = await db.query(
              `SELECT id, data FROM pgboss.job
               WHERE name = $1 AND data->>'eventName' = $2
                 AND data->'payload'->>'disputeId' = $3`,
              [QUEUES.NOTIFICATIONS, events.DISPUTE_SLA_BREACHED, disputeId]
            );
            expect(jobs).toHaveLength(1);
            const transactionDb = {
              executeSql: (text, values = []) => transactionDb.client.query(text, values),
            };
            await db.withTransaction(async (client) => {
              transactionDb.client = client;
              await notificationService.processNotificationJob(jobs[0].data, transactionDb);
            });
            const { rows: notifications } = await db.query(
              `SELECT user_id, payload, dedupe_key
               FROM notifications
               WHERE user_id = $1 AND event_type = 'dispute_sla_breached'
                 AND dedupe_key = $2`,
              [harness.adminId, `dispute_sla_breached:${disputeId}`]
            );
            expect(notifications).toHaveLength(1);
            expect(notifications[0].user_id).toBe(harness.adminId);
            expect(notifications[0].payload).toMatchObject({
              disputeId,
              orderId: scenario.orderId,
              message: 'A dispute has exceeded its review SLA.',
            });
          });
        } finally {
          if (previouslyUnreminded.length) {
            await db.query(
              `UPDATE disputes SET sla_reminded_at = NULL
               WHERE id = ANY($1::uuid[]) AND status IN ('open', 'seller_responded')`,
              [previouslyUnreminded]
            );
          }
          if (disputeId) {
            await db.query(
              `DELETE FROM notifications
               WHERE event_type = 'dispute_sla_breached'
                 AND dedupe_key = $1`,
              [`dispute_sla_breached:${disputeId}`]
            );
            await db.query(
              `DELETE FROM pgboss.job
               WHERE name = $1 AND data->>'eventName' = $2
                 AND data->'payload'->>'disputeId' = $3`,
              [QUEUES.NOTIFICATIONS, events.DISPUTE_SLA_BREACHED, disputeId]
            );
          }
        }
      });
  });

  describe('FR-43 dispute evidence and buyer withdrawal', () => {
    test('FR-43c: unrelated users receive 403 when adding or reading party evidence', async () => {
      const dispute = await fileBuyerDispute();

      await addDisputeEvidence(harness.unrelatedBuyerId, dispute.body.id, {
        note: 'This is not my order.',
      }).expect(403);
      await readPartyDisputeEvidence(harness.unrelatedBuyerId, dispute.body.id).expect(403);
    });

    test('FR-43c: a dispute accepts at most ten total evidence items', async () => {
      const dispute = await fileBuyerDispute();
      for (let index = 0; index < 9; index += 1) {
        await addDisputeEvidence(scenario.buyerId, dispute.body.id, {
          note: `Additional evidence item ${index}.`,
        }).expect(201);
      }

      await addDisputeEvidence(scenario.buyerId, dispute.body.id, {
        note: 'This exceeds the evidence limit.',
      }).expect(400);
      const { rows } = await db.query(
        'SELECT count(*)::int AS count FROM dispute_evidence WHERE dispute_id = $1',
        [dispute.body.id]
      );
      expect(rows[0].count).toBe(10);
    });

    test('FR-43c: evidence notes are limited to 3 through 500 characters', async () => {
      const dispute = await fileBuyerDispute();
      await addDisputeEvidence(scenario.buyerId, dispute.body.id, { note: 'ab' }).expect(400);
      await addDisputeEvidence(scenario.buyerId, dispute.body.id, { note: 'x'.repeat(501) }).expect(400);
      await addDisputeEvidence(scenario.buyerId, dispute.body.id, { note: '123' }).expect(201);
      await addDisputeEvidence(scenario.buyerId, dispute.body.id, { note: 'x'.repeat(500) }).expect(201);
    });

    test('FR-43c: evidence is visible to both parties and the Admin without Admin IDs', async () => {
      const dispute = await fileBuyerDispute();
      await addDisputeEvidence(scenario.buyerId, dispute.body.id, {
        note: 'The seam is coming apart.',
      }).expect(201);
      const buyerRead = await readPartyDisputeEvidence(scenario.buyerId, dispute.body.id).expect(200);
      const sellerRead = await readPartyDisputeEvidence(scenario.sellerId, dispute.body.id).expect(200);
      const adminRead = await request(getApp())
        .get(`/api/disputes/${dispute.body.id}/evidence`)
        .set('Authorization', adminHeader())
        .expect(200);

      expect(buyerRead.body).toEqual(sellerRead.body);
      expect(buyerRead.body).toEqual(expect.arrayContaining([
        expect.objectContaining({ note: 'The seam is coming apart.', submittedBy: 'buyer' }),
      ]));
      expect(JSON.stringify(buyerRead.body)).not.toContain(harness.adminId);
      expect(JSON.stringify(buyerRead.body)).not.toContain('uploaded_by');
      expect(adminRead.body).toEqual(expect.arrayContaining([
        expect.objectContaining({ note: 'The seam is coming apart.' }),
      ]));
    });

    test('FR-43c: adding evidence to a decided dispute returns 409', async () => {
      const dispute = await fileBuyerDispute();
      await resolveDispute(
        harness.adminId,
        dispute.body.id,
        await decisionInput('seller_favor')
      ).expect(200);

      await addDisputeEvidence(scenario.buyerId, dispute.body.id, {
        note: 'A late note must not change the decision.',
      }).expect(409);
    });

    test('FR-43: buyer withdrawal releases the shared hold and is audited', async () => {
      const dispute = await fileBuyerDispute();
      await withdrawDispute(scenario.buyerId, dispute.body.id)
        .expect(200)
        .expect(({ body }) => expect(body).toMatchObject({ status: 'withdrawn' }));

      const { rows: holdRows } = await db.query(
        'SELECT state, dispute_id FROM payout_holds WHERE order_id = $1',
        [scenario.orderId]
      );
      expect(holdRows).toEqual([{ state: 'held', dispute_id: null }]);
      const { rows: auditRows } = await db.query(
        `SELECT actor_id, action, metadata
         FROM money_audit_events WHERE order_id = $1 AND action = 'dispute_withdrawn'`,
        [scenario.orderId]
      );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toMatchObject({
        actor_id: scenario.buyerId,
        action: 'dispute_withdrawn',
        metadata: { disputeId: dispute.body.id },
      });
    });

    test('FR-43: a buyer cannot withdraw after the seller responds', async () => {
      const dispute = await fileBuyerDispute();
      await request(getApp())
        .post(`/api/disputes/${dispute.body.id}/counter-evidence`)
        .set('Authorization', authHeader(scenario.sellerId))
        .send({ responseText: 'The item matched the listing.', evidenceUrls: [] })
        .expect(200);

      await withdrawDispute(scenario.buyerId, dispute.body.id).expect(409);
    });

    test('FR-43: a buyer cannot withdraw after the dispute is decided', async () => {
      const dispute = await fileBuyerDispute();
      await resolveDispute(
        harness.adminId,
        dispute.body.id,
        await decisionInput('seller_favor')
      ).expect(200);

      await withdrawDispute(scenario.buyerId, dispute.body.id).expect(409);
    });

    test('FR-43: concurrent withdrawal and Admin decision have exactly one winner', async () => {
      const dispute = await fileBuyerDispute();
      const [withdrawal, decision] = await Promise.all([
        withdrawDispute(scenario.buyerId, dispute.body.id),
        decisionInput('seller_favor').then((input) => resolveDispute(harness.adminId, dispute.body.id, input)),
      ]);

      expect([withdrawal.status, decision.status].filter((status) => status === 200)).toHaveLength(1);
      expect([withdrawal.status, decision.status].filter((status) => status === 409)).toHaveLength(1);
      const { rows } = await db.query('SELECT status FROM disputes WHERE id = $1', [dispute.body.id]);
      expect(['withdrawn', 'resolved_release']).toContain(rows[0].status);
    });
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

  test('FR-56: Moderator can read the no-store dispute queue but cannot decide disputes', async () => {
    const dispute = await fileBuyerDispute();

    await resolveDispute(harness.moderatorId, dispute.body.id, {}).expect(403);
    const response = await request(getApp())
      .get('/api/disputes')
      .set('Authorization', authHeader(harness.moderatorId))
      .expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
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

  test('FR-69: refund failure rolls back an initiated payout failure and leaves the dispute open', async () => {
    const payoutId = await insertInitiatedPayout();
    const dispute = await fileBuyerDispute();
    const createRefund = jest.spyOn(escrowPayments, 'createDisputeRefund')
      .mockRejectedValueOnce(new Error('forced dispute refund failure'));
    try {
      await resolveDispute(
        harness.adminId,
        dispute.body.id,
        await decisionInput('buyer_favor', '100.00')
      ).expect(500);
    } finally {
      createRefund.mockRestore();
    }

    const { rows: payoutRows } = await db.query(
      `SELECT status, failure_reason, failed_by, failed_at
       FROM seller_payouts WHERE id = $1`,
      [payoutId]
    );
    expect(payoutRows).toEqual([{
      status: 'initiated',
      failure_reason: null,
      failed_by: null,
      failed_at: null,
    }]);
    expect(await db.query('SELECT status FROM disputes WHERE id = $1', [dispute.body.id]))
      .toMatchObject({ rows: [{ status: 'open' }] });
    expect(await db.query(
      'SELECT state FROM payout_holds WHERE order_id = $1',
      [scenario.orderId]
    )).toMatchObject({ rows: [{ state: 'paused_for_dispute' }] });
    const { rows: auditRows } = await db.query(
      `SELECT id FROM money_audit_events
       WHERE order_id = $1 AND action = 'seller_payout_failed_by_dispute'`,
      [scenario.orderId]
    );
    expect(auditRows).toEqual([]);
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
        paidOn: businessDate,
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
               'bank', 'DISPUTE-AFTER-PAYOUT',
               (now() AT TIME ZONE 'Asia/Karachi')::date, $3, now())`,
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

  test('FR-69: buyer_favor leaves a paid payout and its cash ledger untouched', async () => {
    await db.query(
      `UPDATE orders SET status = 'completed', completed_at = now() WHERE id = $1`,
      [scenario.orderId]
    );
    await db.query(
      `UPDATE payout_holds SET state = 'released', released_at = now() WHERE order_id = $1`,
      [scenario.orderId]
    );
    const { rows: insertedPayoutRows } = await db.query(
      `INSERT INTO seller_payouts
         (order_id, seller_id, attempt, status, amount, currency, initiated_by,
          method, transfer_reference, paid_on, paid_by, paid_at)
       VALUES ($1, $2, 1, 'paid', '100.00', 'PKR', $3,
               'bank', 'DISPUTE-PAID-REFUND-TEST',
               (now() AT TIME ZONE 'Asia/Karachi')::date, $3, now())
       RETURNING id`,
      [scenario.orderId, scenario.sellerId, harness.adminId]
    );
    await db.query(
      `INSERT INTO ledger_entries
         (order_id, payment_id, currency, amount, entry_type, idempotency_key)
       VALUES ($1, $2, 'PKR', '-100.00', 'seller_payout_manual', $3)`,
      [scenario.orderId, scenario.paymentId, `seller_payout_manual:${scenario.orderId}`]
    );
    const payoutId = insertedPayoutRows[0].id;
    const { rows: payoutBefore } = await db.query(
      `SELECT id, status, amount::text, failure_reason, failed_by, failed_at,
              transfer_reference, paid_by
       FROM seller_payouts WHERE id = $1`,
      [payoutId]
    );
    const { rows: ledgerBefore } = await db.query(
      `SELECT id, entry_type, amount::text
       FROM ledger_entries WHERE order_id = $1 ORDER BY id`,
      [scenario.orderId]
    );
    const dispute = await fileBuyerDispute();

    await resolveDispute(
      harness.adminId,
      dispute.body.id,
      await decisionInput('buyer_favor', '100.00')
    ).expect(200);

    const { rows: payoutAfter } = await db.query(
      `SELECT id, status, amount::text, failure_reason, failed_by, failed_at,
              transfer_reference, paid_by
       FROM seller_payouts WHERE id = $1`,
      [payoutId]
    );
    const { rows: ledgerAfter } = await db.query(
      `SELECT id, entry_type, amount::text
       FROM ledger_entries WHERE order_id = $1 ORDER BY id`,
      [scenario.orderId]
    );
    expect(payoutAfter).toEqual(payoutBefore);
    expect(ledgerAfter).toEqual(ledgerBefore);
    const { rows: auditRows } = await db.query(
      `SELECT action, metadata
       FROM money_audit_events
       WHERE order_id = $1
         AND action IN ('dispute_after_payout', 'refund_after_payout',
                        'seller_payout_failed_by_dispute')`,
      [scenario.orderId]
    );
    expect(auditRows.map((row) => row.action).sort()).toEqual([
      'dispute_after_payout',
      'refund_after_payout',
    ]);
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
