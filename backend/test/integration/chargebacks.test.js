const crypto = require('node:crypto');
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
const { signAccessToken } = require('../../src/lib/jwt');

const JWT_SECRET = 'delivery-handover-integration-secret';
const VALID_CHARGEBACK = {
  amount: '1300.55',
  reference: 'GATEWAY-CASE-1001',
  note: 'Gateway chargeback recorded for integration test.',
};

let harness;
let scenario;
let sessionId;
let authSessions;
let moderatorId;

function sessionAuthHeader(userId, targetSessionId = sessionId) {
  return `Bearer ${signAccessToken(userId, { secret: JWT_SECRET, sessionId: targetSessionId })}`;
}

async function createSession(userId = harness.adminId) {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO auth_sessions
       (id, family_id, user_id, refresh_token_hash, expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, now() + INTERVAL '1 hour', now() + INTERVAL '1 day')`,
    [
      id,
      crypto.randomUUID(),
      userId,
      crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
    ]
  );
  authSessions.push(id);
  return id;
}

async function createStepUpGrant(userId = harness.adminId, targetSessionId = sessionId) {
  const grant = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO step_up_grants (token_hash, user_id, session_id, action, expires_at)
     VALUES ($1, $2, $3, 'refund.decide', now() + INTERVAL '5 minutes')`,
    [
      crypto.createHash('sha256').update(grant).digest('hex'),
      userId,
      targetSessionId,
    ]
  );
  return grant;
}

async function deliverScenario(target = scenario) {
  await db.query(
    `UPDATE orders
     SET status = 'handed_to_delivery', handed_over_at = now()
     WHERE id = $1`,
    [target.orderId]
  );
  await adminDeliveredRequest(harness, target, { note: 'Delivered for chargeback test' }).expect(200);
}

function recordChargeback(
  body = VALID_CHARGEBACK,
  orderId = scenario.orderId,
  userId = harness.adminId,
  targetSessionId = sessionId
) {
  return request(getApp())
    .post(`/api/admin/orders/${orderId}/chargebacks`)
    .set('Authorization', sessionAuthHeader(userId, targetSessionId))
    .send(body);
}

function resolveChargeback(chargebackId, body, userId = harness.adminId) {
  return request(getApp())
    .post(`/api/admin/chargebacks/${chargebackId}/resolve`)
    .set('Authorization', sessionAuthHeader(userId))
    .send(body);
}

async function addPayout(status) {
  const { rows } = await db.query(
    `INSERT INTO seller_payouts
       (order_id, seller_id, attempt, status, amount, currency, initiated_by,
        method, transfer_reference, paid_on, paid_by, paid_at)
     VALUES ($1, $2, 1, $3, '5.00', 'PKR', $4::uuid,
             CASE WHEN $3 = 'paid'
                  THEN 'bank'::payout_method_type
                  ELSE NULL::payout_method_type
             END,
             CASE WHEN $3 = 'paid' THEN 'CHARGEBACK-TEST-TRANSFER' ELSE NULL END,
             CASE WHEN $3 = 'paid' THEN DATE '2024-01-01' ELSE NULL END,
             CASE WHEN $3 = 'paid' THEN $4::uuid ELSE NULL END,
             CASE WHEN $3 = 'paid' THEN now() ELSE NULL END)
     RETURNING id`,
    [scenario.orderId, scenario.sellerId, status, harness.adminId]
  );
  return rows[0].id;
}

async function record(body = VALID_CHARGEBACK) {
  return recordChargeback({
    ...body,
    stepUpGrant: await createStepUpGrant(),
  }).expect(201);
}

