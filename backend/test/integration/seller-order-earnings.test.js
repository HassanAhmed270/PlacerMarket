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

let harness;
let scenario;

function adminAuthHeader(adminId, sessionId) {
  return `Bearer ${signAccessToken(adminId, { secret: 'delivery-handover-integration-secret', sessionId })}`;
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

function sellerList(userId) {
  return request(getApp())
    .get('/api/orders/selling')
    .set('Authorization', authHeader(userId));
}

function sellerDetail(userId, orderId) {
  return request(getApp())
    .get(`/api/orders/selling/${orderId}`)
    .set('Authorization', authHeader(userId));
}

async function deliverScenario(target = scenario) {
  await db.query(
    `UPDATE orders
     SET status = 'handed_to_delivery', handed_over_at = now() - INTERVAL '5 minutes'
     WHERE id = $1`,
    [target.orderId]
  );
  await adminDeliveredRequest(harness, target, { note: 'Delivered for seller earnings integration test' }).expect(200);
}

async function elapsePayoutWindows(target = scenario) {
  await db.query(
    `UPDATE payout_holds
     SET hold_started_at = now() - INTERVAL '10 days'
     WHERE order_id = $1`,
    [target.orderId]
  );
  await db.query(
    `UPDATE orders
     SET delivered_at = now() - INTERVAL '10 days'
     WHERE id = $1`,
    [target.orderId]
  );
}

async function preparePayoutRelease(target = scenario) {
  await deliverScenario(target);
  await elapsePayoutWindows(target);
}

function releasePayout(target = scenario) {
  return request(getApp())
    .post(`/api/admin/orders/${target.orderId}/payout/release`)
    .set('Authorization', authHeader(harness.adminId))
    .send({ note: 'Manual release for earnings check' });
}

async function setPlatformSetting(key, value) {
  await db.query(
    `INSERT INTO platform_settings (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

beforeAll(async () => {
  harness = await createHarness();
});

beforeEach(async () => {
  scenario = await createScenario(harness);
  await setPlatformSetting('commission_percent', '5.00');
  await setPlatformSetting('payout_two_admin_threshold', '50000.00');
});

afterEach(async () => {
  await global.drainIntegrationListeners(5000);
  if (scenario) await cleanupScenario(harness, scenario);
});

afterAll(async () => {
  await cleanupHarness(harness);
  restoreHandoverTestEnvironment();
});

describe('seller order earnings and payout reads', () => {
  test('FR-49, FR-65: seller sees earnings, payout summary and held-funds flag for their own order', async () => {
    const beforeList = await sellerList(scenario.sellerId).expect(200);
    const beforeOrder = beforeList.body.orders[0];
    expect(beforeOrder).toMatchObject({
      orderId: scenario.orderId,
      earnings: null,
      payout: null,
      fundsHeldForVerification: false,
    });

    await preparePayoutRelease();
    const releaseRes = await releasePayout().expect(200);
    expect(releaseRes.body.payout).toMatchObject({
      status: 'initiated',
      amount: expect.any(String),
      currency: 'PKR',
    });

    const list = await sellerList(scenario.sellerId).expect(200);
    const row = list.body.orders.find((item) => item.orderId === scenario.orderId);
    expect(row.earnings).toMatchObject({
      commissionPercent: expect.any(String),
      commissionAmount: expect.any(String),
      sellerNetAmount: expect.any(String),
    });
    expect(row.payout).toMatchObject({
      status: 'initiated',
      amount: expect.any(String),
      currency: 'PKR',
    });
    expect(row.fundsHeldForVerification).toBe(false);

    const detail = await sellerDetail(scenario.sellerId, scenario.orderId).expect(200);
    expect(detail.body).toMatchObject({
      orderId: scenario.orderId,
      earnings: expect.any(Object),
      payout: expect.objectContaining({
        status: 'initiated',
      }),
      fundsHeldForVerification: false,
    });
  });

  test('FR-48: payout summaries expose paid and failed states without sensitive audit fields', async () => {
    await preparePayoutRelease();
    const releaseRes = await releasePayout().expect(200);
    const payoutId = releaseRes.body.payout.id;
    const sessionId = await createAdminSession(harness.adminId);
    const paidGrant = await insertStepUpGrant(harness.adminId, sessionId, 'payout.record');
    const paidOn = new Date().toISOString().slice(0, 10);

    const paidRes = await request(getApp())
      .post(`/api/admin/seller-payouts/${payoutId}/paid`)
      .set('Authorization', adminAuthHeader(harness.adminId, sessionId))
      .send({
        method: 'bank',
        transferReference: 'SELLER-PAY-PAID-REF',
        paidOn,
        note: 'Transferred to seller account',
        stepUpGrant: paidGrant,
      })
      .expect(200);

    expect(paidRes.body).toMatchObject({
      status: 'paid',
      method: 'bank',
      transferReference: 'SELLER-PAY-PAID-REF',
      paidOn,
    });

    const paidOrder = (await sellerDetail(scenario.sellerId, scenario.orderId).expect(200)).body;
    expect(paidOrder.payout).toMatchObject({
      status: 'paid',
      method: 'bank',
      transferReference: 'SELLER-PAY-PAID-REF',
      paidOn: expect.any(String),
    });

    const failedScenario = await createScenario(harness);
    await preparePayoutRelease(failedScenario);
    const failedRelease = await releasePayout(failedScenario).expect(200);
    const failedPayoutId = failedRelease.body.payout.id;
    const failedSessionId = await createAdminSession(harness.adminId);
    const failedGrant = await insertStepUpGrant(harness.adminId, failedSessionId, 'payout.record');

    const failedResult = await request(getApp())
      .post(`/api/admin/seller-payouts/${failedPayoutId}/failed`)
      .set('Authorization', adminAuthHeader(harness.adminId, failedSessionId))
      .send({
        reason: 'Bank transfer failed; retry required',
        stepUpGrant: failedGrant,
      })
      .expect(200);

    expect(failedResult.body).toMatchObject({
      status: 'failed',
      method: null,
      transferReference: null,
      paidOn: null,
    });

    const failedOrder = (await sellerDetail(failedScenario.sellerId, failedScenario.orderId).expect(200)).body;
    expect(failedOrder.payout).toMatchObject({
      status: 'failed',
      method: null,
      transferReference: null,
      paidOn: null,
    });

    const serialized = JSON.stringify(failedOrder);
    await cleanupScenario(harness, failedScenario);
    expect(serialized).not.toContain('initiated_by');
    expect(serialized).not.toContain('approved_by');
    expect(serialized).not.toContain('paid_by');
    expect(serialized).not.toContain('failed_by');
    expect(serialized).not.toContain('failure_reason');
    expect(serialized).not.toContain(harness.adminId);
  });

  test('FR-65: unverified seller release creates a held-funds flag and later release clears it', async () => {
    await db.query('UPDATE seller_profiles SET id_verified = false WHERE user_id = $1', [scenario.sellerId]);
    await preparePayoutRelease();

    const releaseRes = await releasePayout().expect(200);
    expect(releaseRes.body.payout).toMatchObject({
      status: 'held',
      heldFundsId: expect.any(String),
    });

    const heldDetail = await sellerDetail(scenario.sellerId, scenario.orderId).expect(200);
    expect(heldDetail.body.fundsHeldForVerification).toBe(true);
    expect(heldDetail.body.payout).toBeNull();

    const heldFundsId = releaseRes.body.payout.heldFundsId;
    await db.query('UPDATE seller_profiles SET id_verified = true WHERE user_id = $1', [scenario.sellerId]);
    const sessionId = await createAdminSession(harness.adminId);
    const grant = await insertStepUpGrant(harness.adminId, sessionId, 'payout.record');

    const decisionRes = await request(getApp())
      .post(`/api/admin/held-funds/${heldFundsId}/decision`)
      .set('Authorization', adminAuthHeader(harness.adminId, sessionId))
      .send({ decision: 'release', stepUpGrant: grant })
      .expect(200);

    expect(decisionRes.body.payout).toMatchObject({
      status: 'initiated',
      amount: expect.any(String),
      currency: 'PKR',
    });

    const afterDetail = await sellerDetail(scenario.sellerId, scenario.orderId).expect(200);
    expect(afterDetail.body.fundsHeldForVerification).toBe(false);
    expect(afterDetail.body.payout).toMatchObject({
      status: 'initiated',
      method: null,
      transferReference: null,
      paidOn: null,
    });
  });

  test('SEC-35: another seller gets 404 and a buyer cannot use /selling', async () => {
    const created = await db.query(
      `INSERT INTO users (full_name, phone, password_hash, city_id, role)
       VALUES ($1, $2, 'fixture-hash', $3, 'seller') RETURNING id`,
      [
        `Other seller ${crypto.randomUUID()}`,
        `+1557${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`,
        harness.fixture.cityId,
      ]
    );
    const otherSellerId = created.rows[0].id;

    await sellerDetail(otherSellerId, scenario.orderId).expect(404);
    const buyerList = await sellerList(scenario.buyerId).expect(200);
    expect(buyerList.body).toEqual({ orders: [], nextBefore: null });
  });

  test('FR-48: GET /api/admin/payout-settings works for Admin and denies other roles', async () => {
    await setPlatformSetting('commission_percent', '6.50');
    await setPlatformSetting('payout_two_admin_threshold', '75000.00');

    const adminRes = await request(getApp())
      .get('/api/admin/payout-settings')
      .set('Authorization', authHeader(harness.adminId))
      .expect(200);
    expect(adminRes.body).toMatchObject({
      commissionPercent: '6.50',
      payoutTwoAdminThreshold: '75000.00',
      currency: 'PKR',
    });

    for (const userId of [scenario.sellerId, scenario.buyerId, harness.moderatorId]) {
      await request(getApp())
        .get('/api/admin/payout-settings')
        .set('Authorization', authHeader(userId))
        .expect(403);
    }

    await request(getApp())
      .get('/api/admin/payout-settings')
      .expect(401);
  });
});
