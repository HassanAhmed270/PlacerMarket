const crypto = require('node:crypto');
const request = require('supertest');

const ENV_KEYS = [
  'JWT_ACCESS_SECRET',
  'FAKE_GATEWAY_WEBHOOK_SECRET',
  'NODE_ENV',
  'PAYMENT_GATEWAY_PROVIDER',
  'PAYMENT_WEBHOOK_URL',
  'PAYMENTS_ENABLED',
  'PUBLIC_BASE_URL',
  'RATE_LIMIT_ADMIN_OPS_ACCOUNT_MAX',
  'RATE_LIMIT_ADMIN_OPS_IP_MAX',
  'STAFF_TOTP_ENCRYPTION_SECRET',
];
const originalEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const JWT_SECRET = 'refund-failure-attention-integration-secret';
process.env.JWT_ACCESS_SECRET = JWT_SECRET;
process.env.FAKE_GATEWAY_WEBHOOK_SECRET = 'refund-failure-attention-fake-webhook-secret';
process.env.NODE_ENV = 'test';
process.env.PAYMENT_GATEWAY_PROVIDER = 'fake';
process.env.PAYMENT_WEBHOOK_URL = 'http://127.0.0.1:39991/api/webhooks/payments/fake';
process.env.PAYMENTS_ENABLED = '1';
process.env.PUBLIC_BASE_URL = 'http://localhost:5173';
process.env.RATE_LIMIT_ADMIN_OPS_ACCOUNT_MAX = '1000';
process.env.RATE_LIMIT_ADMIN_OPS_IP_MAX = '1000';
process.env.STAFF_TOTP_ENCRYPTION_SECRET = 'refund-failure-attention-staff-secret';

const { getSharedRedisClient, setSharedRedisClient } = require('../../src/lib/redis');
const originalRedisClient = getSharedRedisClient();
setSharedRedisClient({ isOpen: true, eval: async () => [1, 1] });
const db = require('../../src/db.service');
const app = require('../../src/app');
const queue = require('../../src/lib/queue');
const reservations = require('../../src/modules/reservations.service');
const escrowPayments = require('../../src/modules/escrowPayments.service');
const { signAccessToken } = require('../../src/lib/jwt');
const { createFixture } = require('./fixtures');

const REFUND_ERROR_CODES = [
  'gateway_unavailable',
  'gateway_rejected',
  'gateway_invalid_response',
  'configuration',
  'unknown',
];
const ADDRESS = {
  recipientName: 'Refund Attention Buyer',
  phone: '+15551234567',
  addressLine1: '12 Refund Attention Street',
};

let fixture;
let buyer;
let admin;
let scenario;

function authHeader(user) {
  const token = signAccessToken(user.id, { secret: JWT_SECRET, sessionId: user.sessionId });
  return `Bearer ${token}`;
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
  return { id: userId, sessionId };
}

async function insertRefund({
  status = 'failed',
  trigger = 'system_cancel',
  attemptCount = 0,
  needsAttentionAt = null,
  lastAttemptAt = new Date(Date.now() - 15 * 60 * 1000),
} = {}) {
  const refundId = crypto.randomUUID();
  const manual = trigger === 'manual_admin';
  await db.query(
    `INSERT INTO refunds
       (id, payment_id, order_id, trigger, amount, currency, status, idempotency_key,
        requested_by, approved_by, approved_at, reason, attempt_count, last_error_code,
        last_attempt_at, needs_attention_at)
     VALUES ($1, $2, $3, $4, '0.01', 'PKR', $5, $6, $7, $8,
             CASE WHEN $9 THEN now() - INTERVAL '3 minutes' ELSE NULL END,
             CASE WHEN $9 THEN 'Approved after review of the refund failure.' ELSE NULL END,
             $10, 'gateway_unavailable', $11, $12)`,
    [
      refundId,
      scenario.paymentId,
      scenario.orderId,
      trigger,
      status,
      `refund-attention:${crypto.randomUUID()}`,
      manual ? buyer.id : null,
      manual ? admin.id : null,
      manual,
      attemptCount,
      lastAttemptAt,
      needsAttentionAt,
    ]
  );
  return refundId;
}

