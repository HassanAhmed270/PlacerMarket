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
const sellerPayouts = require('../../src/modules/sellerPayouts.service');

const JWT_SECRET = 'delivery-handover-integration-secret';
const THRESHOLD_KEY = 'payout_two_admin_threshold';

let harness;
let scenario;
let previousThreshold;

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

async function insertStepUpGrant(userId, sessionId, action = 'payout.export') {
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

async function deliverScenario(target) {
  await db.query(
    `UPDATE orders
     SET status = 'handed_to_delivery', handed_over_at = now() - INTERVAL '5 minutes'
     WHERE id = $1`,
    [target.orderId]
  );
  await adminDeliveredRequest(harness, target, { note: 'Delivered for payout export test' }).expect(200);
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

async function createPayout() {
  const response = await request(getApp())
    .post(`/api/admin/orders/${scenario.orderId}/payout/release`)
    .set('Authorization', authHeader(harness.adminId))
    .send({ note: 'Manual release for payout export test' })
    .expect(200);
  return response.body.payout;
}

function markFailed(payoutId, adminId, sessionId, stepUpGrant) {
  return request(getApp())
    .post(`/api/admin/seller-payouts/${payoutId}/failed`)
    .set('Authorization', adminAuthHeader(adminId, sessionId))
    .send({ reason: 'Failed for payout export test', stepUpGrant });
}

function markPaid(payoutId, adminId, sessionId, transferReference, stepUpGrant) {
  return request(getApp())
    .post(`/api/admin/seller-payouts/${payoutId}/paid`)
    .set('Authorization', adminAuthHeader(adminId, sessionId))
    .send({
      method: 'bank',
      transferReference,
      paidOn: new Date().toISOString().slice(0, 10),
      stepUpGrant,
    });
}

function retryPayout(payoutId, adminId, sessionId, stepUpGrant) {
  return request(getApp())
    .post(`/api/admin/seller-payouts/${payoutId}/retry`)
    .set('Authorization', adminAuthHeader(adminId, sessionId))
    .send({ stepUpGrant });
}

function exportPayouts(adminId, sessionId, filters = {}, stepUpGrant) {
  const body = { ...filters };
  if (stepUpGrant !== undefined) body.stepUpGrant = stepUpGrant;
  return request(getApp())
    .post('/api/admin/seller-payouts/export')
    .set('Authorization', adminAuthHeader(adminId, sessionId))
    .send(body);
}

async function exportWithGrant(adminId, sessionId, filters = {}) {
  const grant = await insertStepUpGrant(adminId, sessionId);
  const response = await exportPayouts(adminId, sessionId, filters, grant).expect(200);
  return { grant, response };
}

beforeAll(async () => {
  harness = await createHarness();
});

beforeEach(async () => {
  scenario = await createScenario(harness);
  const { rows: thresholdRows } = await db.query(
    'SELECT value FROM platform_settings WHERE key = $1',
    [THRESHOLD_KEY]
  );
  previousThreshold = thresholdRows[0] ? thresholdRows[0].value : null;
  await setThreshold('9999999999');
  await deliverScenario(scenario);
  await elapsePayoutWindows(scenario);
});

afterEach(async () => {
  await global.drainIntegrationListeners(5000);
  if (previousThreshold === null) {
    await db.query('DELETE FROM platform_settings WHERE key = $1', [THRESHOLD_KEY]);
  } else {
    await setThreshold(previousThreshold);
  }
  if (scenario) {
    await db.query(
      "DELETE FROM seller_payouts WHERE order_id = $1 AND failure_reason = 'Export cap fixture'",
      [scenario.orderId]
    );
  }
  if (scenario) await cleanupScenario(harness, scenario);
});

afterAll(async () => {
  await cleanupHarness(harness);
  restoreHandoverTestEnvironment();
});

describe('FR-48: Admin payout CSV export', () => {
  test('FR-48: exports the exact columns, requires step-up, and audits filters without row data or private payout details', async () => {
    const payout = await createPayout();
    await db.query(
      'UPDATE seller_payouts SET initiated_at = $2::timestamptz WHERE id = $1',
      [payout.id, '2020-01-01T12:00:00.000Z']
    );
    const sessionId = await createAdminSession(harness.adminId);

    await exportPayouts(harness.adminId, sessionId, {
      status: 'initiated',
      from: '2020-01-01',
      to: '2020-01-01',
    }).expect(403);

    const { rows: sensitiveRows } = await db.query(
      `SELECT u.email, sp.payout_bank_account, sp.payout_wallet_number,
              sp.payout_details_encrypted::text AS encrypted_details
       FROM users u
       LEFT JOIN seller_profiles sp ON sp.user_id = u.id
       WHERE u.id = $1`,
      [scenario.sellerId]
    );
    const auditStart = await db.query("SELECT now() - INTERVAL '1 second' AS started_at");
    const { grant, response } = await exportWithGrant(harness.adminId, sessionId, {
      status: 'initiated',
      from: '2020-01-01',
      to: '2020-01-01',
    });
    const csv = response.text;

    expect(await grantConsumedAt(grant)).toBeInstanceOf(Date);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe('attachment; filename=payouts.csv');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(csv.split('\r\n')[0]).toBe(
      'payoutId,orderId,sellerId,attempt,status,amount,currency,method,transferReference,initiatedAt,paidOn,paidAt'
    );
    const csvRows = csv.split('\r\n');
    expect(csvRows).toHaveLength(2);
    expect(csvRows[1].split(',')).toHaveLength(12);
    expect(csvRows[1].startsWith(`${payout.id},${scenario.orderId},${scenario.sellerId},1,initiated,`)).toBe(true);
    expect(csv.toLowerCase()).not.toMatch(/@|payout_bank_account|payout_wallet_number|wallet details|bank details/);
    for (const value of Object.values(sensitiveRows[0])) {
      if (value) expect(csv).not.toContain(value);
    }

    const { rows: auditRows } = await db.query(
      `SELECT metadata FROM money_audit_events
       WHERE actor_id = $1 AND action = 'seller_payout_exported' AND created_at >= $2`,
      [harness.adminId, auditStart.rows[0].started_at]
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].metadata).toEqual({
      status: 'initiated',
      from: '2020-01-01',
      to: '2020-01-01',
      rowCount: 1,
    });
    expect(JSON.stringify(auditRows[0].metadata)).not.toContain(payout.id);
    expect(JSON.stringify(auditRows[0].metadata)).not.toContain(scenario.orderId);
  });

  test('FR-48: status and inclusive from/to date filters select and order the matching payouts', async () => {
    const first = await createPayout();
    const sessionId = await createAdminSession(harness.adminId);
    const failedGrant = await insertStepUpGrant(harness.adminId, sessionId, 'payout.record');
    await markFailed(first.id, harness.adminId, sessionId, failedGrant).expect(200);

    const retryGrant = await insertStepUpGrant(harness.adminId, sessionId, 'payout.record');
    const retry = await retryPayout(first.id, harness.adminId, sessionId, retryGrant)
      .expect(200);

    await db.query(
      `UPDATE seller_payouts
       SET initiated_at = CASE id
         WHEN $1 THEN '2024-05-01T23:59:59.999Z'::timestamptz
         WHEN $2 THEN '2024-05-02T00:00:00.000Z'::timestamptz
       END
       WHERE id = ANY($3::uuid[])`,
      [first.id, retry.body.id, [first.id, retry.body.id]]
    );

    const failed = await exportWithGrant(harness.adminId, sessionId, {
      status: 'failed',
      from: '2024-05-01',
      to: '2024-05-01',
    });
    expect(failed.response.text.split('\r\n')[1].startsWith(`${first.id},`)).toBe(true);
    expect(failed.response.text.split('\r\n')).toHaveLength(2);

    const initiated = await exportWithGrant(harness.adminId, sessionId, {
      status: 'initiated',
      from: '2024-05-02',
      to: '2024-05-02',
    });
    expect(initiated.response.text.split('\r\n')[1].startsWith(`${retry.body.id},`)).toBe(true);
    expect(initiated.response.text.split('\r\n')).toHaveLength(2);

    const ordered = await exportWithGrant(harness.adminId, sessionId, {
      from: '2024-05-01',
      to: '2024-05-02',
    });
    const payoutIds = ordered.response.text.split('\r\n').slice(1).map((row) => row.split(',')[0]);
    expect(payoutIds).toEqual([first.id, retry.body.id]);
  });

  test('FR-48: export rejects more than 5000 rows before consuming its grant', async () => {
    const payout = await createPayout();
    await db.query(
      `INSERT INTO seller_payouts
         (order_id, seller_id, attempt, status, amount, currency, initiated_by,
          failure_reason, failed_by, failed_at)
       SELECT $1, $2, series.attempt, 'failed', $3::numeric, 'PKR', $4,
              'Export cap fixture', $4, now()
       FROM generate_series(2, $5::integer) AS series(attempt)`,
      [
        scenario.orderId,
        scenario.sellerId,
        payout.amount,
        harness.adminId,
        sellerPayouts.MAX_PAYOUT_EXPORT_ROWS + 2,
      ]
    );
    const sessionId = await createAdminSession(harness.adminId);
    const grant = await insertStepUpGrant(harness.adminId, sessionId);

    const response = await exportPayouts(
      harness.adminId,
      sessionId,
      { status: 'failed' },
      grant
    ).expect(400);

    expect(JSON.stringify(response.body)).toMatch(/narrower/i);
    expect(await grantConsumedAt(grant)).toBeNull();
  });

  test('FR-48: formula-like transfer references are prefixed with a single quote in the CSV', async () => {
    const payout = await createPayout();
    const sessionId = await createAdminSession(harness.adminId);
    const paidGrant = await insertStepUpGrant(harness.adminId, sessionId, 'payout.record');
    await markPaid(payout.id, harness.adminId, sessionId, '=SUM(1,1)', paidGrant).expect(200);

    const { response } = await exportWithGrant(harness.adminId, sessionId, { status: 'paid' });
    expect(response.text).toContain(`"'=SUM(1,1)"`);
  });

  test('FR-48, SEC-35: Seller, Buyer, Moderator and anonymous callers cannot export payouts', async () => {
    const callers = [
      { token: authHeader(scenario.sellerId), status: 403 },
      { token: authHeader(harness.unrelatedBuyerId), status: 403 },
      { token: authHeader(harness.moderatorId), status: 403 },
      { token: null, status: 401 },
    ];

    for (const caller of callers) {
      const post = request(getApp()).post('/api/admin/seller-payouts/export').send({});
      if (caller.token) post.set('Authorization', caller.token);
      await post.expect(caller.status);
    }
  });

  test('FR-48: limiter 429 happens before the payout export step-up grant is consumed', async () => {
    const sessionId = await createAdminSession(harness.adminId);
    const grant = await insertStepUpGrant(harness.adminId, sessionId);
    const originalClient = getSharedRedisClient();

    try {
      setSharedRedisClient({
        isOpen: true,
        eval: async () => [9999, 9999],
      });

      await exportPayouts(harness.adminId, sessionId, {}, grant).expect(429);
      expect(await grantConsumedAt(grant)).toBeNull();
    } finally {
      setSharedRedisClient(originalClient);
    }
  });
});
