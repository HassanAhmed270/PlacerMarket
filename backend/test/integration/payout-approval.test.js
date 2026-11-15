const crypto = require('crypto');
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
const { getSharedRedisClient, setSharedRedisClient } = require('../../src/lib/redis');

const JWT_SECRET = 'delivery-handover-integration-secret';
const THRESHOLD_KEY = 'payout_two_admin_threshold';

let harness;
let scenario;
let previousThreshold;
let secondAdminOriginalRole;

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

async function insertStepUpGrant(userId, sessionId, action = 'payout.record') {
  const grant = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO step_up_grants (token_hash, user_id, session_id, action, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '5 minutes')`,
    [crypto.createHash('sha256').update(grant).digest('hex'), userId, sessionId, action]
  );
  return grant;
}

async function grantConsumedAt(grant) {
  const digest = crypto.createHash('sha256').update(grant).digest('hex');
  const { rows } = await db.query(
    'SELECT consumed_at FROM step_up_grants WHERE token_hash = $1',
    [digest]
  );
  return rows[0].consumed_at;
}

async function setThreshold(value) {
  await db.query(
    `INSERT INTO platform_settings (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [THRESHOLD_KEY, value]
  );
}

async function promoteSecondAdmin() {
  if (secondAdminOriginalRole === undefined) {
    const { rows } = await db.query('SELECT role FROM users WHERE id = $1', [scenario.buyerId]);
    secondAdminOriginalRole = rows[0].role;
  }
  await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [scenario.buyerId]);
  return scenario.buyerId;
}

async function deliverScenario(target) {
  await db.query(
    `UPDATE orders
     SET status = 'handed_to_delivery', handed_over_at = now() - INTERVAL '5 minutes'
     WHERE id = $1`,
    [target.orderId]
  );
  await adminDeliveredRequest(harness, target, { note: 'Delivered for payout approval test' }).expect(200);
}

async function elapsePayoutWindows(target) {
  await db.query(
    `UPDATE payout_holds
     SET hold_started_at = now() - INTERVAL '10 days'
     WHERE order_id = $1`,
    [target.orderId]
  );
  await db.query(
    'UPDATE orders SET delivered_at = now() - INTERVAL \'10 days\' WHERE id = $1',
    [target.orderId]
  );
}

function releasePayout(orderId, adminId = harness.adminId) {
  return request(getApp())
    .post(`/api/admin/orders/${orderId}/payout/release`)
    .set('Authorization', authHeader(adminId))
    .send({ note: 'Manual release for approval test' });
}

function approvePayout(payoutId, adminId, sessionId, stepUpGrant) {
  return request(getApp())
    .post(`/api/admin/seller-payouts/${payoutId}/approve`)
    .set('Authorization', adminAuthHeader(adminId, sessionId))
    .send({ stepUpGrant });
}

function markPaid(payoutId, adminId, sessionId, stepUpGrant) {
  return request(getApp())
    .post(`/api/admin/seller-payouts/${payoutId}/paid`)
    .set('Authorization', adminAuthHeader(adminId, sessionId))
    .send({
      method: 'bank',
      transferReference: 'APPROVAL-TEST-REF',
      paidOn: new Date().toISOString().slice(0, 10),
      stepUpGrant,
    });
}

function markFailed(payoutId, adminId, sessionId, stepUpGrant) {
  return request(getApp())
    .post(`/api/admin/seller-payouts/${payoutId}/failed`)
    .set('Authorization', adminAuthHeader(adminId, sessionId))
    .send({ reason: 'Transfer failed in approval test', stepUpGrant });
}

async function createPayout() {
  const response = await releasePayout(scenario.orderId).expect(200);
  return response.body.payout;
}

beforeAll(async () => {
  harness = await createHarness();
});

beforeEach(async () => {
  scenario = await createScenario(harness);
  const { rows } = await db.query('SELECT value FROM platform_settings WHERE key = $1', [THRESHOLD_KEY]);
  previousThreshold = rows[0] ? rows[0].value : null;
  secondAdminOriginalRole = undefined;
  await deliverScenario(scenario);
  await elapsePayoutWindows(scenario);
});