function get(path, user = admin) {
  const call = request(app).get(path);
  return user ? call.set('Authorization', authHeader(user)) : call;
}

function postRetry(refundId, user = admin) {
  const call = request(app).post(`/api/admin/refunds/${refundId}/retry`);
  return (user ? call.set('Authorization', authHeader(user)) : call).send({});
}

async function setUpMoneyScenario() {
  fixture = await createFixture({ askingPrice: '1250.50', listingStatus: 'published' });
  await db.query(
    `INSERT INTO supported_delivery_cities (city_id, active)
     VALUES ($1, true) ON CONFLICT (city_id) DO UPDATE SET active = true`,
    [fixture.cityId]
  );
  const suffix = crypto.randomUUID();
  const { rows } = await db.query(
    `INSERT INTO users (full_name, phone, password_hash, city_id, role)
     VALUES ($1, $2, 'refund-attention-buyer-hash', $3, 'buyer')
     RETURNING id`,
    [
      `Refund attention buyer ${suffix}`,
      `+1557${Date.now().toString().slice(-9)}${suffix.replace(/\D/g, '').slice(0, 3)}`,
      fixture.cityId,
    ]
  );
  buyer = await createSession(rows[0].id);
  await db.query(
    "UPDATE users SET role = 'admin', is_suspended = false WHERE id = $1",
    [fixture.otherUserId]
  );
  admin = await createSession(fixture.otherUserId);

  const reservation = await reservations.buyListing(fixture.listingId, buyer.id, {
    address: { ...ADDRESS, cityId: fixture.cityId },
  });
  const payment = await escrowPayments.createOrReusePayment({
    orderId: reservation.orderId,
    buyerId: buyer.id,
  });
  scenario = {
    orderId: reservation.orderId,
    reservationId: reservation.reservationId,
    paymentId: payment.paymentId,
  };
  await db.withTransaction(async (client) => {
    await client.query(
      `UPDATE reservations SET status = 'paid', paid_at = now()
       WHERE id = $1`,
      [scenario.reservationId]
    );
    await client.query(
      `UPDATE orders
       SET status = 'funded', funded_at = now() - INTERVAL '10 minutes',
           handover_deadline_at = now() + INTERVAL '71 hours 50 minutes'
       WHERE id = $1`,
      [scenario.orderId]
    );
    await client.query(
      `UPDATE payments SET status = 'succeeded', succeeded_at = now()
       WHERE id = $1`,
      [scenario.paymentId]
    );
  });
}

beforeEach(async () => {
  await setUpMoneyScenario();
});

afterEach(async () => {
  if (global.drainIntegrationListeners) await global.drainIntegrationListeners(5000);
});

