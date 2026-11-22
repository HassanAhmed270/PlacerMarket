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
  request: httpRequest,
  restoreHandoverTestEnvironment,
} = require('./delivery-handover.helpers');
const { signAccessToken } = require('../../src/lib/jwt');
const sellerPayouts = require('../../src/modules/sellerPayouts.service');
const payout = require('../../src/modules/payout.service');

const JWT_SECRET = 'delivery-handover-integration-secret';
const OPEN_DISPUTE_BODY = {
  reasonText: 'The delivered item differs from the listing.',
  evidenceUrls: ['https://media.example.test/return-dispute.jpg'],
};

let harness;
let scenario;
let authSessions;
let moderatorId;

function sessionAuthHeader(userId, sessionId) {
  return `Bearer ${signAccessToken(userId, { secret: JWT_SECRET, sessionId })}`;
}

async function createSession(userId) {
  const sessionId = crypto.randomUUID();
  await db.query(
    `INSERT INTO auth_sessions
       (id, family_id, user_id, refresh_token_hash, expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, now() + INTERVAL '1 hour', now() + INTERVAL '1 day')`,
    [
      sessionId,
      crypto.randomUUID(),
      userId,
      crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
    ]
  );
  authSessions.push(sessionId);
  return sessionId;
}

async function createStepUpGrant(userId, sessionId) {
  const grant = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO step_up_grants (token_hash, user_id, session_id, action, expires_at)
     VALUES ($1, $2, $3, 'refund.decide', now() + INTERVAL '5 minutes')`,
    [
      crypto.createHash('sha256').update(grant).digest('hex'),
      userId,
      sessionId,
    ]
  );
  return grant;
}

function buyerFile(body = { reason: 'The item is not as described.' }, buyerId = scenario.buyerId) {
  return httpRequest(getApp())
    .post(`/api/returns/orders/${scenario.orderId}`)
    .set('Authorization', authHeader(buyerId))
    .send(body);
}

function adminDecision(returnId, userId, sessionId, body) {
  return httpRequest(getApp())
    .post(`/api/admin/returns/${returnId}/decide`)
    .set('Authorization', sessionAuthHeader(userId, sessionId))
    .send(body);
}

async function deliverScenario(target = scenario) {
  await db.query(
    `UPDATE orders
     SET status = 'handed_to_delivery', handed_over_at = now()
     WHERE id = $1`,
    [target.orderId]
  );
  await adminDeliveredRequest(harness, target, { note: 'Delivered for return test' }).expect(200);
}

async function createReturn(target = scenario) {
  return httpRequest(getApp())
    .post(`/api/returns/orders/${target.orderId}`)
    .set('Authorization', authHeader(target.buyerId))
    .send({ reason: 'The item is not as described.' })
    .expect(201);
}

async function insertInitiatedPayout() {
  const { rows } = await db.query(
    `INSERT INTO seller_payouts
       (order_id, seller_id, attempt, status, amount, currency, initiated_by)
     VALUES ($1, $2, 1, 'initiated', '5.00', 'PKR', $3)
     RETURNING id`,
    [scenario.orderId, scenario.sellerId, harness.adminId]
  );
  return rows[0].id;
}

async function insertPaidPayout() {
  const { rows } = await db.query(
    `INSERT INTO seller_payouts
       (order_id, seller_id, attempt, status, amount, currency, initiated_by,
        method, transfer_reference, paid_on, paid_by, paid_at)
     VALUES ($1, $2, 1, 'paid', '5.00', 'PKR', $3,
             'bank', 'RETURN-TEST-TRANSFER', DATE '2024-01-01', $3, now())
     RETURNING id`,
    [scenario.orderId, scenario.sellerId, harness.adminId]
  );
  await db.query(
    `INSERT INTO ledger_entries
       (order_id, payment_id, currency, amount, entry_type, idempotency_key)
     VALUES ($1, $2, 'PKR', '-5.00', 'seller_payout_manual', $3)`,
    [scenario.orderId, scenario.paymentId, `seller_payout_manual:${scenario.orderId}`]
  );
  return rows[0].id;
}

async function resetAndCleanupScenario() {
  if (!scenario) return;
  await global.drainIntegrationListeners(5000);
  const { rows: auditRows } = await db.query(
    'SELECT EXISTS (SELECT 1 FROM money_audit_events WHERE order_id = $1) AS retained',
    [scenario.orderId]
  );
  if (!auditRows[0].retained) {
    await db.query(
      `DELETE FROM dispute_evidence
       WHERE dispute_id IN (SELECT id FROM disputes WHERE order_id = $1)`,
      [scenario.orderId]
    );
    await db.query('DELETE FROM return_requests WHERE order_id = $1', [scenario.orderId]);
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
  authSessions = [];
}

beforeAll(async () => {
  harness = await createHarness();
});

beforeEach(async () => {
  authSessions = [];
  scenario = await createScenario(harness);
  await deliverScenario();
});

afterEach(async () => {
  await resetAndCleanupScenario();
});

describe('FR-43, FR-56 returns', () => {
  test('FR-43, FR-56: seller and buyer reads select the latest return request', async () => {
    await db.query(
      `INSERT INTO return_requests
         (id, order_id, buyer_id, reason, status, decided_by, decision_note, decided_at, created_at)
       VALUES
         ($1, $2, $3, 'Older return reason', 'rejected', $5, 'Older return decision',
          now() - INTERVAL '2 hours', now() - INTERVAL '2 hours'),
         ($4, $2, $3, 'Latest return reason', 'requested', NULL, NULL, NULL,
          now() - INTERVAL '1 hour')`,
      [
        crypto.randomUUID(), scenario.orderId, scenario.buyerId,
        crypto.randomUUID(),
        harness.adminId,
      ]
    );
    const seller = await httpRequest(getApp())
      .get(`/api/orders/selling/${scenario.orderId}`)
      .set('Authorization', authHeader(scenario.sellerId))
      .expect(200);
    const buyer = await httpRequest(getApp())
      .get(`/api/orders/${scenario.orderId}/summary`)
      .set('Authorization', authHeader(scenario.buyerId))
      .expect(200);
    expect(seller.body.returnRequest.reason).toBe('Latest return reason');
    expect(buyer.body.returnRequest.reason).toBe('Latest return reason');
    await db.query('DELETE FROM return_requests WHERE order_id = $1', [scenario.orderId]);
  });
  test('FR-43: a delivered buyer can file one return, pauses payout, and buyer/seller reads hide Admin identity', async () => {
    const filed = await createReturn();
    expect(filed.body).toMatchObject({
      orderId: scenario.orderId,
      reason: 'The item is not as described.',
      status: 'requested',
    });
    const { rows: holdRows } = await db.query(
      'SELECT state FROM payout_holds WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(holdRows).toEqual([{ state: 'paused_for_dispute' }]);

    const buyerSummary = await httpRequest(getApp())
      .get(`/api/orders/${scenario.orderId}/summary`)
      .set('Authorization', authHeader(scenario.buyerId))
      .expect(200);
    const sellerOrder = await httpRequest(getApp())
      .get(`/api/orders/selling/${scenario.orderId}`)
      .set('Authorization', authHeader(scenario.sellerId))
      .expect(200);
    expect(buyerSummary.body.returnRequest).toMatchObject({
      status: 'requested',
      outcome: null,
      id: filed.body.returnId,
      reason: 'The item is not as described.',
      sellerNote: null,
      createdAt: expect.any(String),
      respondedAt: null,
      decidedAt: null,
    });
    expect(sellerOrder.body).toMatchObject({
      returnStatus: 'requested',
      returnOutcome: null,
      returnRequest: {
        id: filed.body.returnId,
        status: 'requested',
        outcome: null,
        reason: 'The item is not as described.',
        sellerNote: null,
        createdAt: expect.any(String),
        respondedAt: null,
        decidedAt: null,
      },
    });
    expect(JSON.stringify([buyerSummary.body.returnRequest, sellerOrder.body]))
      .not.toMatch(/decidedBy|decided_by|adminId|admin_id/i);
    expect(await payout.getDisputeHoldStatus(scenario.orderId)).toBe(true);

    const adminRecord = await httpRequest(getApp())
      .get('/api/admin/returns')
      .set('Authorization', authHeader(harness.adminId))
      .expect(200);
    expect(adminRecord.body.returnRequests).toEqual([
      expect.objectContaining({ returnId: filed.body.returnId, orderId: scenario.orderId }),
    ]);
  });

  test('FR-43: the complaint window includes its Asia/Karachi business-date boundary and rejects the next date', async () => {
    const businessDate = await sellerPayouts.getBusinessDate(db);
    await db.query(
      `UPDATE payout_holds SET complaint_window_days = 3 WHERE order_id = $1`,
      [scenario.orderId]
    );
    await db.query(
      `UPDATE orders
       SET delivered_at = (($1::date - 3)::timestamp + time '12:00')
                          AT TIME ZONE 'Asia/Karachi'
       WHERE id = $2`,
      [businessDate, scenario.orderId]
    );
    await buyerFile().expect(201);
    await db.query('DELETE FROM return_requests WHERE order_id = $1', [scenario.orderId]);
    await db.query(
      `UPDATE payout_holds SET state = 'held', state_before_pause = NULL WHERE order_id = $1`,
      [scenario.orderId]
    );
    await db.query(
      `UPDATE orders
       SET delivered_at = (($1::date - 4)::timestamp + time '12:00')
                          AT TIME ZONE 'Asia/Karachi'
       WHERE id = $2`,
      [businessDate, scenario.orderId]
    );
    const closed = await buyerFile();
    expect(closed.status).toBe(409);
    expect(closed.body.error).toMatch(/complaint window has closed/i);
  });

  test('FR-43: non-buyers receive 403 and an open dispute/return blocks the other case with 409', async () => {
    await buyerFile(undefined, harness.unrelatedBuyerId).expect(403);
    await httpRequest(getApp())
      .post(`/api/disputes/orders/${scenario.orderId}`)
      .set('Authorization', authHeader(scenario.buyerId))
      .send(OPEN_DISPUTE_BODY)
      .expect(201);
    const returnWhileDisputed = await buyerFile();
    expect(returnWhileDisputed.status).toBe(409);
    expect(returnWhileDisputed.body.error).toMatch(/open dispute already exists/i);

    await db.query(
      `UPDATE payout_holds SET state = 'held', state_before_pause = NULL, dispute_id = NULL
       WHERE order_id = $1`,
      [scenario.orderId]
    );
    await db.query(
      `DELETE FROM dispute_evidence
       WHERE dispute_id IN (SELECT id FROM disputes WHERE order_id = $1)`,
      [scenario.orderId]
    );
    await db.query('DELETE FROM disputes WHERE order_id = $1', [scenario.orderId]);
    await createReturn();
    const disputeWhileReturning = await httpRequest(getApp())
      .post(`/api/disputes/orders/${scenario.orderId}`)
      .set('Authorization', authHeader(scenario.buyerId))
      .send(OPEN_DISPUTE_BODY);
    expect(disputeWhileReturning.status).toBe(409);
    expect(disputeWhileReturning.body.error).toMatch(/open return request already exists/i);
  });

  test('FR-43: seller can respond once and the response is visible without Admin identity', async () => {
    const filed = await createReturn();
    const wrongSeller = await httpRequest(getApp())
      .post(`/api/returns/${filed.body.returnId}/respond`)
      .set('Authorization', authHeader(harness.unrelatedBuyerId))
      .send({ sellerNote: 'I disagree with the return reason.' });
    expect(wrongSeller.status).toBe(403);

    const response = await httpRequest(getApp())
      .post(`/api/returns/${filed.body.returnId}/respond`)
      .set('Authorization', authHeader(scenario.sellerId))
      .send({ sellerNote: 'I disagree with the return reason.' })
      .expect(200);
    expect(response.body).toMatchObject({
      returnId: filed.body.returnId,
      status: 'seller_responded',
      sellerNote: 'I disagree with the return reason.',
    });
    const buyerAfterResponse = await httpRequest(getApp())
      .get(`/api/orders/${scenario.orderId}/summary`)
      .set('Authorization', authHeader(scenario.buyerId))
      .expect(200);
    expect(buyerAfterResponse.body.returnRequest).toMatchObject({
      status: 'seller_responded',
      reason: 'The item is not as described.',
      sellerNote: 'I disagree with the return reason.',
      respondedAt: expect.any(String),
    });
    const secondResponse = await httpRequest(getApp())
      .post(`/api/returns/${filed.body.returnId}/respond`)
      .set('Authorization', authHeader(scenario.sellerId))
      .send({ sellerNote: 'A second seller response is not allowed.' });
    expect(secondResponse.status).toBe(409);
  });

  test('FR-43, FR-56: approve_refund returns exact item decimals only unless sellerAtFault includes delivery', async () => {
    const first = await createReturn();
    const sessionId = await createSession(harness.adminId);
    const itemOnly = await adminDecision(first.body.returnId, harness.adminId, sessionId, {
      decision: 'approve_refund',
      decisionNote: 'Refund the item price after review.',
      stepUpGrant: await createStepUpGrant(harness.adminId, sessionId),
    }).expect(200);
    expect(itemOnly.body.refund).toMatchObject({
      amount: '1250.50',
      itemAmount: '1250.50',
      deliveryFeeAmount: '0.00',
      sellerAtFault: false,
    });
    expect(itemOnly.body.outcome).toBe('approve_refund');

    await db.query('DELETE FROM return_requests WHERE order_id = $1', [scenario.orderId]);
    await db.query(
      `UPDATE payout_holds SET state = 'held', state_before_pause = NULL WHERE order_id = $1`,
      [scenario.orderId]
    );
    const second = await createReturn();
    const sellerFault = await adminDecision(second.body.returnId, harness.adminId, sessionId, {
      decision: 'approve_refund',
      decisionNote: 'Seller fault includes the delivery fee.',
      sellerAtFault: true,
      stepUpGrant: await createStepUpGrant(harness.adminId, sessionId),
    }).expect(200);
    expect(sellerFault.body.refund).toMatchObject({
      amount: '300.00',
      itemAmount: '0.00',
      deliveryFeeAmount: '300.00',
      sellerAtFault: true,
    });
    expect(sellerFault.body.refund).not.toHaveProperty('approvedBy');
  });

  test('FR-43, FR-56: reject clears the shared payout hold without failing an initiated payout', async () => {
    const initiatedPayoutId = await insertInitiatedPayout();
    const filed = await createReturn();
    const sessionId = await createSession(harness.adminId);
    const result = await adminDecision(filed.body.returnId, harness.adminId, sessionId, {
      decision: 'reject',
      decisionNote: 'The evidence does not support a return.',
      stepUpGrant: await createStepUpGrant(harness.adminId, sessionId),
    }).expect(200);
    expect(result.body).toMatchObject({ status: 'rejected', outcome: 'reject', refund: null });
    const { rows: payoutRows } = await db.query(
      'SELECT status FROM seller_payouts WHERE id = $1',
      [initiatedPayoutId]
    );
    expect(payoutRows).toEqual([{ status: 'initiated' }]);
    expect(await payout.getDisputeHoldStatus(scenario.orderId)).toBe(false);
    const { rows: holdRows } = await db.query(
      'SELECT state FROM payout_holds WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(holdRows).toEqual([{ state: 'held' }]);
  });

  test('FR-43, FR-56: approval fails an initiated payout with return_decision', async () => {
    const payoutId = await insertInitiatedPayout();
    const filed = await createReturn();
    const sessionId = await createSession(harness.adminId);
    await adminDecision(filed.body.returnId, harness.adminId, sessionId, {
      decision: 'approve_refund',
      decisionNote: 'Approve the buyer return refund.',
      stepUpGrant: await createStepUpGrant(harness.adminId, sessionId),
    }).expect(200);
    const { rows } = await db.query(
      'SELECT status, failure_reason FROM seller_payouts WHERE id = $1',
      [payoutId]
    );
    expect(rows).toEqual([{ status: 'failed', failure_reason: 'return_decision' }]);
  });

  test('FR-43, FR-56: paid payouts are untouched and approval writes return_after_payout audit', async () => {
    const payoutId = await insertPaidPayout();
    const { rows: beforeLedger } = await db.query(
      'SELECT id, entry_type, amount::text FROM ledger_entries WHERE order_id = $1 ORDER BY id',
      [scenario.orderId]
    );
    const filed = await createReturn();
    const sessionId = await createSession(harness.adminId);
    const response = await adminDecision(filed.body.returnId, harness.adminId, sessionId, {
      decision: 'approve_refund',
      decisionNote: 'Approve after the payout was already paid.',
      stepUpGrant: await createStepUpGrant(harness.adminId, sessionId),
    }).expect(200);
    const { rows: payoutRows } = await db.query(
      'SELECT status, failure_reason FROM seller_payouts WHERE id = $1',
      [payoutId]
    );
    const { rows: afterLedger } = await db.query(
      'SELECT id, entry_type, amount::text FROM ledger_entries WHERE order_id = $1 ORDER BY id',
      [scenario.orderId]
    );
    const { rows: auditRows } = await db.query(
      `SELECT action FROM money_audit_events
       WHERE order_id = $1 AND action = 'return_after_payout'`,
      [scenario.orderId]
    );
    expect(payoutRows).toEqual([{ status: 'paid', failure_reason: null }]);
    expect(afterLedger).toEqual(beforeLedger);
    expect(auditRows).toEqual([{ action: 'return_after_payout' }]);
    expect(response.body.payoutAfterPayment).toBe(true);
  });

  test('FR-43, FR-56: refund failure rolls back the decision, payout change, and consumed step-up grant', async () => {
    const payoutId = await insertInitiatedPayout();
    const filed = await createReturn();
    const sessionId = await createSession(harness.adminId);
    const grant = await createStepUpGrant(harness.adminId, sessionId);
    const tokenHash = crypto.createHash('sha256').update(grant).digest('hex');
    const suffix = crypto.randomUUID().replace(/-/g, '');
    const triggerName = `return_refund_failure_${suffix}`;
    const functionName = `return_refund_failure_fn_${suffix}`;
    await db.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.trigger = 'return_admin' THEN
           RAISE EXCEPTION 'injected return refund failure';
         END IF;
         RETURN NEW;
       END $$`
    );
    await db.query(
      `CREATE TRIGGER ${triggerName} BEFORE INSERT ON refunds
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`
    );
    try {
      await adminDecision(filed.body.returnId, harness.adminId, sessionId, {
        decision: 'approve_refund',
        decisionNote: 'Refund creation failure must roll back.',
        stepUpGrant: grant,
      }).expect(500);
    } finally {
      await db.query(`DROP TRIGGER ${triggerName} ON refunds`);
      await db.query(`DROP FUNCTION ${functionName}()`);
    }
    const { rows: requestRows } = await db.query(
      'SELECT status, decided_by FROM return_requests WHERE id = $1',
      [filed.body.returnId]
    );
    const { rows: payoutRows } = await db.query(
      'SELECT status FROM seller_payouts WHERE id = $1',
      [payoutId]
    );
    const { rows: grantRows } = await db.query(
      'SELECT consumed_at FROM step_up_grants WHERE token_hash = $1',
      [tokenHash]
    );
    expect(requestRows).toEqual([{ status: 'requested', decided_by: null }]);
    expect(payoutRows).toEqual([{ status: 'initiated' }]);
    expect(grantRows).toEqual([{ consumed_at: null }]);
  });

  test('FR-43, FR-56: duplicate and concurrent decisions have one winner', async () => {
    const filed = await createReturn();
    const sessionId = await createSession(harness.adminId);
    const decision = (stepUpGrant) => adminDecision(
      filed.body.returnId,
      harness.adminId,
      sessionId,
      {
        decision: 'reject',
        decisionNote: 'Reject the duplicate return decision.',
        stepUpGrant,
      }
    );
    const firstPair = await Promise.all([
      decision(await createStepUpGrant(harness.adminId, sessionId)),
      decision(await createStepUpGrant(harness.adminId, sessionId)),
    ]);
    expect(firstPair.filter((response) => response.status === 200)).toHaveLength(1);
    expect(firstPair.filter((response) => response.status === 409)).toHaveLength(1);
    const second = await decision(await createStepUpGrant(harness.adminId, sessionId));
    expect(second.status).toBe(409);
  });

  test('FR-43, FR-56: Moderator and Admin without step-up cannot decide a return', async () => {
    const filed = await createReturn();
    const { rows } = await db.query(
      `INSERT INTO users (full_name, phone, password_hash, city_id, role)
       VALUES ($1, $2, 'return-test-hash', $3, 'moderator') RETURNING id`,
      [
        `Return moderator ${crypto.randomUUID()}`,
        `+1559${crypto.randomInt(0, 1_000_000_000).toString().padStart(9, '0')}`,
        harness.fixture.cityId,
      ]
    );
    moderatorId = rows[0].id;
    harness.extraUserIds.push(moderatorId);
    const moderator = await httpRequest(getApp())
      .post(`/api/admin/returns/${filed.body.returnId}/decide`)
      .set('Authorization', authHeader(rows[0].id))
      .send({ decision: 'reject', decisionNote: 'Moderator cannot decide.' });
    expect(moderator.status).toBe(403);

    const sessionId = await createSession(harness.adminId);
    const missingGrant = await adminDecision(filed.body.returnId, harness.adminId, sessionId, {
      decision: 'reject',
      decisionNote: 'A step-up grant is required.',
    });
    expect(missingGrant.status).toBe(403);
  });

  afterAll(async () => {
    if (moderatorId) await db.query('DELETE FROM users WHERE id = $1', [moderatorId]);
    await db.query('DELETE FROM supported_delivery_cities WHERE city_id = $1', [harness.fixture.cityId]);
    await cleanupHarness(harness);
    restoreHandoverTestEnvironment();
  });
});
