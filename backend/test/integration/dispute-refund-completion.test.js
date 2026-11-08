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
const eventBus = require('../../src/lib/eventBus');
const events = require('../../src/lib/events');
const { signAccessToken } = require('../../src/lib/jwt');
const {
  encryptStaffTotpSecret,
  generateTotpCode,
  generateTotpSecret,
} = require('../../src/lib/totp');
const escrowPayments = require('../../src/modules/escrowPayments.service');
const users = require('../../src/modules/users.service');

const JWT_SECRET = 'delivery-handover-integration-secret';
const STAFF_TOTP_KEY = 'dispute-refund-completion-staff-totp-key';
const originalStaffTotpKey = process.env.STAFF_TOTP_ENCRYPTION_SECRET;
const ADDRESS = {
  recipientName: 'Dispute Refund Recipient',
  phone: '+15551234567',
  cityId: '',
  addressLine1: '12 Dispute Refund Street',
};

let harness;
let scenario;
let admins;
const additionalScenarios = [];

function staffHeader(admin) {
  const token = signAccessToken(admin.id, { secret: JWT_SECRET, sessionId: admin.sessionId });
  return `Bearer ${token}`;
}

async function createStaffAccount(userId) {
  const secret = generateTotpSecret();
  const encrypted = encryptStaffTotpSecret(secret);
  await db.query(
    `INSERT INTO staff_totp_credentials
       (user_id, encrypted_secret, nonce, auth_tag, key_version, enabled_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [userId, encrypted.encryptedSecret, encrypted.nonce, encrypted.authTag, encrypted.keyVersion]
  );
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
  return { id: userId, sessionId, secret };
}

async function createAdditionalAdmin() {
  const suffix = crypto.randomUUID();
  const { rows } = await db.query(
    `INSERT INTO users (full_name, phone, password_hash, city_id, role)
     VALUES ($1, $2, 'dispute-refund-test-hash', $3, 'admin')
     RETURNING id`,
    [
      `Dispute refund Admin ${suffix}`,
      `+1559${Date.now().toString().slice(-8)}${suffix.replace(/\D/g, '').slice(0, 4)}`,
      harness.fixture.cityId,
    ]
  );
  harness.extraUserIds.push(rows[0].id);
  return createStaffAccount(rows[0].id);
}

async function createStepUpGrant(admin, action) {
  return users.createStepUpGrant(
    admin.id,
    admin.sessionId,
    action,
    generateTotpCode(admin.secret)
  );
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

function resolveException(exceptionId, admin = admins.first) {
  return request(getApp())
    .post(`/api/admin/order-exceptions/${exceptionId}/resolve`)
    .set('Authorization', staffHeader(admin))
    .send({ resolutionNote: 'Refund decision recorded.' });
}

async function createDisputeRefundException(target) {
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

  await request(getApp())
    .post(`/api/disputes/${filed.body.id}/resolve`)
    .set('Authorization', staffHeader(admins.first))
    .send({
      resolutionAmountToBuyer: '1250.50',
      resolutionNote: 'The buyer is entitled to a full refund.',
    })
    .expect(200);

  const { rows } = await db.query(
    `SELECT id
     FROM order_exceptions
     WHERE order_id = $1 AND kind = 'dispute_refund_required'
       AND resolved_at IS NULL`,
    [target.orderId]
  );
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

async function requestRefund(target, admin = admins.first, useAuthenticator = false) {
  const stepUpGrant = useAuthenticator
    ? (await createStepUpGrant(admin, 'refund.request')).grant
    : await createStoredStepUpGrant(admin, 'refund.request');
  return request(getApp())
    .post(`/api/admin/orders/${target.orderId}/refunds`)
    .set('Authorization', staffHeader(admin))
    .send({
      reason: 'Customer service reviewed the delivery issue.',
      stepUpGrant,
    });
}

async function approveRefund(refundId, admin = admins.second, useAuthenticator = false) {
  const stepUpGrant = useAuthenticator
    ? (await createStepUpGrant(admin, 'refund.decide')).grant
    : await createStoredStepUpGrant(admin, 'refund.decide');
  return request(getApp())
    .post(`/api/admin/refunds/${refundId}/approve`)
    .set('Authorization', staffHeader(admin))
    .send({
      reason: 'Second administrator approved the full buyer refund.',
      stepUpGrant,
    });
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

async function getExceptionState(target) {
  const { rows } = await db.query(
    `SELECT id, resolved_at, resolved_by, resolution_note
     FROM order_exceptions
     WHERE order_id = $1 AND kind = 'dispute_refund_required'`,
    [target.orderId]
  );
  return rows[0];
}

async function exceptionResolutionAuditCount(target) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS count
     FROM money_audit_events
     WHERE order_id = $1 AND action = 'order_exception_resolved'`,
    [target.orderId]
  );
  return rows[0].count;
}