afterEach(async () => {
  await global.drainIntegrationListeners(5000);
  if (secondAdminOriginalRole !== undefined && scenario) {
    await db.query('UPDATE users SET role = $1 WHERE id = $2', [secondAdminOriginalRole, scenario.buyerId]);
  }
  if (previousThreshold === null) {
    await db.query('DELETE FROM platform_settings WHERE key = $1', [THRESHOLD_KEY]);
  } else {
    await setThreshold(previousThreshold);
  }
  if (scenario) await cleanupScenario(harness, scenario);
});

afterAll(async () => {
  await cleanupHarness(harness);
  restoreHandoverTestEnvironment();
});

describe('FR-48: two-Admin payout approval', () => {
  test('FR-48: amount at the threshold is paid by one Admin without approval', async () => {
    const payout = await createPayout();
    await setThreshold(payout.amount);

    const details = await request(getApp())
      .get(`/api/admin/seller-payouts/${payout.id}`)
      .set('Authorization', authHeader(harness.adminId))
      .expect(200);
    expect(details.body.requiresApproval).toBe(false);

    const sessionId = await createAdminSession(harness.adminId);
    const grant = await insertStepUpGrant(harness.adminId, sessionId);
    const paid = await markPaid(payout.id, harness.adminId, sessionId, grant).expect(200);
    expect(paid.body.status).toBe('paid');

    const list = await request(getApp())
      .get('/api/admin/seller-payouts')
      .set('Authorization', authHeader(harness.adminId))
      .expect(200);
    expect(list.body.payouts.find((row) => row.id === payout.id).requiresApproval).toBe(false);
  });

  test('FR-48: amount above the threshold cannot be paid without approval; 409, step-up grant NOT consumed, zero ledger entries, no paid audit row', async () => {
    const payout = await createPayout();
    await setThreshold('0.01');

    const details = await request(getApp())
      .get(`/api/admin/seller-payouts/${payout.id}`)
      .set('Authorization', authHeader(harness.adminId))
      .expect(200);
    expect(details.body.requiresApproval).toBe(true);

    const sessionId = await createAdminSession(harness.adminId);
    const grant = await insertStepUpGrant(harness.adminId, sessionId);
    await markPaid(payout.id, harness.adminId, sessionId, grant).expect(409);
    expect(await grantConsumedAt(grant)).toBeNull();

    const { rows: ledgerRows } = await db.query('SELECT id FROM ledger_entries WHERE order_id = $1', [scenario.orderId]);
    const { rows: auditRows } = await db.query(
      'SELECT id FROM money_audit_events WHERE order_id = $1 AND action = $2',
      [scenario.orderId, 'seller_payout_paid']
    );
    expect(ledgerRows).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });

  test('FR-48: the initiating Admin cannot approve even with a valid grant (403, grant not consumed); a second Admin can approve (200, exactly one seller_payout_approved audit)', async () => {
    const payout = await createPayout();
    await setThreshold('0.01');
    const secondAdminId = await promoteSecondAdmin();

    const initiatorSession = await createAdminSession(harness.adminId);
    const initiatorGrant = await insertStepUpGrant(harness.adminId, initiatorSession, 'payout.approve');
    await approvePayout(payout.id, harness.adminId, initiatorSession, initiatorGrant).expect(403);
    expect(await grantConsumedAt(initiatorGrant)).toBeNull();

    const secondSession = await createAdminSession(secondAdminId);
    const secondGrant = await insertStepUpGrant(secondAdminId, secondSession, 'payout.approve');
    const approved = await approvePayout(payout.id, secondAdminId, secondSession, secondGrant).expect(200);
    expect(approved.body).toMatchObject({
      id: payout.id,
      approvedBy: secondAdminId,
    });
    expect(approved.body.approvedAt).toBeTruthy();

    const { rows: auditRows } = await db.query(
      'SELECT action, metadata FROM money_audit_events WHERE order_id = $1 AND action = $2',
      [scenario.orderId, 'seller_payout_approved']
    );
    expect(auditRows).toHaveLength(1);
    expect(Object.keys(auditRows[0].metadata).sort()).toEqual(['amount', 'attempt', 'currency', 'payoutId']);
  });

  test('FR-48: approving twice gives 409; approving an at-or-below-threshold payout gives 409', async () => {
    const payout = await createPayout();
    const secondAdminId = await promoteSecondAdmin();
    const secondSession = await createAdminSession(secondAdminId);
    const firstGrant = await insertStepUpGrant(secondAdminId, secondSession, 'payout.approve');

    await setThreshold('0.01');
    await approvePayout(payout.id, secondAdminId, secondSession, firstGrant).expect(200);

    const duplicateGrant = await insertStepUpGrant(secondAdminId, secondSession, 'payout.approve');
    await approvePayout(payout.id, secondAdminId, secondSession, duplicateGrant).expect(409);
    expect(await grantConsumedAt(duplicateGrant)).toBeNull();

    const belowPayout = await createScenario(harness);
    try {
      await deliverScenario(belowPayout);
      await elapsePayoutWindows(belowPayout);
      const response = await request(getApp())
        .post(`/api/admin/orders/${belowPayout.orderId}/payout/release`)
        .set('Authorization', authHeader(harness.adminId))
        .send({ note: 'At-threshold payout test' })
        .expect(200);
      const below = response.body.payout;
      await setThreshold(below.amount);
      const atThresholdGrant = await insertStepUpGrant(secondAdminId, secondSession, 'payout.approve');
      await approvePayout(below.id, secondAdminId, secondSession, atThresholdGrant).expect(409);
      expect(await grantConsumedAt(atThresholdGrant)).toBeNull();
    } finally {
      await cleanupScenario(harness, belowPayout);
    }
  });

  test('FR-48: ten parallel approve requests from the second Admin give exactly one 200 and exactly one approval audit', async () => {
    const payout = await createPayout();
    await setThreshold('0.01');
    const secondAdminId = await promoteSecondAdmin();
    const sessionId = await createAdminSession(secondAdminId);
    const grant = await insertStepUpGrant(secondAdminId, sessionId, 'payout.approve');

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => approvePayout(payout.id, secondAdminId, sessionId, grant))
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(9);

    const { rows: auditRows } = await db.query(
      'SELECT id FROM money_audit_events WHERE order_id = $1 AND action = $2',
      [scenario.orderId, 'seller_payout_approved']
    );
    expect(auditRows).toHaveLength(1);
  });

  test('FR-48: after approval, parallel paid and failed give exactly one winner; exactly one seller_payout_manual ledger entry if paid won, zero if failed won', async () => {
    const payout = await createPayout();
    await setThreshold('0.01');
    const secondAdminId = await promoteSecondAdmin();
    const approvalSession = await createAdminSession(secondAdminId);
    const approvalGrant = await insertStepUpGrant(secondAdminId, approvalSession, 'payout.approve');
    await approvePayout(payout.id, secondAdminId, approvalSession, approvalGrant).expect(200);

    const paidSession = await createAdminSession(harness.adminId);
    const paidGrant = await insertStepUpGrant(harness.adminId, paidSession);
    const failedSession = await createAdminSession(secondAdminId);
    const failedGrant = await insertStepUpGrant(secondAdminId, failedSession);
    const results = await Promise.all([
      markPaid(payout.id, harness.adminId, paidSession, paidGrant),
      markFailed(payout.id, secondAdminId, failedSession, failedGrant),
    ]);

    expect(results.filter((response) => response.status === 200)).toHaveLength(1);
    expect(results.filter((response) => response.status === 409)).toHaveLength(1);
    const { rows: ledgerRows } = await db.query(
      "SELECT entry_type FROM ledger_entries WHERE order_id = $1 AND entry_type = 'seller_payout_manual'",
      [scenario.orderId]
    );
    const paidWon = results.some((response) => response.status === 200 && response.body.status === 'paid');
    expect(ledgerRows).toHaveLength(paidWon ? 1 : 0);
  });

  test('FR-48: after failed, retry creates attempt 2 with approved_by NULL, and paid on it is 409 until a different Admin approves it', async () => {
    const payout = await createPayout();
    await setThreshold('0.01');
    const failSession = await createAdminSession(harness.adminId);
    const failGrant = await insertStepUpGrant(harness.adminId, failSession);
    await markFailed(payout.id, harness.adminId, failSession, failGrant).expect(200);

    const secondAdminId = await promoteSecondAdmin();
    const retrySession = await createAdminSession(harness.adminId);
    const retryGrant = await insertStepUpGrant(harness.adminId, retrySession);
    const retried = await request(getApp())
      .post(`/api/admin/seller-payouts/${payout.id}/retry`)
      .set('Authorization', adminAuthHeader(harness.adminId, retrySession))
      .send({ stepUpGrant: retryGrant })
      .expect(200);
    expect(retried.body).toMatchObject({ attempt: 2, status: 'initiated', approvedBy: null });

    const paidGrant = await insertStepUpGrant(harness.adminId, retrySession);
    await markPaid(retried.body.id, harness.adminId, retrySession, paidGrant).expect(409);
    expect(await grantConsumedAt(paidGrant)).toBeNull();

    const approvalSession = await createAdminSession(secondAdminId);
    const approvalGrant = await insertStepUpGrant(secondAdminId, approvalSession, 'payout.approve');
    await approvePayout(retried.body.id, secondAdminId, approvalSession, approvalGrant).expect(200);
    await markPaid(retried.body.id, harness.adminId, retrySession, paidGrant).expect(200);
  });

  test('FR-48: a missing or invalid threshold setting makes paid return 409 (fail closed); setting restored in finally', async () => {
    const payout = await createPayout();
    const sessionId = await createAdminSession(harness.adminId);
    const missingGrant = await insertStepUpGrant(harness.adminId, sessionId);

    await db.query('DELETE FROM platform_settings WHERE key = $1', [THRESHOLD_KEY]);
    await markPaid(payout.id, harness.adminId, sessionId, missingGrant).expect(409);
    expect(await grantConsumedAt(missingGrant)).toBeNull();

    await setThreshold('not-a-number');
    const invalidGrant = await insertStepUpGrant(harness.adminId, sessionId);
    await markPaid(payout.id, harness.adminId, sessionId, invalidGrant).expect(409);
    expect(await grantConsumedAt(invalidGrant)).toBeNull();

    const details = await request(getApp())
      .get(`/api/admin/seller-payouts/${payout.id}`)
      .set('Authorization', authHeader(harness.adminId))
      .expect(200);
    expect(details.body.requiresApproval).toBe(true);
  });

  test('FR-48, SEC-35: Seller, Buyer, Moderator and anonymous callers cannot approve', async () => {
    const payout = await createPayout();
    const callers = [
      { token: authHeader(scenario.sellerId), status: 403 },
      { token: authHeader(harness.unrelatedBuyerId), status: 403 },
      { token: authHeader(harness.moderatorId), status: 403 },
      { token: null, status: 401 },
    ];

    for (const caller of callers) {
      const post = request(getApp())
        .post(`/api/admin/seller-payouts/${payout.id}/approve`)
        .send({});
      if (caller.token) post.set('Authorization', caller.token);
      await post.expect(caller.status);
    }
  });

  test('FR-48: limiter 429 on /approve happens before the step-up grant is consumed', async () => {
    const payout = await createPayout();
    const secondAdminId = await promoteSecondAdmin();
    const sessionId = await createAdminSession(secondAdminId);
    const grant = await insertStepUpGrant(secondAdminId, sessionId, 'payout.approve');
    const originalClient = getSharedRedisClient();

    try {
      setSharedRedisClient({
        isOpen: true,
        eval: async () => [9999, 9999],
      });

      await approvePayout(payout.id, secondAdminId, sessionId, grant).expect(429);
      expect(await grantConsumedAt(grant)).toBeNull();
    } finally {
      setSharedRedisClient(originalClient);
    }
  });
});
