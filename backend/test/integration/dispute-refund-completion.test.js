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
const escrowPayments = require('../../src/modules/escrowPayments.service');

const JWT_SECRET = 'delivery-handover-integration-secret';

let harness;
let scenario;
let admins;

function staffHeader(admin) {
  const token = signAccessToken(admin.id, { secret: JWT_SECRET, sessionId: admin.sessionId });
  return `Bearer ${token}`;
}

async function createStaffAccount(userId) {
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
  return { id: userId, sessionId };
}

async function createStoredStepUpGrant(admin, action) {
  const grant = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO step_up_grants (token_hash, user_id, session_id, action, expires_at)
     VALUES ($1, $2, $3, $4, now() + INTERVAL '5 minutes')`,
    [
      crypto.createHash('sha256').update(grant).digest('hex'),
      admin.id,
      admin.sessionId,
      action,
    ]
  );
  return grant;
}

async function createDisputeRefundIntent(target) {
  await db.query(
    `UPDATE orders
     SET status = 'handed_to_delivery', handed_over_at = now() - INTERVAL '5 minutes'
     WHERE id = $1`,
    [target.orderId]
  );
  await request(getApp())
    .post(`/api/admin/orders/${target.orderId}/delivered`)
    .set('Authorization', staffHeader(admins.first))
    .send({ note: 'Delivered for dispute refund completion.' })
    .expect(200);

  const filed = await request(getApp())
    .post(`/api/disputes/orders/${target.orderId}`)
    .set('Authorization', authHeader(target.buyerId))
    .send({
      reasonText: 'The delivered item differs from the listing.',
      evidenceUrls: ['https://media.example.test/dispute-refund-evidence.jpg'],
    })
    .expect(201);
  await global.drainIntegrationListeners(5000);

  const stepUpGrant = await createStoredStepUpGrant(admins.first, 'refund.decide');
  const decided = await request(getApp())
    .post(`/api/disputes/${filed.body.id}/resolve`)
    .set('Authorization', staffHeader(admins.first))
    .send({
      outcome: 'buyer_favor',
      amount: '1250.50',
      reason: 'The buyer is entitled to an item refund.',
      stepUpGrant,
    })
    .expect(200);
  target.disputeRefundId = decided.body.refund.refundId;
  return target.disputeRefundId;
}

function succeededGateway() {
  return {
    createRefund: jest.fn(async ({ amount, providerPaymentRef }) => ({
      providerRefundRef: `dispute-refund-provider-${crypto.randomUUID()}`,
      providerPaymentRef,
      amount,
      status: 'succeeded',
    })),
  };
}

async function getRefundState(target, refundId) {
  const { rows } = await db.query(
    `SELECT r.status AS refund_status, r.approved_by, r.provider_refund_id,
            p.status AS payment_status
     FROM refunds r
     JOIN payments p ON p.id = r.payment_id
     WHERE r.id = $1 AND r.order_id = $2`,
    [refundId, target.orderId]
  );
  return rows[0];
}

beforeAll(async () => {
  harness = await createHarness();
  admins = {
    first: await createStaffAccount(harness.adminId),
  };
});

beforeEach(async () => {
  scenario = await createScenario(harness);
  scenario.disputeRefundId = await createDisputeRefundIntent(scenario);
});

afterEach(async () => {
  await global.drainIntegrationListeners(5000);
  if (scenario) await cleanupScenario(harness, scenario);
});

afterAll(async () => {
  await cleanupHarness(harness);
  restoreHandoverTestEnvironment();
});

describe('FR-69 dispute refund completion', () => {
  test('FR-69: approved dispute refund records exact cash ledger amount and decision audit', async () => {
    expect(scenario.disputeRefundId).toBeTruthy();
    const { rows: before } = await db.query(
      'SELECT state FROM payout_holds WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(before).toEqual([{ state: 'held' }]);

    const processed = await escrowPayments.processRefundJob({
      refundId: scenario.disputeRefundId,
      gateway: succeededGateway(),
    });
    expect(processed).toEqual({ outcome: 'succeeded', refundId: scenario.disputeRefundId });
    expect(await getRefundState(scenario, scenario.disputeRefundId)).toMatchObject({
      refund_status: 'succeeded',
      approved_by: admins.first.id,
      payment_status: 'succeeded',
    });
    const { rows: refundRows } = await db.query(
      `SELECT trigger, amount::text, item_amount::text, delivery_fee_amount::text,
              decided_by
       FROM refunds WHERE id = $1`,
      [scenario.disputeRefundId]
    );
    expect(refundRows).toEqual([{
      trigger: 'dispute_admin',
      amount: '1250.50',
      item_amount: '1250.50',
      delivery_fee_amount: '0.00',
      decided_by: admins.first.id,
    }]);
    const { rows: ledgerRows } = await db.query(
      `SELECT entry_type, amount::text
       FROM ledger_entries
       WHERE order_id = $1
       ORDER BY entry_type`,
      [scenario.orderId]
    );
    expect(ledgerRows).toEqual([
      { entry_type: 'refund', amount: '-1250.50' },
    ]);
    const { rows: auditRows } = await db.query(
      `SELECT actor_id, action, approved_by, metadata
       FROM money_audit_events
       WHERE order_id = $1 AND action IN ('dispute_outcome_decided', 'system_refund_succeeded')
       ORDER BY action`,
      [scenario.orderId]
    );
    expect(auditRows).toHaveLength(2);
    const decisionAudit = auditRows.find((row) => row.action === 'dispute_outcome_decided');
    const refundAudit = auditRows.find((row) => row.action === 'system_refund_succeeded');
    expect(decisionAudit).toMatchObject({
      actor_id: admins.first.id,
      approved_by: admins.first.id,
      metadata: {
      outcome: 'buyer_favor',
      amount: '1250.50',
      },
    });
    expect(refundAudit).toMatchObject({
      actor_id: null,
      approved_by: admins.first.id,
      metadata: {
      trigger: 'dispute_admin',
      itemAmount: '1250.50',
      deliveryFeeAmount: '0.00',
      decidedBy: admins.first.id,
      },
    });
  });

  test('FR-69: dispute refund job retries are idempotent and do not create a clawback', async () => {
    const gateway = succeededGateway();
    await escrowPayments.processRefundJob({ refundId: scenario.disputeRefundId, gateway });
    const repeated = await escrowPayments.processRefundJob({
      refundId: scenario.disputeRefundId,
      gateway,
    });
    expect(repeated).toEqual({ outcome: 'skipped', status: 'succeeded' });
    expect(gateway.createRefund).toHaveBeenCalledTimes(1);
    const { rows: payoutRows } = await db.query(
      `SELECT count(*)::int AS count
       FROM ledger_entries
       WHERE order_id = $1 AND entry_type = 'seller_payout_manual'`,
      [scenario.orderId]
    );
    expect(payoutRows[0].count).toBe(0);
  });
});