async function resetAndCleanupScenario() {
  if (!scenario) return;
  await global.drainIntegrationListeners(5000);
  const { rows: auditRows } = await db.query(
    'SELECT EXISTS (SELECT 1 FROM money_audit_events WHERE order_id = $1) AS retained',
    [scenario.orderId]
  );
  await db.query('DELETE FROM return_requests WHERE order_id = $1', [scenario.orderId]);
  if (!auditRows[0].retained) {
    await db.query('DELETE FROM chargebacks WHERE order_id = $1', [scenario.orderId]);
    await db.query('DELETE FROM disputes WHERE order_id = $1', [scenario.orderId]);
    await db.query(
      `DELETE FROM pgboss.job
       WHERE data->'payload'->>'orderId' = $1
          OR data->>'refundId' IN (SELECT id::text FROM refunds WHERE order_id = $1)`,
      [scenario.orderId]
    );
    await db.query('DELETE FROM refunds WHERE order_id = $1', [scenario.orderId]);
    await db.query('DELETE FROM seller_payouts WHERE order_id = $1', [scenario.orderId]);
  }
  if (authSessions.length) {
    await db.query('DELETE FROM step_up_grants WHERE session_id = ANY($1::uuid[])', [authSessions]);
    await db.query('DELETE FROM auth_sessions WHERE id = ANY($1::uuid[])', [authSessions]);
  }
  if (moderatorId) {
    await db.query('DELETE FROM users WHERE id = $1', [moderatorId]);
    harness.extraUserIds = harness.extraUserIds.filter((userId) => userId !== moderatorId);
    moderatorId = null;
  }
  await cleanupScenario(harness, scenario);
  scenario = null;
}

beforeAll(async () => {
  harness = await createHarness();
});

beforeEach(async () => {
  authSessions = [];
  sessionId = await createSession();
  scenario = await createScenario(harness);
  await deliverScenario();
});

afterEach(async () => {
  await resetAndCleanupScenario();
  sessionId = null;
});