afterAll(() => {
  setSharedRedisClient(originalRedisClient);
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('SEC-27 / FR-69 refund failure attention and Admin retry', () => {
  test('SEC-27: seven provider failures persist only safe codes and alert once when attention is newly set', async () => {
    const refundId = await insertRefund();
    const fakeCardNumber = '4111111111111111';
    const fakeToken = 'tok_refund_test_secret';
    const providerError = new Error(`Provider rejected card ${fakeCardNumber} with token ${fakeToken}`);
    const gateway = {
      createRefund: jest.fn().mockRejectedValue(providerError),
    };
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    let attentionTimestamp;
    let serializedFailure;
    try {
      const { serializeError } = await import('serialize-error');
      for (let attempt = 1; attempt <= 7; attempt += 1) {
        let thrown;
        try {
          await escrowPayments.processRefundJob({ refundId, gateway });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ statusCode: 503 });
        if (attempt === 1) serializedFailure = JSON.stringify(serializeError(thrown));

        const { rows } = await db.query(
          `SELECT attempt_count, last_error_code, needs_attention_at
           FROM refunds WHERE id = $1`,
          [refundId]
        );
        expect(rows[0].attempt_count).toBe(attempt);
        expect(REFUND_ERROR_CODES).toContain(rows[0].last_error_code);
        if (attempt < 6) {
          expect(rows[0].needs_attention_at).toBeNull();
        } else if (attempt === 6) {
          expect(rows[0].needs_attention_at).toBeInstanceOf(Date);
          attentionTimestamp = rows[0].needs_attention_at;
        } else {
          expect(rows[0].needs_attention_at).toEqual(attentionTimestamp);
        }
        const { rows: auditCount } = await db.query(
          `SELECT count(*)::int AS count FROM money_audit_events
           WHERE refund_id = $1 AND action = 'refund_needs_attention'`,
          [refundId]
        );
        expect(auditCount[0].count).toBe(attempt >= 6 ? 1 : 0);
        expect(consoleError).toHaveBeenCalledTimes(attempt >= 6 ? 1 : 0);
      }

      expect(serializedFailure).not.toContain(fakeCardNumber);
      expect(serializedFailure).not.toContain(fakeToken);
      const { rows: refundRows } = await db.query(
        'SELECT * FROM refunds WHERE id = $1',
        [refundId]
      );
      const { rows: auditRows } = await db.query(
        `SELECT * FROM money_audit_events
         WHERE refund_id = $1 AND action = 'refund_needs_attention'`,
        [refundId]
      );
      expect(JSON.stringify(refundRows)).not.toContain(fakeCardNumber);
      expect(JSON.stringify(refundRows)).not.toContain(fakeToken);
      expect(JSON.stringify(auditRows)).not.toContain(fakeCardNumber);
      expect(JSON.stringify(auditRows)).not.toContain(fakeToken);
      expect(auditRows).toHaveLength(1);
      expect(REFUND_ERROR_CODES).toContain(auditRows[0].metadata.lastErrorCode);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(fakeCardNumber);
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(fakeToken);
    } finally {
      consoleError.mockRestore();
    }
  });

  test('FR-69: attention listing is flagged-only by default and safely pages tied timestamps', async () => {
    const flagged = await Promise.all(Array.from({ length: 5 }, () => insertRefund({
      attemptCount: 6,
      needsAttentionAt: new Date('2026-11-08T12:00:00.000Z'),
    })));
    const unflagged = await insertRefund({ attemptCount: 2 });
    const defaultResponse = await get('/api/admin/refunds/attention')
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    expect(defaultResponse.body.refunds.map((refund) => refund.refundId)).toEqual(expect.arrayContaining(flagged));
    expect(defaultResponse.body.refunds.map((refund) => refund.refundId)).not.toContain(unflagged);
    const included = await get('/api/admin/refunds/attention?includeUnflagged=true').expect(200);
    expect(included.body.refunds.map((refund) => refund.refundId)).toEqual(expect.arrayContaining([...flagged, unflagged]));
    const encoded = JSON.stringify(defaultResponse.body);
    for (const field of ['providerPaymentRef', 'providerRefundRef', 'providerPaymentId', 'providerRefundId']) {
      expect(encoded).not.toContain(field);
    }
    expect(defaultResponse.body.refunds.every((refund) =>
      Object.keys(refund).every((field) => !/provider/i.test(field))
    )).toBe(true);

    const { rows: ordered } = await db.query(
      `SELECT id FROM refunds
       WHERE status = 'failed' AND needs_attention_at IS NOT NULL
       ORDER BY needs_attention_at DESC NULLS LAST, id DESC`
    );
    const walked = [];
    let before;
    do {
      const query = new URLSearchParams({ limit: '2' });
      if (before) query.set('before', before);
      const page = await get(`/api/admin/refunds/attention?${query.toString()}`).expect(200);
      walked.push(...page.body.refunds.map((refund) => refund.refundId));
      before = page.body.nextBefore;
    } while (before);
    expect(walked).toEqual(ordered.map((row) => row.id));
  });

  test('FR-69: attention query validates limit and cursor, and gates both Admin routes', async () => {
    const invalidQueries = [
      '?limit=0',
      '?limit=abc',
      '?limit=1.5',
      '?limit=1&limit=2',
      '?limit=500',
      '?before=bad',
      `?before=${crypto.randomUUID()}`,
    ];
    for (const query of invalidQueries) {
      await get(`/api/admin/refunds/attention${query}`).expect(400);
    }
    await get('/api/admin/refunds/attention', null).expect(401);
    await get('/api/admin/refunds/attention', buyer).expect(403);
    await postRetry(crypto.randomUUID(), null).expect(401);
    await postRetry(crypto.randomUUID(), buyer).expect(403);
  });

  test('FR-69: retry audits only a newly created job and returns false for a duplicate key', async () => {
    const refundId = await insertRefund({ attemptCount: 3, needsAttentionAt: new Date() });
    const first = await postRetry(refundId).expect(200).expect('Cache-Control', 'private, no-store');
    expect(first.body).toEqual({ refundId, status: 'failed', retryQueued: true });
    const duplicate = await postRetry(refundId).expect(200);
    expect(duplicate.body).toEqual({ refundId, status: 'failed', retryQueued: false });

    const { rows: jobRows } = await db.query(
      `SELECT id FROM pgboss.job
       WHERE name = $1 AND data->>'refundId' = $2`,
      [queue.QUEUES.REFUNDS, refundId]
    );
    const { rows: auditRows } = await db.query(
      `SELECT actor_id, action, metadata FROM money_audit_events
       WHERE refund_id = $1 AND action = 'refund_retry_requested'`,
      [refundId]
    );
    expect(jobRows).toHaveLength(1);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actor_id: admin.id,
      action: 'refund_retry_requested',
      metadata: { trigger: 'system_cancel', attemptCount: 3 },
    });
  });

  test('FR-69: ten parallel retry requests create one job and one retry audit', async () => {
    const refundId = await insertRefund({ attemptCount: 4, needsAttentionAt: new Date() });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => postRetry(refundId))
    );
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(results.filter((result) => result.body.retryQueued)).toHaveLength(1);
    expect(results.filter((result) => !result.body.retryQueued)).toHaveLength(9);
    const { rows: jobRows } = await db.query(
      `SELECT id FROM pgboss.job
       WHERE name = $1 AND data->>'refundId' = $2`,
      [queue.QUEUES.REFUNDS, refundId]
    );
    const { rows: auditRows } = await db.query(
      `SELECT id FROM money_audit_events
       WHERE refund_id = $1 AND action = 'refund_retry_requested'`,
      [refundId]
    );
    expect(jobRows).toHaveLength(1);
    expect(auditRows).toHaveLength(1);
  });

  test('FR-69: retry reports bad, missing, non-failed and released-manual refunds correctly', async () => {
    await postRetry('not-a-uuid').expect(400);
    await postRetry(crypto.randomUUID()).expect(404);
    const succeededId = await insertRefund({ status: 'succeeded' });
    await postRetry(succeededId).expect(409);

    const manualId = await insertRefund({ trigger: 'manual_admin', attemptCount: 6 });
    await db.query(
      `INSERT INTO payout_holds (order_id, hold_started_at, state, released_at)
       VALUES ($1, now() - INTERVAL '10 days', 'released', now())`,
      [scenario.orderId]
    );
    await postRetry(manualId).expect(409);
  });

  test('FR-70: reconciliation excludes capped refunds and still queues an eligible approved refund', async () => {
    const cappedIds = await Promise.all(Array.from({ length: 120 }, () => insertRefund({
      attemptCount: 6,
      lastAttemptAt: new Date(Date.now() - 60 * 60 * 1000),
    })));
    const approvedId = await insertRefund({
      status: 'approved',
      trigger: 'manual_admin',
      attemptCount: 0,
      lastAttemptAt: null,
    });
    await db.query(
      `UPDATE refunds SET approved_at = now() - INTERVAL '3 minutes'
       WHERE id = $1`,
      [approvedId]
    );

    await escrowPayments.reconcileMoneyState({ limit: 100, timeBudgetMs: 10000 });

    const { rows: cappedJobs } = await db.query(
      `SELECT id FROM pgboss.job
       WHERE name = $1 AND data->>'refundId' = ANY($2::text[])`,
      [queue.QUEUES.REFUNDS, cappedIds]
    );
    const { rows: eligibleJobs } = await db.query(
      `SELECT id FROM pgboss.job
       WHERE name = $1 AND data->>'refundId' = $2`,
      [queue.QUEUES.REFUNDS, approvedId]
    );
    expect(cappedJobs).toHaveLength(0);
    expect(eligibleJobs).toHaveLength(1);
  });
});