async function completeManualRefund(target, useAuthenticator = false) {
  const requested = await requestRefund(target, admins.first, useAuthenticator);
  expect(requested.status).toBe(201);
  const approved = await approveRefund(requested.body.refundId, admins.second, useAuthenticator);
  expect(approved.status).toBe(200);
  expect(approved.body.status).toBe('approved');
  const gateway = succeededGateway();
  const processed = await escrowPayments.processRefundJob({
    refundId: requested.body.refundId,
    gateway,
  });
  return { requested, gateway, processed };
}

beforeAll(async () => {
  process.env.STAFF_TOTP_ENCRYPTION_SECRET = STAFF_TOTP_KEY;
  harness = await createHarness();
  admins = {
    first: await createStaffAccount(harness.adminId),
    second: await createAdditionalAdmin(),
  };
});

beforeEach(async () => {
  scenario = await createScenario(harness);
  scenario.disputeExceptionId = await createDisputeRefundException(scenario);
});

afterEach(async () => {
  await global.drainIntegrationListeners(5000);
  if (scenario) await cleanupScenario(harness, scenario);
  for (const target of additionalScenarios.splice(0)) {
    await cleanupScenario(harness, target);
  }
});

afterAll(async () => {
  await cleanupHarness(harness);
  restoreHandoverTestEnvironment();
  if (originalStaffTotpKey === undefined) delete process.env.STAFF_TOTP_ENCRYPTION_SECRET;
  else process.env.STAFF_TOTP_ENCRYPTION_SECRET = originalStaffTotpKey;
});

