const crypto = require('crypto');
const {
  adminDeliveredRequest,
  authHeader,
  cleanupHarness,
  cleanupScenario,
  createHarness,
  createScenario,
  db,
  getBusinessDate,
  getApp,
  request,
  restoreHandoverTestEnvironment,
} = require('./delivery-handover.helpers');
const { signAccessToken } = require('../../src/lib/jwt');
const { getSharedRedisClient, setSharedRedisClient } = require('../../src/lib/redis');
const { decryptEmailPayload } = require('../../src/lib/emailQueuePayload');
const queue = require('../../src/lib/queue');
const events = require('../../src/lib/events');
const eventBus = require('../../src/lib/eventBus');
const notifications = require('../../src/modules/notifications.service');
const settlement = require('../../src/modules/settlement.service');

const JWT_SECRET = 'delivery-handover-integration-secret';

let harness;
let scenario;
let businessDate;
const dateBoundaryScenarios = [];

const TEST_TIME_ZONES = Object.freeze([
  'America/Los_Angeles',
  'UTC',
  'Asia/Karachi',
]);

function adminAuthHeader(adminId, sessionId) {
  return `Bearer ${signAccessToken(adminId, { secret: JWT_SECRET, sessionId })}`;
}

async function createAdminSession(adminId) {
  const sessionId = crypto.randomUUID();
  await db.query(
    `INSERT INTO auth_sessions (id, family_id, user_id, refresh_token_hash, expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 hour', now() + interval '1 day')`,
    [sessionId, crypto.randomUUID(), adminId, crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex')]
  );
  return sessionId;
}

async function withDatabaseTimeZone(timeZone, callback) {
  const originalWithTransaction = db.withTransaction;
  db.withTransaction = (transactionCallback) => originalWithTransaction(async (client) => {
    const { rows } = await client.query('SHOW TIME ZONE');
    const previousTimeZone = Object.values(rows[0])[0];
    await client.query(`SET TIME ZONE '${timeZone}'`);
    try {
      const { rows: timeZoneRows } = await client.query('SHOW TIME ZONE');
      expect(Object.values(timeZoneRows[0])[0]).toBe(timeZone);
      return await transactionCallback(client);
    } finally {
      const safePreviousTimeZone = String(previousTimeZone).replace(/'/g, "''");
      await client.query(`SET TIME ZONE '${safePreviousTimeZone}'`);
      const { rows: restoredRows } = await client.query('SHOW TIME ZONE');
      expect(Object.values(restoredRows[0])[0]).toBe(previousTimeZone);
    }
  });
  try {
    return await callback();
  } finally {
    db.withTransaction = originalWithTransaction;
  }
}

function offsetDate(date, offsetDays) {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + offsetDays);
  return result.toISOString().slice(0, 10);
}

async function insertStepUpGrant(userId, sessionId, action = 'payout.record') {
  const grant = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO step_up_grants (token_hash, user_id, session_id, action, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '5 minutes')`,
    [crypto.createHash('sha256').update(grant).digest('hex'), userId, sessionId, action]
  );
  return grant;
}

async function deliverScenario(target) {
  await db.query(
    `UPDATE orders
     SET status = 'handed_to_delivery', handed_over_at = now() - INTERVAL '5 minutes'
     WHERE id = $1`,
    [target.orderId]
  );
  await adminDeliveredRequest(harness, target, { note: 'Delivered for payout integration test' }).expect(200);
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

function releasePayout(orderId, adminId, body = { note: 'Manual release' }) {
  return request(getApp())
    .post(`/api/admin/orders/${orderId}/payout/release`)
    .set('Authorization', authHeader(adminId))
    .send(body);
}

beforeAll(async () => {
  harness = await createHarness();
  businessDate = await getBusinessDate();
});

beforeEach(async () => {
  scenario = await createScenario(harness);
  await deliverScenario(scenario);
  await elapsePayoutWindows(scenario);
});

afterEach(async () => {
  await global.drainIntegrationListeners(5000);
  for (const target of dateBoundaryScenarios.splice(0)) {
    await cleanupScenario(harness, target);
  }
  if (scenario) {
    await cleanupScenario(harness, scenario);
  }
});

afterAll(async () => {
  await cleanupHarness(harness);
  restoreHandoverTestEnvironment();
});

describe('seller payouts lifecycle integration', () => {
  test.each(TEST_TIME_ZONES)(
    'FR-48: paid-date bounds use the Asia/Karachi calendar in %s database sessions',
    async (timeZone) => {
      const targets = [scenario];
      for (let index = 1; index < 3; index += 1) {
        const target = await createScenario(harness);
        dateBoundaryScenarios.push(target);
        await deliverScenario(target);
        await elapsePayoutWindows(target);
        targets.push(target);
      }

      const sessionId = await createAdminSession(harness.adminId);
      for (const [index, paidOn] of [
        offsetDate(businessDate, -1),
        businessDate,
        offsetDate(businessDate, -90),
      ].entries()) {
        const target = targets[index];
        const payoutResponse = await releasePayout(target.orderId, harness.adminId, {
          note: `Karachi date-boundary payout ${timeZone} ${index}`,
        }).expect(200);
        const grant = await insertStepUpGrant(harness.adminId, sessionId, 'payout.record');
        const paidRequest = (date, transferReference) => request(getApp())
          .post(`/api/admin/seller-payouts/${payoutResponse.body.payout.id}/paid`)
          .set('Authorization', adminAuthHeader(harness.adminId, sessionId))
          .send({ method: 'bank', transferReference, paidOn: date, stepUpGrant: grant });

        if (index === 0) {
          for (const rejectedDate of [
            offsetDate(businessDate, 1),
            offsetDate(businessDate, -91),
          ]) {
            const response = await withDatabaseTimeZone(timeZone, () =>
              paidRequest(rejectedDate, `REJECT-${timeZone}-${rejectedDate}`)
            );
            expect(response.status).toBe(400);
          }
        }

        const response = await withDatabaseTimeZone(timeZone, () =>
          paidRequest(paidOn, `ACCEPT-${timeZone}-${index}`)
        );
        expect(response.status).toBe(200);
        expect(response.body.paidOn).toBe(paidOn);
      }
    }
  );

  test('FR-48, FR-65: release creates one initiated payout for the settlement net and writes no ledger entry', async () => {
    const res = await releasePayout(scenario.orderId, harness.adminId, {
      note: 'Release for payout test',
    }).expect(200);

    expect(res.body.status).toBe('completed');
    expect(res.body.payout).toMatchObject({
      id: expect.any(String),
      status: 'initiated',
      attempt: 1,
      amount: expect.any(String),
      sellerNetAmount: expect.any(String),
      commissionAmount: expect.any(String),
      currency: 'PKR',
    });
    expect(Number(res.body.payout.amount)).toBeGreaterThan(0);

    const { rows: ledgerRows } = await db.query(
      'SELECT id, entry_type FROM ledger_entries WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(ledgerRows).toHaveLength(0);

    const { rows: payoutRows } = await db.query(
      'SELECT id, order_id, seller_id, attempt, status, amount::text, currency, initiated_by FROM seller_payouts WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(payoutRows).toHaveLength(1);
    expect(payoutRows[0]).toEqual({
      id: res.body.payout.id,
      order_id: scenario.orderId,
      seller_id: scenario.sellerId,
      attempt: 1,
      status: 'initiated',
      amount: res.body.payout.amount,
      currency: 'PKR',
      initiated_by: harness.adminId,
    });
  });

  test('FR-48: a net of zero creates no payout', async () => {
    const { rows: paymentRows } = await db.query(
      'SELECT id, currency FROM payments WHERE order_id = $1',
      [scenario.orderId]
    );
    const payment = paymentRows[0];
    const { rows: resRows } = await db.query(
      'SELECT item_price_snapshot FROM reservations WHERE id = $1',
      [scenario.reservationId]
    );
    const itemPrice = resRows[0].item_price_snapshot;

    await db.query(
      `INSERT INTO refunds (payment_id, order_id, trigger, amount, currency, status, idempotency_key)
       VALUES ($1, $2, 'system_cancel', $3::numeric, $4, 'succeeded', $5)`,
      [payment.id, scenario.orderId, itemPrice, payment.currency, `refund:${scenario.orderId}:zero-net-test`]
    );

    const res = await releasePayout(scenario.orderId, harness.adminId, {
      note: 'Release zero net payout',
    }).expect(200);

    expect(res.body.payout.id).toBeUndefined();
    expect(res.body.payout.sellerNetAmount).toBe('0.00');

    const { rows: payoutRows } = await db.query(
      'SELECT * FROM seller_payouts WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(payoutRows).toHaveLength(0);

    const { rows: ledgerRows } = await db.query(
      'SELECT * FROM ledger_entries WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(ledgerRows).toHaveLength(0);
  });

  test('FR-48, FR-49: marking paid records method, reference and date, writes exactly one negative seller_payout_manual entry and one audit event', async () => {
    const releaseRes = await releasePayout(scenario.orderId, harness.adminId, {
      note: 'Release for mark paid test',
    }).expect(200);
    const payoutId = releaseRes.body.payout.id;

    const sessionId = await createAdminSession(harness.adminId);
    const grant = await insertStepUpGrant(harness.adminId, sessionId, 'payout.record');

    const paidOnDate = businessDate;
    const paidRes = await request(getApp())
      .post(`/api/admin/seller-payouts/${payoutId}/paid`)
      .set('Authorization', adminAuthHeader(harness.adminId, sessionId))
      .send({
        method: 'bank',
        transferReference: 'TRF-BANK-12345',
        paidOn: paidOnDate,
        note: 'Settled via Meezan Bank transfer',
        stepUpGrant: grant,
      })
      .expect(200);

    expect(paidRes.body).toMatchObject({
      id: payoutId,
      orderId: scenario.orderId,
      sellerId: scenario.sellerId,
      attempt: 1,
      status: 'paid',
      method: 'bank',
      transferReference: 'TRF-BANK-12345',
      paidOn: paidOnDate,
      paidBy: harness.adminId,
    });
    expect(paidRes.body.paidAt).toBeTruthy();

    const { rows: ledgerRows } = await db.query(
      'SELECT order_id, currency, amount::text, entry_type, idempotency_key FROM ledger_entries WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toEqual({
      order_id: scenario.orderId,
      currency: 'PKR',
      amount: `-${releaseRes.body.payout.amount}`,
      entry_type: 'seller_payout_manual',
      idempotency_key: `seller_payout_manual:${scenario.orderId}`,
    });

    const { rows: auditRows } = await db.query(
      'SELECT actor_id, action, order_id, reason, metadata FROM money_audit_events WHERE order_id = $1 AND action = $2',
      [scenario.orderId, 'seller_payout_paid']
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actor_id: harness.adminId,
      action: 'seller_payout_paid',
      order_id: scenario.orderId,
      reason: 'Settled via Meezan Bank transfer',
      metadata: {
        payoutId,
        attempt: 1,
        amount: releaseRes.body.payout.amount,
        currency: 'PKR',
        method: 'bank',
        transferReference: 'TRF-BANK-12345',
        paidOn: paidOnDate,
      },
    });
  });

  test('FR-48: ten parallel paid requests produce one 200 and one ledger entry; paid versus failed races have exactly one winner', async () => {
    // Part A: ten parallel paid requests
    const releaseRes1 = await releasePayout(scenario.orderId, harness.adminId, {
      note: 'Release for parallel paid test',
    }).expect(200);
    const payoutId1 = releaseRes1.body.payout.id;

    const parallelPaidCalls = await Promise.all(
      Array.from({ length: 10 }, async (_, index) => {
        const sid = await createAdminSession(harness.adminId);
        const g = await insertStepUpGrant(harness.adminId, sid, 'payout.record');
        return request(getApp())
          .post(`/api/admin/seller-payouts/${payoutId1}/paid`)
          .set('Authorization', adminAuthHeader(harness.adminId, sid))
          .send({
            method: 'jazzcash',
            transferReference: `JC-REF-${index}`,
            paidOn: businessDate,
            stepUpGrant: g,
          });
      })
    );

    const paidSuccesses = parallelPaidCalls.filter((r) => r.status === 200);
    const paidConflicts = parallelPaidCalls.filter((r) => r.status === 409);
    expect(paidSuccesses).toHaveLength(1);
    expect(paidConflicts).toHaveLength(9);

    const { rows: ledgerRows1 } = await db.query(
      'SELECT * FROM ledger_entries WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(ledgerRows1).toHaveLength(1);

    // Part B: paid vs failed race
    const target = await createScenario(harness);
    try {
      await deliverScenario(target);
      await elapsePayoutWindows(target);

      const releaseRes2 = await releasePayout(target.orderId, harness.adminId, {
        note: 'Release for race test',
      }).expect(200);
      const payoutId2 = releaseRes2.body.payout.id;

      const sidPaid = await createAdminSession(harness.adminId);
      const gPaid = await insertStepUpGrant(harness.adminId, sidPaid, 'payout.record');
      const sidFailed = await createAdminSession(harness.adminId);
      const gFailed = await insertStepUpGrant(harness.adminId, sidFailed, 'payout.record');

      const [paidRaceRes, failedRaceRes] = await Promise.all([
        request(getApp())
          .post(`/api/admin/seller-payouts/${payoutId2}/paid`)
          .set('Authorization', adminAuthHeader(harness.adminId, sidPaid))
          .send({
            method: 'easypaisa',
            transferReference: 'EP-RACE-REF',
            paidOn: businessDate,
            stepUpGrant: gPaid,
          }),
        request(getApp())
          .post(`/api/admin/seller-payouts/${payoutId2}/failed`)
          .set('Authorization', adminAuthHeader(harness.adminId, sidFailed))
          .send({
            reason: 'Account frozen during race',
            stepUpGrant: gFailed,
          }),
      ]);

      const statuses = [paidRaceRes.status, failedRaceRes.status].sort();
      expect(statuses).toEqual([200, 409]);

      const { rows: payoutRows2 } = await db.query(
        'SELECT status FROM seller_payouts WHERE id = $1',
        [payoutId2]
      );
      if (paidRaceRes.status === 200) {
        expect(payoutRows2[0].status).toBe('paid');
        const { rows: ledger2 } = await db.query(
          'SELECT * FROM ledger_entries WHERE order_id = $1',
          [target.orderId]
        );
        expect(ledger2).toHaveLength(1);
      } else {
        expect(payoutRows2[0].status).toBe('failed');
        const { rows: ledger2 } = await db.query(
          'SELECT * FROM ledger_entries WHERE order_id = $1',
          [target.orderId]
        );
        expect(ledger2).toHaveLength(0);
      }
    } finally {
      await cleanupScenario(harness, target);
    }
  });

  test('FR-48: validation rejects bad method, short reference, future or older-than-90-day date, empty failure reason, with nothing written', async () => {
    const releaseRes = await releasePayout(scenario.orderId, harness.adminId, {
      note: 'Release for validation test',
    }).expect(200);
    const payoutId = releaseRes.body.payout.id;

    const sid = await createAdminSession(harness.adminId);
    const g1 = await insertStepUpGrant(harness.adminId, sid, 'payout.record');
    const g2 = await insertStepUpGrant(harness.adminId, sid, 'payout.record');
    const g3 = await insertStepUpGrant(harness.adminId, sid, 'payout.record');
    const g4 = await insertStepUpGrant(harness.adminId, sid, 'payout.record');
    const g5 = await insertStepUpGrant(harness.adminId, sid, 'payout.record');

    // Bad method
    await request(getApp())
      .post(`/api/admin/seller-payouts/${payoutId}/paid`)
      .set('Authorization', adminAuthHeader(harness.adminId, sid))
      .send({
        method: 'crypto',
        transferReference: 'VALID-REF-123',
        paidOn: businessDate,
        stepUpGrant: g1,
      })
      .expect(400);

    // Short reference
    await request(getApp())
      .post(`/api/admin/seller-payouts/${payoutId}/paid`)
      .set('Authorization', adminAuthHeader(harness.adminId, sid))
      .send({
        method: 'bank',
        transferReference: 'ab',
        paidOn: businessDate,
        stepUpGrant: g2,
      })
      .expect(400);

    // Future date
    await request(getApp())
      .post(`/api/admin/seller-payouts/${payoutId}/paid`)
      .set('Authorization', adminAuthHeader(harness.adminId, sid))
      .send({
        method: 'bank',
        transferReference: 'VALID-REF-123',
        paidOn: '2030-01-01',
        stepUpGrant: g3,
      })
      .expect(400);

    // Older than 90 days date
    await request(getApp())
      .post(`/api/admin/seller-payouts/${payoutId}/paid`)
      .set('Authorization', adminAuthHeader(harness.adminId, sid))
      .send({
        method: 'bank',
        transferReference: 'VALID-REF-123',
        paidOn: '2020-01-01',
        stepUpGrant: g4,
      })
      .expect(400);

    // Empty failure reason
    await request(getApp())
      .post(`/api/admin/seller-payouts/${payoutId}/failed`)
      .set('Authorization', adminAuthHeader(harness.adminId, sid))
      .send({
        reason: '   ',
        stepUpGrant: g5,
      })
      .expect(400);

    // Verify nothing written
    const { rows: payoutRows } = await db.query(
      'SELECT status, method, transfer_reference, paid_at, failure_reason FROM seller_payouts WHERE id = $1',
      [payoutId]
    );
    expect(payoutRows[0]).toEqual({
      status: 'initiated',
      method: null,
      transfer_reference: null,
      paid_at: null,
      failure_reason: null,
    });

    const { rows: ledgerRows } = await db.query(
      'SELECT * FROM ledger_entries WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(ledgerRows).toHaveLength(0);

    const { rows: auditRows } = await db.query(
      'SELECT * FROM money_audit_events WHERE order_id = $1 AND action IN ($2, $3)',
      [scenario.orderId, 'seller_payout_paid', 'seller_payout_failed']
    );
    expect(auditRows).toHaveLength(0);
  });

  test('FR-48: failed creates no ledger entry, retry creates attempt 2 only after failed, and a paid payout cannot be failed or retried', async () => {
    const releaseRes = await releasePayout(scenario.orderId, harness.adminId, {
      note: 'Release for lifecycle test',
    }).expect(200);
    const payoutId1 = releaseRes.body.payout.id;

    const sid1 = await createAdminSession(harness.adminId);
    const gFail = await insertStepUpGrant(harness.adminId, sid1, 'payout.record');

    // Attempt 1: mark failed
    const failRes = await request(getApp())
      .post(`/api/admin/seller-payouts/${payoutId1}/failed`)
      .set('Authorization', adminAuthHeader(harness.adminId, sid1))
      .send({
        reason: 'Seller bank title does not match verified name.',
        stepUpGrant: gFail,
      })
      .expect(200);

    expect(failRes.body).toMatchObject({
      id: payoutId1,
      status: 'failed',
      failureReason: 'Seller bank title does not match verified name.',
      failedBy: harness.adminId,
    });

    const { rows: ledgerAfterFail } = await db.query(
      'SELECT * FROM ledger_entries WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(ledgerAfterFail).toHaveLength(0);

    // Cannot fail an already failed payout
    const gFailAgain = await insertStepUpGrant(harness.adminId, sid1, 'payout.record');
    await request(getApp())
      .post(`/api/admin/seller-payouts/${payoutId1}/failed`)
      .set('Authorization', adminAuthHeader(harness.adminId, sid1))
      .send({
        reason: 'Trying to fail again',
        stepUpGrant: gFailAgain,
      })
      .expect(409);

    // Retry payout creates attempt 2
    const gRetry = await insertStepUpGrant(harness.adminId, sid1, 'payout.record');
    const retryRes = await request(getApp())
      .post(`/api/admin/seller-payouts/${payoutId1}/retry`)
      .set('Authorization', adminAuthHeader(harness.adminId, sid1))
      .send({ stepUpGrant: gRetry })
      .expect(200);

    expect(retryRes.body).toMatchObject({
      orderId: scenario.orderId,
      sellerId: scenario.sellerId,
      attempt: 2,
      status: 'initiated',
      amount: releaseRes.body.payout.amount,
      currency: 'PKR',
      initiatedBy: harness.adminId,
    });
    const payoutId2 = retryRes.body.id;
    expect(payoutId2).not.toBe(payoutId1);

    // While attempt 2 is initiated, retrying attempt 1 is rejected (sibling active)
    const gRetrySibling = await insertStepUpGrant(harness.adminId, sid1, 'payout.record');
    await request(getApp())
      .post(`/api/admin/seller-payouts/${payoutId1}/retry`)
      .set('Authorization', adminAuthHeader(harness.adminId, sid1))
      .send({ stepUpGrant: gRetrySibling })
      .expect(409);

    // Mark attempt 2 as paid
    const gPaid = await insertStepUpGrant(harness.adminId, sid1, 'payout.record');
    await request(getApp())
      .post(`/api/admin/seller-payouts/${payoutId2}/paid`)
      .set('Authorization', adminAuthHeader(harness.adminId, sid1))
      .send({
        method: 'easypaisa',
        transferReference: 'EP-RETRY-PAID-1',
        paidOn: businessDate,
        stepUpGrant: gPaid,
      })
      .expect(200);

    // A paid payout cannot be failed or retried
    const gFailPaid = await insertStepUpGrant(harness.adminId, sid1, 'payout.record');
    await request(getApp())
      .post(`/api/admin/seller-payouts/${payoutId2}/failed`)
      .set('Authorization', adminAuthHeader(harness.adminId, sid1))
      .send({
        reason: 'Should not fail paid payout',
        stepUpGrant: gFailPaid,
      })
      .expect(409);

    const gRetryPaid = await insertStepUpGrant(harness.adminId, sid1, 'payout.record');
    await request(getApp())
      .post(`/api/admin/seller-payouts/${payoutId2}/retry`)
      .set('Authorization', adminAuthHeader(harness.adminId, sid1))
      .send({ stepUpGrant: gRetryPaid })
      .expect(409);
  });

  test('FR-65, SEC-35: Seller, Buyer, Moderator and anonymous callers cannot read or change payouts (403/401)', async () => {
    const releaseRes = await releasePayout(scenario.orderId, harness.adminId, {
      note: 'Release for auth checks',
    }).expect(200);
    const payoutId = releaseRes.body.payout.id;

    const callerTokens = [
      { role: 'seller', token: authHeader(scenario.sellerId), expected: 403 },
      { role: 'buyer', token: authHeader(scenario.buyerId), expected: 403 },
      { role: 'moderator', token: authHeader(harness.moderatorId), expected: 403 },
      { role: 'anonymous', token: null, expected: 401 },
    ];

    for (const { token, expected } of callerTokens) {
      const getList = request(getApp()).get('/api/admin/seller-payouts');
      if (token) getList.set('Authorization', token);
      await getList.expect(expected);

      const getDetail = request(getApp()).get(`/api/admin/seller-payouts/${payoutId}`);
      if (token) getDetail.set('Authorization', token);
      await getDetail.expect(expected);

      const postPaid = request(getApp())
        .post(`/api/admin/seller-payouts/${payoutId}/paid`)
        .send({ method: 'bank', transferReference: 'REF-123', paidOn: '2026-11-10' });
      if (token) postPaid.set('Authorization', token);
      await postPaid.expect(expected);

      const postFailed = request(getApp())
        .post(`/api/admin/seller-payouts/${payoutId}/failed`)
        .send({ reason: 'Unauthorized caller test' });
      if (token) postFailed.set('Authorization', token);
      await postFailed.expect(expected);

      const postRetry = request(getApp())
        .post(`/api/admin/seller-payouts/${payoutId}/retry`)
        .send({});
      if (token) postRetry.set('Authorization', token);
      await postRetry.expect(expected);
    }
  });

  test('FR-48: the step-up grant is required and a limiter 429 happens before the grant is consumed', async () => {
    const releaseRes = await releasePayout(scenario.orderId, harness.adminId, {
      note: 'Release for step-up test',
    }).expect(200);
    const payoutId = releaseRes.body.payout.id;

    const sid = await createAdminSession(harness.adminId);

    // Missing grant
    await request(getApp())
      .post(`/api/admin/seller-payouts/${payoutId}/paid`)
      .set('Authorization', adminAuthHeader(harness.adminId, sid))
      .send({
        method: 'bank',
        transferReference: 'REF-NO-GRANT',
        paidOn: businessDate,
      })
      .expect(403);

    // Wrong action grant
    const wrongActionGrant = await insertStepUpGrant(harness.adminId, sid, 'refund.decide');
    await request(getApp())
      .post(`/api/admin/seller-payouts/${payoutId}/paid`)
      .set('Authorization', adminAuthHeader(harness.adminId, sid))
      .send({
        method: 'bank',
        transferReference: 'REF-WRONG-GRANT',
        paidOn: businessDate,
        stepUpGrant: wrongActionGrant,
      })
      .expect(403);

    // Limiter 429 happens before grant is consumed
    const validGrant = await insertStepUpGrant(harness.adminId, sid, 'payout.record');
    const digest = crypto.createHash('sha256').update(validGrant).digest('hex');

    const originalClient = getSharedRedisClient();
    try {
      // Mock redis rate limiter eval to return exceeded quota (e.g. [10000, 10000])
      setSharedRedisClient({
        isOpen: true,
        eval: async () => [9999, 9999],
      });

      const limiterRes = await request(getApp())
        .post(`/api/admin/seller-payouts/${payoutId}/paid`)
        .set('Authorization', adminAuthHeader(harness.adminId, sid))
        .send({
          method: 'bank',
          transferReference: 'REF-LIMITER',
          paidOn: businessDate,
          stepUpGrant: validGrant,
        });

      expect(limiterRes.status).toBe(429);

      // Verify the grant was NOT consumed
      const { rows: grantRows } = await db.query(
        'SELECT consumed_at FROM step_up_grants WHERE token_hash = $1',
        [digest]
      );
      expect(grantRows[0].consumed_at).toBeNull();
    } finally {
      setSharedRedisClient(originalClient);
    }
  });

  test('FR-51, FR-48: paid and failed notify the seller once each, with no Admin identity or failure reason in the text', async () => {
    // 1. Test Paid notification
    const releaseRes1 = await releasePayout(scenario.orderId, harness.adminId, {
      note: 'Release for paid notif test',
    }).expect(200);
    const payoutId1 = releaseRes1.body.payout.id;

    const sid1 = await createAdminSession(harness.adminId);
    const gPaid = await insertStepUpGrant(harness.adminId, sid1, 'payout.record');

    await request(getApp())
      .post(`/api/admin/seller-payouts/${payoutId1}/paid`)
      .set('Authorization', adminAuthHeader(harness.adminId, sid1))
      .send({
        method: 'bank',
        transferReference: 'PAYOUT-NOTIF-REF',
        paidOn: businessDate,
        stepUpGrant: gPaid,
      })
      .expect(200);

    await global.drainIntegrationListeners(5000);

    // Process notification job
    const { rows: paidJobs } = await db.query(
      `SELECT id, data FROM pgboss.job
       WHERE name = $1 AND data->>'eventName' = $2 AND data->'payload'->>'payoutId' = $3`,
      [queue.QUEUES.NOTIFICATIONS, events.PAYOUT_PAID, payoutId1]
    );
    expect(paidJobs).toHaveLength(1);

    const transactionDb = {
      executeSql: (text, values = []) => transactionDb.client.query(text, values),
    };
    await db.withTransaction(async (client) => {
      transactionDb.client = client;
      await notifications.processNotificationJob(paidJobs[0].data, transactionDb);
    });
    // Processing again is duplicate-safe (once each)
    await db.withTransaction(async (client) => {
      transactionDb.client = client;
      await notifications.processNotificationJob(paidJobs[0].data, transactionDb);
    });

    const { rows: notifPaidRows } = await db.query(
      `SELECT event_type, payload FROM notifications
       WHERE user_id = $1 AND dedupe_key = $2`,
      [scenario.sellerId, `payout_paid:${payoutId1}`]
    );
    expect(notifPaidRows).toHaveLength(1);
    const paidMessage = notifPaidRows[0].payload.message;
    expect(paidMessage).toContain('bank');
    expect(paidMessage).toContain('PAYOUT-NOTIF-REF');
    expect(paidMessage).toContain(releaseRes1.body.payout.amount);
    expect(paidMessage).not.toContain(harness.adminId);

    // Check throttled email in queue
    const { rows: emailJobsPaid } = await db.query(
      `SELECT data FROM pgboss.job
       WHERE name = $1 AND singleton_key = $2`,
      [queue.QUEUES.EMAIL, `payout-email:${payoutId1}`]
    );
    if (emailJobsPaid.length > 0) {
      const decrypted = decryptEmailPayload(
        emailJobsPaid[0].data.encryptedPayload,
        process.env.EMAIL_QUEUE_ENCRYPTION_SECRET
      );
      expect(decrypted.text).toContain('bank');
      expect(decrypted.text).toContain('PAYOUT-NOTIF-REF');
      expect(decrypted.text).toContain(releaseRes1.body.payout.amount);
      expect(decrypted.text).not.toContain(harness.adminId);
    }

    // 2. Test Failed notification
    const target = await createScenario(harness);
    try {
      await deliverScenario(target);
      await elapsePayoutWindows(target);

      const releaseRes2 = await releasePayout(target.orderId, harness.adminId, {
        note: 'Release for failed notif test',
      }).expect(200);
      const payoutId2 = releaseRes2.body.payout.id;

      const sid2 = await createAdminSession(harness.adminId);
      const gFailed = await insertStepUpGrant(harness.adminId, sid2, 'payout.record');

      const failureSecretReason = 'Confidential bank rejection error code SEC-ERR-999';
      await request(getApp())
        .post(`/api/admin/seller-payouts/${payoutId2}/failed`)
        .set('Authorization', adminAuthHeader(harness.adminId, sid2))
        .send({
          reason: failureSecretReason,
          stepUpGrant: gFailed,
        })
        .expect(200);

      await global.drainIntegrationListeners(5000);

      const { rows: failedJobs } = await db.query(
        `SELECT id, data FROM pgboss.job
         WHERE name = $1 AND data->>'eventName' = $2 AND data->'payload'->>'payoutId' = $3`,
        [queue.QUEUES.NOTIFICATIONS, events.PAYOUT_FAILED, payoutId2]
      );
      expect(failedJobs).toHaveLength(1);

      await db.withTransaction(async (client) => {
        transactionDb.client = client;
        await notifications.processNotificationJob(failedJobs[0].data, transactionDb);
      });
      // Processing again is duplicate-safe
      await db.withTransaction(async (client) => {
        transactionDb.client = client;
        await notifications.processNotificationJob(failedJobs[0].data, transactionDb);
      });

      const { rows: notifFailedRows } = await db.query(
        `SELECT event_type, payload FROM notifications
         WHERE user_id = $1 AND dedupe_key = $2`,
        [target.sellerId, `payout_failed:${payoutId2}`]
      );
      expect(notifFailedRows).toHaveLength(1);
      const failedMessage = notifFailedRows[0].payload.message;
      expect(failedMessage).not.toContain(failureSecretReason);
      expect(failedMessage).not.toContain('SEC-ERR-999');
      expect(failedMessage).not.toContain(harness.adminId);

      const { rows: emailJobsFailed } = await db.query(
        `SELECT data FROM pgboss.job
         WHERE name = $1 AND singleton_key = $2`,
        [queue.QUEUES.EMAIL, `payout-email:${payoutId2}`]
      );
      if (emailJobsFailed.length > 0) {
        const decryptedFailed = decryptEmailPayload(
          emailJobsFailed[0].data.encryptedPayload,
          process.env.EMAIL_QUEUE_ENCRYPTION_SECRET
        );
        expect(decryptedFailed.text).not.toContain(failureSecretReason);
        expect(decryptedFailed.text).not.toContain(harness.adminId);
      }
    } finally {
      await cleanupScenario(harness, target);
    }
  });
});