describe('FR-57, FR-58 chargebacks', () => {
  test('FR-57: records an exact-decimal chargeback, reuses the payout hold, and allocates item and delivery amounts', async () => {
    const response = await record();
    expect(response.body).toMatchObject({
      orderId: scenario.orderId,
      amount: '1300.55',
      currency: 'PKR',
      reference: VALID_CHARGEBACK.reference,
      status: 'open',
      refund: {
        status: 'approved',
        amount: '1300.55',
        itemAmount: '1250.50',
        deliveryFeeAmount: '50.05',
        sellerAtFault: false,
      },
    });
    const { rows: holdRows } = await db.query(
      'SELECT state FROM payout_holds WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(holdRows).toEqual([{ state: 'paused_for_dispute' }]);
    const { rows: auditRows } = await db.query(
      `SELECT action FROM money_audit_events
       WHERE order_id = $1 AND action = 'chargeback_recorded'`,
      [scenario.orderId]
    );
    expect(auditRows).toEqual([{ action: 'chargeback_recorded' }]);
    const { rows: refundRows } = await db.query(
      `SELECT trigger, status, amount::text AS amount, item_amount::text AS item_amount,
              delivery_fee_amount::text AS delivery_fee_amount, seller_at_fault
       FROM refunds WHERE order_id = $1`,
      [scenario.orderId]
    );
    expect(refundRows).toEqual([{
      trigger: 'chargeback',
      status: 'approved',
      amount: '1300.55',
      item_amount: '1250.50',
      delivery_fee_amount: '50.05',
      seller_at_fault: false,
    }]);
  });

  test('FR-57: fails an initiated payout for chargeback and audits the failure', async () => {
    const payoutId = await addPayout('initiated');
    const chargeback = await record();
    const { rows } = await db.query(
      'SELECT status, failure_reason, failed_by FROM seller_payouts WHERE id = $1',
      [payoutId]
    );
    expect(rows).toEqual([{
      status: 'failed',
      failure_reason: 'chargeback',
      failed_by: harness.adminId,
    }]);
    const { rows: auditRows } = await db.query(
      `SELECT action FROM money_audit_events
       WHERE order_id = $1 AND action = 'seller_payout_failed_by_chargeback'`,
      [scenario.orderId]
    );
    expect(auditRows).toEqual([{ action: 'seller_payout_failed_by_chargeback' }]);
    expect(chargeback.body.failedPayoutIds).toEqual([payoutId]);
  });

  test('FR-57: leaves a paid payout and ledger untouched, auditing and surfacing chargeback_after_payout to Admin', async () => {
    const payoutId = await addPayout('paid');
    const { rows: ledgerBefore } = await db.query(
      'SELECT id, entry_type, amount::text FROM ledger_entries WHERE order_id = $1 ORDER BY id',
      [scenario.orderId]
    );
    const chargeback = await record();
    const { rows: payoutRows } = await db.query(
      'SELECT status, failure_reason FROM seller_payouts WHERE id = $1',
      [payoutId]
    );
    const { rows: ledgerAfter } = await db.query(
      'SELECT id, entry_type, amount::text FROM ledger_entries WHERE order_id = $1 ORDER BY id',
      [scenario.orderId]
    );
    expect(payoutRows).toEqual([{ status: 'paid', failure_reason: null }]);
    expect(ledgerAfter).toEqual(ledgerBefore);
    expect(chargeback.body.payoutAfterPayment).toBe(true);
    const { rows: auditRows } = await db.query(
      `SELECT action FROM money_audit_events
       WHERE order_id = $1 AND action = 'chargeback_after_payout'`,
      [scenario.orderId]
    );
    expect(auditRows).toEqual([{ action: 'chargeback_after_payout' }]);
    const adminRead = await request(getApp())
      .get(`/api/admin/chargebacks/${chargeback.body.chargebackId}`)
      .set('Authorization', authHeader(harness.adminId))
      .expect(200);
    expect(adminRead.body).toMatchObject({
      payoutAfterPayment: true,
      recordedBy: harness.adminId,
      refundId: chargeback.body.refundId,
    });
  });

  test('FR-57: includes partial refunds in the captured-amount cap', async () => {
    await db.query(
      `INSERT INTO refunds
         (payment_id, order_id, trigger, amount, currency, status, idempotency_key,
          item_amount, delivery_fee_amount, seller_at_fault)
       VALUES ($1, $2, 'return_admin', '1200.00', 'PKR', 'succeeded', $3,
               '1200.00', '0.00', false)`,
      [scenario.paymentId, scenario.orderId, `chargeback-cap:${scenario.orderId}`]
    );
    const response = await recordChargeback({
      ...VALID_CHARGEBACK,
      amount: '400.00',
      stepUpGrant: await createStepUpGrant(),
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/remaining refundable balance/i);
  });

  test('FR-57: rejects duplicate references for the same order', async () => {
    await record();
    const duplicate = await recordChargeback({
      ...VALID_CHARGEBACK,
      amount: '10.00',
      stepUpGrant: await createStepUpGrant(),
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toMatch(/reference already exists/i);
  });

  test('FR-58: a won chargeback voids an unexecuted refund and clears the shared hold', async () => {
    const chargeback = await record();
    const resolved = await resolveChargeback(chargeback.body.chargebackId, {
      outcome: 'won',
      resolutionNote: 'Gateway reversed the chargeback.',
      stepUpGrant: await createStepUpGrant(),
    }).expect(200);
    const { rows: refundRows } = await db.query(
      'SELECT status FROM refunds WHERE id = $1',
      [chargeback.body.refundId]
    );
    const { rows: holdRows } = await db.query(
      'SELECT state FROM payout_holds WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(refundRows).toEqual([{ status: 'voided' }]);
    expect(holdRows).toEqual([{ state: 'held' }]);
    expect(resolved.body).toMatchObject({
      status: 'won',
      refundStatus: 'voided',
      payoutHoldRetained: false,
    });
  });

  test('FR-58: a lost chargeback leaves its refund standing and clears the shared hold', async () => {
    const chargeback = await record();
    const resolved = await resolveChargeback(chargeback.body.chargebackId, {
      outcome: 'lost',
      resolutionNote: 'Gateway upheld the chargeback.',
      stepUpGrant: await createStepUpGrant(),
    }).expect(200);
    const { rows: refundRows } = await db.query(
      'SELECT status FROM refunds WHERE id = $1',
      [chargeback.body.refundId]
    );
    const { rows: holdRows } = await db.query(
      'SELECT state FROM payout_holds WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(refundRows).toEqual([{ status: 'approved' }]);
    expect(holdRows).toEqual([{ state: 'held' }]);
    expect(resolved.body).toMatchObject({
      status: 'lost',
      refundStatus: 'approved',
      payoutHoldRetained: false,
    });
  });

  test('FR-58: resolving a chargeback keeps the shared hold while a return remains open', async () => {
    await request(getApp())
      .post(`/api/returns/orders/${scenario.orderId}`)
      .set('Authorization', authHeader(scenario.buyerId))
      .send({ reason: 'The delivered item needs a return review.' })
      .expect(201);
    const chargeback = await record();
    await resolveChargeback(chargeback.body.chargebackId, {
      outcome: 'lost',
      resolutionNote: 'Gateway upheld the chargeback.',
      stepUpGrant: await createStepUpGrant(),
    }).expect(200);
    const { rows } = await db.query(
      'SELECT state FROM payout_holds WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(rows).toEqual([{ state: 'paused_for_dispute' }]);
  });

  test('FR-58: resolving a dispute keeps the shared hold while a chargeback remains open', async () => {
    const chargeback = await record();
    const dispute = await request(getApp())
      .post(`/api/disputes/orders/${scenario.orderId}`)
      .set('Authorization', authHeader(scenario.buyerId))
      .send({
        reasonText: 'The delivered item differs from its listing.',
        evidenceUrls: ['https://example.test/chargeback-dispute.jpg'],
      })
      .expect(201);
    await request(getApp())
      .post(`/api/disputes/${dispute.body.id}/resolve`)
      .set('Authorization', sessionAuthHeader(harness.adminId))
      .send({
        outcome: 'seller_favor',
        reason: 'Reviewed the evidence and released the dispute.',
        stepUpGrant: await createStepUpGrant(),
      })
      .expect(200);
    const { rows: pausedRows } = await db.query(
      'SELECT state FROM payout_holds WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(pausedRows).toEqual([{ state: 'paused_for_dispute' }]);

    await resolveChargeback(chargeback.body.chargebackId, {
      outcome: 'lost',
      resolutionNote: 'Gateway upheld the chargeback.',
      stepUpGrant: await createStepUpGrant(),
    }).expect(200);
    const { rows: releasedRows } = await db.query(
      'SELECT state FROM payout_holds WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(releasedRows).toEqual([{ state: 'held' }]);
  });

  test('FR-58: a won chargeback after refund execution is audited without reversing the refund', async () => {
    const chargeback = await record();
    await db.query(
      `UPDATE refunds
       SET status = 'succeeded', completed_at = now(), updated_at = now()
       WHERE id = $1`,
      [chargeback.body.refundId]
    );
    const resolved = await resolveChargeback(chargeback.body.chargebackId, {
      outcome: 'won',
      resolutionNote: 'Gateway reversed the chargeback after refund execution.',
      stepUpGrant: await createStepUpGrant(),
    }).expect(200);
    const { rows: refundRows } = await db.query(
      'SELECT status FROM refunds WHERE id = $1',
      [chargeback.body.refundId]
    );
    const { rows: auditRows } = await db.query(
      `SELECT action FROM money_audit_events
       WHERE order_id = $1 AND action = 'chargeback_won_after_refund'`,
      [scenario.orderId]
    );
    expect(refundRows).toEqual([{ status: 'succeeded' }]);
    expect(auditRows).toEqual([{ action: 'chargeback_won_after_refund' }]);
    expect(resolved.body.refundAfterChargebackWin).toBe(true);
  });

  test('FR-58: a second chargeback resolution returns 409', async () => {
    const chargeback = await record();
    await resolveChargeback(chargeback.body.chargebackId, {
      outcome: 'lost',
      resolutionNote: 'Gateway upheld the chargeback.',
      stepUpGrant: await createStepUpGrant(),
    }).expect(200);
    const second = await resolveChargeback(chargeback.body.chargebackId, {
      outcome: 'won',
      resolutionNote: 'A second resolution must not apply.',
      stepUpGrant: await createStepUpGrant(),
    });
    expect(second.status).toBe(409);
  });

  test('FR-57: concurrent cap-exceeding chargebacks have exactly one winner', async () => {
    const makeRequest = async (reference) => recordChargeback({
      amount: '1000.00',
      reference,
      note: 'Concurrent cap test chargeback.',
      stepUpGrant: await createStepUpGrant(),
    });
    const responses = await Promise.all([
      makeRequest('CONCURRENT-1001'),
      makeRequest('CONCURRENT-1002'),
    ]);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
  });

  test('FR-57: multiple chargebacks with distinct references are allowed within the cap', async () => {
    await record({
      amount: '10.00',
      reference: 'GATEWAY-CASE-2001',
      note: 'First small chargeback for the order.',
    });
    const second = await record({
      amount: '20.00',
      reference: 'GATEWAY-CASE-2002',
      note: 'Second small chargeback for the order.',
    });
    expect(second.body.status).toBe('open');
    const { rows } = await db.query(
      'SELECT count(*)::int AS count FROM chargebacks WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(rows).toEqual([{ count: 2 }]);
  });

  test('FR-57: refund insertion failure rolls back the chargeback, payout hold, payout failure, and step-up', async () => {
    const payoutId = await addPayout('initiated');
    const grant = await createStepUpGrant();
    const tokenHash = crypto.createHash('sha256').update(grant).digest('hex');
    const suffix = crypto.randomUUID().replace(/-/g, '');
    const triggerName = `chargeback_refund_failure_${suffix}`;
    const functionName = `chargeback_refund_failure_fn_${suffix}`;
    await db.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.trigger = 'chargeback' THEN
           RAISE EXCEPTION 'injected chargeback refund failure';
         END IF;
         RETURN NEW;
       END $$`
    );
    await db.query(
      `CREATE TRIGGER ${triggerName} BEFORE INSERT ON refunds
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`
    );
    try {
      const response = await recordChargeback({
        ...VALID_CHARGEBACK,
        stepUpGrant: grant,
      });
      expect(response.status).toBe(500);
    } finally {
      await db.query(`DROP TRIGGER ${triggerName} ON refunds`);
      await db.query(`DROP FUNCTION ${functionName}()`);
    }
    const { rows: chargebackRows } = await db.query(
      'SELECT id FROM chargebacks WHERE order_id = $1',
      [scenario.orderId]
    );
    const { rows: refundRows } = await db.query(
      `SELECT id FROM refunds WHERE order_id = $1 AND trigger = 'chargeback'`,
      [scenario.orderId]
    );
    const { rows: payoutRows } = await db.query(
      'SELECT status FROM seller_payouts WHERE id = $1',
      [payoutId]
    );
    const { rows: holdRows } = await db.query(
      'SELECT state FROM payout_holds WHERE order_id = $1',
      [scenario.orderId]
    );
    const { rows: grantRows } = await db.query(
      'SELECT consumed_at FROM step_up_grants WHERE token_hash = $1',
      [tokenHash]
    );
    expect(chargebackRows).toEqual([]);
    expect(refundRows).toEqual([]);
    expect(payoutRows).toEqual([{ status: 'initiated' }]);
    expect(holdRows).toEqual([{ state: 'held' }]);
    expect(grantRows).toEqual([{ consumed_at: null }]);
  });

  test('FR-57: amount must be a positive decimal string and not exceed the uncaptured balance', async () => {
    const invalidAmount = await recordChargeback({
      ...VALID_CHARGEBACK,
      amount: 10,
      stepUpGrant: await createStepUpGrant(),
    });
    expect(invalidAmount.status).toBe(400);
    const zeroAmount = await recordChargeback({
      ...VALID_CHARGEBACK,
      amount: '0.00',
      stepUpGrant: await createStepUpGrant(),
    });
    expect(zeroAmount.status).toBe(400);
  });

  test('FR-57, FR-58: Moderators and Admins without step-up cannot record or resolve chargebacks', async () => {
    const chargeback = await record();
    const { rows } = await db.query(
      `INSERT INTO users (full_name, phone, password_hash, city_id, role)
       VALUES ($1, $2, 'chargeback-test-hash', $3, 'moderator') RETURNING id`,
      [
        `Chargeback moderator ${crypto.randomUUID()}`,
        `+1560${crypto.randomInt(0, 1_000_000_000).toString().padStart(9, '0')}`,
        harness.fixture.cityId,
      ]
    );
    moderatorId = rows[0].id;
    harness.extraUserIds.push(moderatorId);
    const moderatorSession = await createSession(moderatorId);
    const moderatorGrant = await createStepUpGrant(moderatorId, moderatorSession);
    const moderatorRecord = await recordChargeback({
      ...VALID_CHARGEBACK,
      reference: 'MODERATOR-CASE',
      stepUpGrant: moderatorGrant,
    }, scenario.orderId, moderatorId, moderatorSession);
    expect(moderatorRecord.status).toBe(403);

    const adminWithoutGrant = await resolveChargeback(chargeback.body.chargebackId, {
      outcome: 'lost',
      resolutionNote: 'A step-up grant is required.',
    });
    expect(adminWithoutGrant.status).toBe(403);
  });

  test('FR-57, FR-58: buyer and seller reads expose status and outcome without Admin identity or clawback entries', async () => {
    const chargeback = await record();
    const buyerSummary = await request(getApp())
      .get(`/api/orders/${scenario.orderId}/summary`)
      .set('Authorization', authHeader(scenario.buyerId))
      .expect(200);
    const sellerOrder = await request(getApp())
      .get(`/api/orders/selling/${scenario.orderId}`)
      .set('Authorization', authHeader(scenario.sellerId))
      .expect(200);
    expect(buyerSummary.body.chargebacks).toEqual([{ status: 'open', outcome: null }]);
    expect(sellerOrder.body.chargebacks).toEqual([{ status: 'open', outcome: null }]);
    expect(JSON.stringify([buyerSummary.body, sellerOrder.body]))
      .not.toMatch(/recordedBy|recorded_by|resolvedBy|resolved_by|adminId|admin_id/i);
    const { rows } = await db.query(
      `SELECT entry_type FROM ledger_entries
       WHERE order_id = $1 AND entry_type NOT IN ('capture', 'refund', 'seller_payout_manual')`,
      [scenario.orderId]
    );
    expect(rows).toEqual([]);
    expect(chargeback.body.recordedBy).toBe(harness.adminId);
    const adminList = await request(getApp())
      .get('/api/admin/chargebacks?status=open')
      .set('Authorization', authHeader(harness.adminId))
      .expect(200);
    expect(adminList.body.chargebacks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        chargebackId: chargeback.body.chargebackId,
        recordedBy: harness.adminId,
        status: 'open',
      }),
    ]));
  });

  afterAll(async () => {
    if (moderatorId) await db.query('DELETE FROM users WHERE id = $1', [moderatorId]);
    await db.query('DELETE FROM supported_delivery_cities WHERE city_id = $1', [harness.fixture.cityId]);
    await cleanupHarness(harness);
    restoreHandoverTestEnvironment();
  });
});