describe('FR-45, FR-69 dispute refund completion', () => {
  test('FR-45, FR-69: full manual refund closes the buyer-favour exception in the refund transaction', async () => {
    const { rows: before } = await db.query(
      'SELECT state FROM payout_holds WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(before).toEqual([{ state: 'paused_for_dispute' }]);

    const { requested, gateway, processed } = await completeManualRefund(scenario, true);
    expect(requested.body.amount).toBe('1550.50');
    expect(processed).toEqual({ outcome: 'succeeded', refundId: requested.body.refundId });
    expect(gateway.createRefund).toHaveBeenCalledTimes(1);

    const state = await getRefundState(scenario, requested.body.refundId);
    expect(state).toMatchObject({
      refund_status: 'succeeded',
      approved_by: admins.second.id,
      payment_status: 'refunded',
    });
    const exception = await getExceptionState(scenario);
    expect(exception).toMatchObject({
      id: scenario.disputeExceptionId,
      resolved_by: admins.second.id,
      resolution_note: `Manual refund ${requested.body.refundId} succeeded.`,
    });
    expect(exception.resolved_at).toBeTruthy();
    expect(await exceptionResolutionAuditCount(scenario)).toBe(1);

    const { rows: after } = await db.query(
      'SELECT state FROM payout_holds WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(after).toEqual(before);

    await request(getApp())
      .post(`/api/admin/orders/${scenario.orderId}/payout/release`)
      .set('Authorization', staffHeader(admins.first))
      .send({ payoutReference: 'refund-completion-payout', note: 'Release after full refund.' })
      .expect(409);

    const repeated = await escrowPayments.processRefundJob({
      refundId: requested.body.refundId,
      gateway,
    });
    expect(repeated).toEqual({ outcome: 'skipped', status: 'succeeded' });
    expect(gateway.createRefund).toHaveBeenCalledTimes(1);
    expect(await exceptionResolutionAuditCount(scenario)).toBe(1);
    await resolveException(scenario.disputeExceptionId).expect(409);
  });

  test('FR-45, FR-69: manual exception resolution refuses an unrefunded order and changes nothing', async () => {
    await resolveException(scenario.disputeExceptionId)
      .expect(409)
      .expect(({ body }) => expect(body.error).toMatch(/refund the buyer first/i));
    expect(await getExceptionState(scenario)).toMatchObject({
      resolved_at: null,
      resolved_by: null,
      resolution_note: null,
    });
    expect(await exceptionResolutionAuditCount(scenario)).toBe(0);
    const { rows: payments } = await db.query(
      'SELECT status FROM payments WHERE id = $1',
      [scenario.paymentId]
    );
    expect(payments).toEqual([{ status: 'succeeded' }]);

    const { requested } = await completeManualRefund(scenario);
    expect(await getRefundState(scenario, requested.body.refundId)).toMatchObject({
      refund_status: 'succeeded',
      payment_status: 'refunded',
    });
    await resolveException(scenario.disputeExceptionId)
      .expect(409)
      .expect(({ body }) => expect(body.error).toMatch(/already been resolved/i));
    expect(await exceptionResolutionAuditCount(scenario)).toBe(1);
  });

  test('FR-45, FR-69: rejected and expired refunds leave the exception open for a new full request', async () => {
    const rejected = await requestRefund(scenario);
    expect(rejected.status).toBe(201);
    const rejectionGrant = await createStoredStepUpGrant(admins.second, 'refund.decide');
    await request(getApp())
      .post(`/api/admin/refunds/${rejected.body.refundId}/reject`)
      .set('Authorization', staffHeader(admins.second))
      .send({
        reason: 'The second administrator rejected this refund request.',
        stepUpGrant: rejectionGrant,
      })
      .expect(200);

    const afterRejected = await getExceptionState(scenario);
    expect(afterRejected.resolved_at).toBeNull();
    const expired = await requestRefund(scenario);
    expect(expired.status).toBe(201);
    await db.query(
      `UPDATE refunds
       SET requested_at = now() - INTERVAL '49 hours'
       WHERE id = $1`,
      [expired.body.refundId]
    );
    const replacement = await requestRefund(scenario);
    expect(replacement.status).toBe(201);
    expect(replacement.body.status).toBe('requested');

    const { rows: refundRows } = await db.query(
      `SELECT id, status
       FROM refunds
       WHERE order_id = $1
       ORDER BY created_at, id`,
      [scenario.orderId]
    );
    expect(refundRows).toEqual([
      { id: rejected.body.refundId, status: 'rejected' },
      { id: expired.body.refundId, status: 'expired' },
      { id: replacement.body.refundId, status: 'requested' },
    ]);
    expect((await getExceptionState(scenario)).resolved_at).toBeNull();
  });

  test('FR-45, FR-69: approval and manual exception resolution serialize safely across ten orders', async () => {
    const targets = [scenario];
    for (let index = 1; index < 10; index += 1) {
      const target = await createScenario(harness);
      target.disputeExceptionId = await createDisputeRefundException(target);
      targets.push(target);
      additionalScenarios.push(target);
    }

    for (const target of targets) {
      const requested = await requestRefund(target);
      expect(requested.status).toBe(201);
      const grant = await createStoredStepUpGrant(admins.second, 'refund.decide');
      const [approval, manualResolution] = await Promise.all([
        request(getApp())
          .post(`/api/admin/refunds/${requested.body.refundId}/approve`)
          .set('Authorization', staffHeader(admins.second))
          .send({
            reason: 'Second administrator approved the full buyer refund.',
            stepUpGrant: grant,
          }),
        resolveException(target.disputeExceptionId),
      ]);

      expect(approval.status).toBe(200);
      expect(manualResolution.status).toBe(409);
      expect((await getExceptionState(target)).resolved_at).toBeNull();
      expect(await exceptionResolutionAuditCount(target)).toBe(0);
      expect(await getRefundState(target, requested.body.refundId)).toMatchObject({
        refund_status: 'approved',
        payment_status: 'succeeded',
      });

      const processed = await escrowPayments.processRefundJob({
        refundId: requested.body.refundId,
        gateway: succeededGateway(),
      });
      expect(processed.outcome).toBe('succeeded');
      expect((await getRefundState(target, requested.body.refundId)).payment_status).toBe('refunded');
      expect((await getExceptionState(target)).resolved_by).toBe(admins.second.id);
      expect(await exceptionResolutionAuditCount(target)).toBe(1);
    }
  });

  test('FR-45, FR-69: a refund-completion listener failure rolls back refund and exception updates', async () => {
    const requested = await requestRefund(scenario);
    expect(requested.status).toBe(201);
    const approved = await approveRefund(requested.body.refundId);
    expect(approved.status).toBe(200);
    const failListener = async () => {
      throw new Error('Forced manual refund completion listener failure.');
    };
    eventBus.addListener(events.MANUAL_REFUND_SUCCEEDED, failListener);
    try {
      await expect(escrowPayments.processRefundJob({
        refundId: requested.body.refundId,
        gateway: succeededGateway(),
      })).rejects.toThrow('Forced manual refund completion listener failure.');
    } finally {
      eventBus.removeListener(events.MANUAL_REFUND_SUCCEEDED, failListener);
    }

    expect(await getRefundState(scenario, requested.body.refundId)).toMatchObject({
      refund_status: 'pending',
      payment_status: 'succeeded',
    });
    expect((await getExceptionState(scenario)).resolved_at).toBeNull();
    expect(await exceptionResolutionAuditCount(scenario)).toBe(0);
  });
});
