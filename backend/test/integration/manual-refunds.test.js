const crypto = require('node:crypto');
const request = require('supertest');
const { getSharedRedisClient, setSharedRedisClient } = require('../../src/lib/redis');
const originalRedisClient = getSharedRedisClient();
const ADMIN_OPS_ENV_KEYS = [
  'RATE_LIMIT_ADMIN_OPS_IP_MAX',
  'RATE_LIMIT_ADMIN_OPS_ACCOUNT_MAX',
  'RATE_LIMIT_WINDOW_SECONDS',
];
const originalAdminOpsEnvironment = Object.fromEntries(
  ADMIN_OPS_ENV_KEYS.map((key) => [key, process.env[key]])
);
process.env.RATE_LIMIT_ADMIN_OPS_IP_MAX = '1000';
process.env.RATE_LIMIT_ADMIN_OPS_ACCOUNT_MAX = '1000';
process.env.RATE_LIMIT_WINDOW_SECONDS = '60';
setSharedRedisClient({ isOpen: true, eval: async () => [1, 1] });
const db = require('../../src/db.service');
const app = require('../../src/app');
const queue = require('../../src/lib/queue');
const users = require('../../src/modules/users.service');
const reservations = require('../../src/modules/reservations.service');
const escrowPayments = require('../../src/modules/escrowPayments.service');
const payout = require('../../src/modules/payout.service');
const { signAccessToken } = require('../../src/lib/jwt');
const { generateTotpSecret, generateTotpCode, encryptStaffTotpSecret } = require('../../src/lib/totp');
const { createFixture } = require('./fixtures');
const eventBus = require('../../src/lib/eventBus');
const events = require('../../src/lib/events');
const notifications = require('../../src/modules/notifications.service');
const moneyAudit = require('../../src/modules/moneyAudit.service');

const JWT_SECRET = 'manual-refunds-integration-access-secret';
const STAFF_TOTP_KEY = 'manual-refunds-integration-staff-totp-key';
const ADDRESS = {
  recipientName: 'Manual Refund Recipient',
  phone: '+15551234567',
  cityId: '',
  addressLine1: '12 Manual Refund Street',
};
const ENV_KEYS = [
  'JWT_ACCESS_SECRET',
  'STAFF_TOTP_ENCRYPTION_SECRET',
  'PAYMENTS_ENABLED',
  'PAYMENT_GATEWAY_PROVIDER',
  'FAKE_GATEWAY_WEBHOOK_SECRET',
  'PAYMENT_WEBHOOK_URL',
  'PUBLIC_BASE_URL',
  'NODE_ENV',
  ...ADMIN_OPS_ENV_KEYS,
];

let originalEnvironment;
let fixture;
let scenario;
let staff;
let buyerId;

afterAll(() => {
  setSharedRedisClient(originalRedisClient);
  for (const [key, value] of Object.entries(originalAdminOpsEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function authHeader(userId, sessionId) {
  return `Bearer ${signAccessToken(userId, { secret: JWT_SECRET, sessionId })}`;
}

function sendManualRequest(user, body) {
  return request(app)
    .post(`/api/admin/orders/${scenario.orderId}/refunds`)
    .set('Authorization', authHeader(user.id, user.sessionId))
    .send(body);
}

function sendDecision(user, refundId, decision, body) {
  return request(app)
    .post(`/api/admin/refunds/${refundId}/${decision}`)
    .set('Authorization', authHeader(user.id, user.sessionId))
    .send(body);
}

async function createStaffUser(userId, role = 'admin') {
  const secret = generateTotpSecret();
  const encrypted = encryptStaffTotpSecret(secret);
  if (userId) {
    await db.query("UPDATE users SET role = $2, is_suspended = false WHERE id = $1", [userId, role]);
  } else {
    const suffix = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO users (full_name, phone, password_hash, city_id, role)
       VALUES ($1, $2, 'manual-refund-test-hash', $3, $4)
       RETURNING id`,
      [
        `Manual refund ${role} ${suffix}`,
        `+1558${Date.now().toString().slice(-9)}${suffix.replace(/\D/g, '').slice(0, 3)}`,
        fixture.cityId,
        role,
      ]
    );
    userId = rows[0].id;
  }
  if (role === 'admin') {
    await db.query(
      `INSERT INTO staff_totp_credentials
         (user_id, encrypted_secret, nonce, auth_tag, key_version, enabled_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [userId, encrypted.encryptedSecret, encrypted.nonce, encrypted.authTag, encrypted.keyVersion]
    );
  }
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

async function createAdditionalSession(userId) {
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
  return sessionId;
}

async function createGrant(user, action) {
  const { grant } = await users.createStepUpGrant(
    user.id,
    user.sessionId,
    action,
    generateTotpCode(user.secret)
  );
  return grant;
}

async function insertGrant(user, action) {
  const grant = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO step_up_grants (token_hash, user_id, session_id, action, expires_at)
     VALUES ($1, $2, $3, $4, now() + INTERVAL '5 minutes')`,
    [
      crypto.createHash('sha256').update(grant).digest('hex'),
      user.id,
      user.sessionId,
      action,
    ]
  );
  return grant;
}

async function createScenario() {
  const reservation = await reservations.buyListing(fixture.listingId, buyerId, {
    address: { ...ADDRESS, cityId: fixture.cityId },
  });
  const payment = await escrowPayments.createOrReusePayment({
    orderId: reservation.orderId,
    buyerId,
  });
  scenario = {
    orderId: reservation.orderId,
    reservationId: reservation.reservationId,
    paymentId: payment.paymentId,
    listingId: fixture.listingId,
    buyerId,
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
      `UPDATE payments
       SET status = 'succeeded', succeeded_at = now()
       WHERE id = $1`,
      [scenario.paymentId]
    );
  });
}

async function preparePayoutRelease() {
  await db.query(
    `UPDATE orders SET status = 'held', delivered_at = now() - INTERVAL '1 day'
     WHERE id = $1`,
    [scenario.orderId]
  );
  await db.query(
    `INSERT INTO payout_holds
       (order_id, hold_started_at, hold_window_days, complaint_window_days, state)
     VALUES ($1, now() - INTERVAL '10 days', 0, 0, 'held')`,
    [scenario.orderId]
  );
}

async function createRequest(user = staff.first, overrides = {}) {
  const stepUpGrant = overrides.stepUpGrant || await createGrant(user, 'refund.request');
  return sendManualRequest(user, {
    reason: 'Customer service reviewed the delivery issue.',
    ...overrides,
    stepUpGrant,
  });
}

async function processRefundNotification(refundId, status, eventType, buyerMessage, sellerMessage) {
  await global.drainIntegrationListeners(5000);
  const eventPayload = { refundId, orderId: scenario.orderId, status };
  let { rows: jobs } = await db.query(
    `SELECT data FROM pgboss.job
     WHERE name = $1 AND data->>'eventName' = $2
       AND data->'payload'->>'refundId' = $3`,
    [queue.QUEUES.NOTIFICATIONS, events.REFUND_STATUS_CHANGED, refundId]
  );
  expect(jobs).toHaveLength(1);

  eventBus.emit(events.REFUND_STATUS_CHANGED, eventPayload);
  await global.drainIntegrationListeners(5000);
  ({ rows: jobs } = await db.query(
    `SELECT data FROM pgboss.job
     WHERE name = $1 AND data->>'eventName' = $2
       AND data->'payload'->>'refundId' = $3`,
    [queue.QUEUES.NOTIFICATIONS, events.REFUND_STATUS_CHANGED, refundId]
  ));
  expect(jobs).toHaveLength(1);

  const transactionDb = {
    executeSql: (text, values = []) => transactionDb.client.query(text, values),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await db.withTransaction(async (client) => {
      transactionDb.client = client;
      await notifications.processNotificationJob(jobs[0].data, transactionDb);
    });
  }

  const { rows } = await db.query(
    `SELECT user_id, event_type, payload, dedupe_key
     FROM notifications
     WHERE user_id = ANY($1::uuid[]) AND dedupe_key = $2`,
    [[buyerId, fixture.userId], `${eventType}:${refundId}`]
  );
  expect(rows).toHaveLength(2);
  const byUser = new Map(rows.map((row) => [row.user_id, row]));
  expect(byUser.get(buyerId)).toMatchObject({
    event_type: eventType,
    dedupe_key: `${eventType}:${refundId}`,
    payload: {
      orderId: scenario.orderId,
      message: buyerMessage,
      href: `/orders/${scenario.orderId}`,
    },
  });
  expect(byUser.get(fixture.userId)).toMatchObject({
    event_type: eventType,
    dedupe_key: `${eventType}:${refundId}`,
    payload: {
      orderId: scenario.orderId,
      message: sellerMessage,
      href: `/seller/orders/${scenario.orderId}`,
    },
  });
  expect(JSON.stringify(rows)).not.toContain('approvedBy');
  expect(JSON.stringify(rows)).not.toContain('provider');
}

async function expectNoRefundNotificationJob(refundId) {
  await global.drainIntegrationListeners(5000);
  const { rows } = await db.query(
    `SELECT id FROM pgboss.job
     WHERE name = $1 AND data->>'eventName' = $2
       AND data->'payload'->>'refundId' = $3`,
    [queue.QUEUES.NOTIFICATIONS, events.REFUND_STATUS_CHANGED, refundId]
  );
  expect(rows).toHaveLength(0);
}

beforeEach(async () => {
  originalEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET = JWT_SECRET;
  process.env.STAFF_TOTP_ENCRYPTION_SECRET = STAFF_TOTP_KEY;
  process.env.PAYMENTS_ENABLED = '1';
  process.env.PAYMENT_GATEWAY_PROVIDER = 'fake';
  process.env.FAKE_GATEWAY_WEBHOOK_SECRET = 'manual-refund-test-webhook-secret';
  process.env.PAYMENT_WEBHOOK_URL = 'http://127.0.0.1:39991/api/webhooks/payments/fake';
  process.env.PUBLIC_BASE_URL = 'http://localhost:5173';

  fixture = await createFixture({ askingPrice: '1250.50', listingStatus: 'published' });
  await db.query(
    `INSERT INTO supported_delivery_cities (city_id, active)
     VALUES ($1, true) ON CONFLICT (city_id) DO UPDATE SET active = true`,
    [fixture.cityId]
  );
  const suffix = crypto.randomUUID();
  const { rows: buyerRows } = await db.query(
    `INSERT INTO users (full_name, phone, password_hash, city_id, role)
     VALUES ($1, $2, 'manual-refund-buyer-hash', $3, 'buyer')
     RETURNING id`,
    [
      `Manual refund buyer ${suffix}`,
      `+1556${Date.now().toString().slice(-9)}${suffix.replace(/\D/g, '').slice(0, 3)}`,
      fixture.cityId,
    ]
  );
  buyerId = buyerRows[0].id;
  staff = {
    first: await createStaffUser(fixture.otherUserId),
    second: await createStaffUser(fixture.userId),
    third: await createStaffUser(null),
    moderator: await createStaffUser(null, 'moderator'),
  };
  await createScenario();
  if (global.drainIntegrationListeners) await global.drainIntegrationListeners(5000);
});

afterEach(async () => {
  try {
    if (global.drainIntegrationListeners) await global.drainIntegrationListeners(5000);
  } finally {
    for (const [key, value] of Object.entries(originalEnvironment || {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

describe('FR-69 / SEC-39 manual two-Admin refund workflow', () => {
  test('FR-69, SEC-39: request then approve enqueues one refund and calls the gateway once with its idempotency key', async () => {
    const requestGrant = await createGrant(staff.first, 'refund.request');
    const requested = await sendManualRequest(staff.first, {
      reason: '  Customer service reviewed the delivery issue.  ',
      amount: '0.01',
      stepUpGrant: requestGrant,
    })
      .expect(201)
      .expect('Cache-Control', 'private, no-store');
    expect(requested.body).toMatchObject({
      status: 'requested',
      amount: '1550.50',
      currency: 'PKR',
    });

    const decisionGrant = await createGrant(staff.second, 'refund.decide');
    await sendDecision(staff.second, requested.body.refundId, 'approve', {
      reason: '  Second administrator approved this refund.  ',
      stepUpGrant: decisionGrant,
    })
      .expect(200)
      .expect('Cache-Control', 'private, no-store')
      .expect(({ body }) => expect(body).toEqual({
        refundId: requested.body.refundId,
        status: 'approved',
        decision: 'approved',
      }));

    const { rows: refundRows } = await db.query(
      `SELECT idempotency_key, status
       FROM refunds WHERE id = $1`,
      [requested.body.refundId]
    );
    const gateway = {
      createRefund: jest.fn(async ({ amount, idempotencyKey, providerPaymentRef }) => ({
        providerRefundRef: `manual-provider-ref-${crypto.randomUUID()}`,
        providerPaymentRef,
        amount,
        status: 'succeeded',
        receivedIdempotencyKey: idempotencyKey,
      })),
    };
    const firstJob = await escrowPayments.processRefundJob({
      refundId: requested.body.refundId,
      gateway,
    });
    const repeatedJob = await escrowPayments.processRefundJob({
      refundId: requested.body.refundId,
      gateway,
    });

    expect(firstJob).toMatchObject({ outcome: 'succeeded', refundId: requested.body.refundId });
    expect(repeatedJob).toMatchObject({ outcome: 'skipped', status: 'succeeded' });
    expect(gateway.createRefund).toHaveBeenCalledTimes(1);
    expect(gateway.createRefund.mock.calls[0][0].idempotencyKey).toBe(refundRows[0].idempotency_key);
    const { rows: noteRows } = await db.query(
      'SELECT reason, decision_note FROM refunds WHERE id = $1',
      [requested.body.refundId]
    );
    expect(noteRows[0]).toEqual({
      reason: 'Customer service reviewed the delivery issue.',
      decision_note: 'Second administrator approved this refund.',
    });

    const { rows: auditRows } = await db.query(
      `SELECT action, actor_id, order_id, refund_id, requested_by, approved_by, reason, metadata
       FROM money_audit_events
       WHERE refund_id = $1 AND action IN ('manual_refund_requested', 'manual_refund_approved')
       ORDER BY created_at`,
      [requested.body.refundId]
    );
    expect(auditRows.map((row) => row.action)).toEqual([
      'manual_refund_requested',
      'manual_refund_approved',
    ]);
    expect(auditRows[0]).toMatchObject({
      actor_id: staff.first.id,
      order_id: scenario.orderId,
      refund_id: requested.body.refundId,
      requested_by: staff.first.id,
    });
    expect(JSON.stringify(auditRows)).not.toContain(requestGrant);
    expect(JSON.stringify(auditRows)).not.toContain(decisionGrant);
    expect(JSON.stringify(auditRows)).not.toMatch(/"amount"\s*:/);
    await processRefundNotification(
      requested.body.refundId,
      'succeeded',
      'refund_succeeded',
      'Your refund was processed: PKR 1550.50.',
      'A refund was issued for your sale: PKR 1550.50.'
    );
  });

  test('FR-51: a failed manual refund notifies the buyer and seller once with the stored amount', async () => {
    const requested = await createRequest();
    await sendDecision(staff.second, requested.body.refundId, 'approve', {
      reason: 'Second administrator approved this refund.',
      stepUpGrant: await createGrant(staff.second, 'refund.decide'),
    }).expect(200);
    await expect(escrowPayments.processRefundJob({
      refundId: requested.body.refundId,
      gateway: { createRefund: jest.fn().mockRejectedValue(new Error('gateway unavailable')) },
    })).rejects.toMatchObject({ statusCode: 503 });

    await processRefundNotification(
      requested.body.refundId,
      'failed',
      'refund_failed',
      'Your refund could not be processed: PKR 1550.50.',
      'A refund for your sale could not be processed: PKR 1550.50.'
    );
  });

  test('FR-51: a rejected manual refund request notifies the buyer and seller once with the stored amount', async () => {
    const requested = await createRequest();
    await sendDecision(staff.second, requested.body.refundId, 'reject', {
      reason: 'Second administrator declined this refund.',
      stepUpGrant: await createGrant(staff.second, 'refund.decide'),
    }).expect(200);

    await processRefundNotification(
      requested.body.refundId,
      'rejected',
      'refund_request_rejected',
      'Your refund request was declined: PKR 1550.50.',
      'A refund request for your sale was declined: PKR 1550.50.'
    );
  });

  test('FR-51: a rejected refund notification is not queued when its transaction rolls back', async () => {
    const requested = await createRequest();
    const auditSpy = jest.spyOn(moneyAudit, 'recordMoneyAuditEvent')
      .mockRejectedValueOnce(new Error('integration rollback'));
    try {
      await expect(escrowPayments.decideManualRefund(
        requested.body.refundId,
        staff.second.id,
        staff.second.sessionId,
        {
          decision: 'rejected',
          reason: 'Second administrator declined this refund.',
          stepUpGrant: await createGrant(staff.second, 'refund.decide'),
        },
        { isOrderPayoutReleased: async () => false }
      )).rejects.toThrow('integration rollback');
    } finally {
      auditSpy.mockRestore();
    }

    const { rows } = await db.query('SELECT status FROM refunds WHERE id = $1', [requested.body.refundId]);
    expect(rows[0].status).toBe('requested');
    await expectNoRefundNotificationJob(requested.body.refundId);
  });

  test('FR-51: an expired manual refund request notifies the buyer and seller once with the stored amount', async () => {
    const requested = await createRequest();
    await db.query(
      `UPDATE refunds SET requested_at = now() - INTERVAL '49 hours' WHERE id = $1`,
      [requested.body.refundId]
    );
    await escrowPayments.getRefundableBalance(scenario.orderId, staff.second.id);

    await processRefundNotification(
      requested.body.refundId,
      'expired',
      'refund_request_expired',
      'Your refund request expired: PKR 1550.50.',
      'A refund request for your sale expired: PKR 1550.50.'
    );
  });

  test('FR-51: an expired refund notification is not queued when its transaction rolls back', async () => {
    const requested = await createRequest();
    await db.query(
      `UPDATE refunds SET requested_at = now() - INTERVAL '49 hours' WHERE id = $1`,
      [requested.body.refundId]
    );
    const auditSpy = jest.spyOn(moneyAudit, 'recordMoneyAuditEvent')
      .mockRejectedValueOnce(new Error('integration rollback'));
    try {
      await expect(escrowPayments.getRefundableBalance(scenario.orderId, staff.second.id))
        .rejects.toThrow('integration rollback');
    } finally {
      auditSpy.mockRestore();
    }

    const { rows } = await db.query('SELECT status FROM refunds WHERE id = $1', [requested.body.refundId]);
    expect(rows[0].status).toBe('requested');
    await expectNoRefundNotificationJob(requested.body.refundId);
  });

  test('FR-69: Admin refund reads expose queue and detail metadata without provider data', async () => {
    const requested = await createRequest();
    const list = await request(app)
      .get('/api/admin/refunds?limit=20')
      .set('Authorization', authHeader(staff.second.id, staff.second.sessionId))
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    const item = list.body.refunds.find((refund) => refund.refundId === requested.body.refundId);
    expect(item).toMatchObject({
      refundId: requested.body.refundId,
      orderId: scenario.orderId,
      status: 'requested',
      amount: '1550.50',
      currency: 'PKR',
      requestedBy: staff.first.id,
      requestedByMe: false,
    });
    expect(Date.parse(item.expiresAt) - Date.parse(item.requestedAt)).toBe(48 * 60 * 60 * 1000);
    expect(item).not.toHaveProperty('providerRefundId');

    const detail = await request(app)
      .get(`/api/admin/refunds/${requested.body.refundId}`)
      .set('Authorization', authHeader(staff.first.id, staff.first.sessionId))
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    expect(detail.body).toMatchObject({
      refundId: requested.body.refundId,
      orderId: scenario.orderId,
      requestedBy: staff.first.id,
      requestedByMe: true,
      reason: 'Customer service reviewed the delivery issue.',
    });
    expect(detail.body).not.toHaveProperty('providerRefundId');
    expect(detail.body).not.toHaveProperty('idempotencyKey');
  });

  test('FR-69: queue and detail reads expose expiry without changing refund rows', async () => {
    const agesInMinutes = [2879, 2880, 2940];
    const idempotencyPrefix = `manual-refund-read-expiry:${crypto.randomUUID()}`;
    const { rows: insertedRows } = await db.query(
      `INSERT INTO refunds
         (payment_id, order_id, trigger, amount, currency, status, idempotency_key,
          reason, requested_by, requested_at)
       SELECT $1, $2, 'manual_admin', '1.00', 'PKR', 'requested',
              $3 || '-' || sample.age_minutes::text,
              'Read-only expiry status test', $4,
              now() - sample.age_minutes * INTERVAL '1 minute'
       FROM unnest($5::int[]) AS sample(age_minutes)
       RETURNING id, idempotency_key`,
      [scenario.paymentId, scenario.orderId, idempotencyPrefix, staff.first.id, agesInMinutes]
    );
    expect(insertedRows).toHaveLength(3);
    const idByAge = new Map(agesInMinutes.map((age) => [
      age,
      insertedRows.find((row) => row.idempotency_key === `${idempotencyPrefix}-${age}`).id,
    ]));
    const refundIds = [...idByAge.values()];
    const { rows: beforeReads } = await db.query(
      `SELECT id, status, approved_by, decided_at, requested_at, updated_at
       FROM refunds
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [refundIds]
    );

    const list = await request(app)
      .get('/api/admin/refunds?limit=50')
      .set('Authorization', authHeader(staff.second.id, staff.second.sessionId))
      .expect(200);
    const listById = new Map(list.body.refunds.map((refund) => [refund.refundId, refund]));
    const expectedStatuses = new Map([
      [2879, 'requested'],
      [2880, 'expired'],
      [2940, 'expired'],
    ]);
    for (const [age, refundId] of idByAge) {
      expect(listById.get(refundId).status).toBe(expectedStatuses.get(age));
      const detail = await request(app)
        .get(`/api/admin/refunds/${refundId}`)
        .set('Authorization', authHeader(staff.second.id, staff.second.sessionId))
        .expect(200);
      expect(detail.body.status).toBe(expectedStatuses.get(age));
    }

    const { rows: afterReads } = await db.query(
      `SELECT id, status, approved_by, decided_at, requested_at, updated_at
       FROM refunds
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [refundIds]
    );
    expect(afterReads).toEqual(beforeReads);
  });

  test('FR-69: keyset pagination includes every manual refund when requested times differ by microseconds', async () => {
    const { rows: insertedRows } = await db.query(
      `INSERT INTO refunds
         (payment_id, order_id, trigger, amount, currency, status, idempotency_key,
          reason, requested_by, approved_by, requested_at, decided_at)
       SELECT $1, $2, 'manual_admin', '1.00', 'PKR', 'rejected',
              $3 || '-' || sample.ordinality::text,
              'Pagination microsecond cursor test', $4, $5,
              date_trunc('second', now()) - INTERVAL '1 hour'
                + sample.microseconds * INTERVAL '1 microsecond',
              now()
       FROM unnest($6::int[]) WITH ORDINALITY AS sample(microseconds, ordinality)
       RETURNING id`,
      [
        scenario.paymentId,
        scenario.orderId,
        `manual-refund-pagination:${crypto.randomUUID()}`,
        staff.first.id,
        staff.second.id,
        [123100, 123200, 123300, 123400, 500000],
      ]
    );
    expect(insertedRows).toHaveLength(5);

    const { rows: expectedRows } = await db.query(
      `SELECT id
       FROM refunds
       WHERE trigger = 'manual_admin'
       ORDER BY requested_at DESC, id DESC`
    );
    const actualIds = [];
    let before = null;
    do {
      const query = new URLSearchParams({ limit: '2' });
      if (before) query.set('before', before);
      const page = await request(app)
        .get(`/api/admin/refunds?${query}`)
        .set('Authorization', authHeader(staff.second.id, staff.second.sessionId))
        .expect(200);
      actualIds.push(...page.body.refunds.map((refund) => refund.refundId));
      before = page.body.nextBefore;
    } while (before);

    expect(new Set(actualIds).size).toBe(actualIds.length);
    expect(actualIds).toEqual(expectedRows.map((row) => row.id));
    expect(actualIds).toEqual(expect.arrayContaining(insertedRows.map((row) => row.id)));
  });

  test('FR-69, SEC-39: rejection is final and a new request creates a different refund idempotency key', async () => {
    const requested = await createRequest();
    await sendDecision(staff.second, requested.body.refundId, 'reject', {
      reason: 'The available order information does not support a refund.',
      stepUpGrant: await createGrant(staff.second, 'refund.decide'),
    }).expect(200).expect('Cache-Control', 'private, no-store');
    const afterReject = await db.query(
      'SELECT status, idempotency_key, approved_by, decided_at FROM refunds WHERE id = $1',
      [requested.body.refundId]
    );
    expect(afterReject.rows[0]).toMatchObject({
      status: 'rejected',
      approved_by: staff.second.id,
    });
    expect(afterReject.rows[0].decided_at).not.toBeNull();

    const replacement = await createRequest(staff.third);
    expect(replacement.status).toBe(201);
    const replacementRows = await db.query(
      'SELECT idempotency_key FROM refunds WHERE id = $1',
      [replacement.body.refundId]
    );
    expect(replacement.body.refundId).not.toBe(requested.body.refundId);
    expect(replacementRows.rows[0].idempotency_key).not.toBe(afterReject.rows[0].idempotency_key);
  });

  test.each(['approve', 'reject'])('SEC-39: requester cannot self-%s a manual refund', async (decision) => {
    const requested = await createRequest();
    await sendDecision(staff.first, requested.body.refundId, decision, {
      reason: 'This decision note is long enough for validation.',
    }).expect(403);
    const { rows } = await db.query('SELECT status FROM refunds WHERE id = $1', [requested.body.refundId]);
    expect(rows[0].status).toBe('requested');
  });

  test('SEC-39: non-Admin cannot read balance, request, or decide a refund', async () => {
    const token = authHeader(staff.moderator.id, staff.moderator.sessionId);
    await request(app)
      .get(`/api/admin/orders/${scenario.orderId}/refundable-balance`)
      .set('Authorization', token)
      .expect(403)
      .expect('Cache-Control', 'private, no-store');
    await request(app)
      .post(`/api/admin/orders/${scenario.orderId}/refunds`)
      .set('Authorization', token)
      .send({ reason: 'Customer service reviewed the delivery issue.', stepUpGrant: 'irrelevant' })
      .expect(403)
      .expect('Cache-Control', 'private, no-store');
    await sendDecision(staff.moderator, crypto.randomUUID(), 'approve', {
      reason: 'This decision note is long enough for validation.',
      stepUpGrant: 'irrelevant',
    }).expect(403).expect('Cache-Control', 'private, no-store');
  });

  test('SEC-39: missing, foreign, consumed, and wrong-action grants are rejected', async () => {
    await sendManualRequest(staff.first, {
      reason: 'Customer service reviewed the delivery issue.',
    }).expect(403);

    const foreignGrant = await createGrant(staff.second, 'refund.request');
    await sendManualRequest(staff.first, {
      reason: 'Customer service reviewed the delivery issue.',
      stepUpGrant: foreignGrant,
    }).expect(403);

    const sessionBoundGrant = await createGrant(staff.third, 'refund.request');
    const alternateSession = await createAdditionalSession(staff.third.id);
    await sendManualRequest(
      { ...staff.third, sessionId: alternateSession },
      {
        reason: 'Customer service reviewed the delivery issue.',
        stepUpGrant: sessionBoundGrant,
      }
    ).expect(403);

    const wrongActionGrant = await insertGrant(staff.first, 'refund.decide');
    await sendManualRequest(staff.first, {
      reason: 'Customer service reviewed the delivery issue.',
      stepUpGrant: wrongActionGrant,
    }).expect(403);

    const consumedGrant = await createGrant(staff.first, 'refund.request');
    await sendManualRequest(staff.first, {
      reason: 'Customer service reviewed the delivery issue.',
      stepUpGrant: consumedGrant,
    }).expect(201);
    await expect(users.consumeStepUpGrant(
      staff.first.id,
      staff.first.sessionId,
      'refund.request',
      consumedGrant
    )).rejects.toMatchObject({ statusCode: 403 });
  });

  test('FR-69: invalid request reasons and decision notes are rejected with 400', async () => {
    await sendManualRequest(staff.first, {
      reason: 'too short',
      stepUpGrant: 'not-consumed',
    }).expect(400);
    const requested = await createRequest();
    await sendDecision(staff.second, requested.body.refundId, 'reject', {
      reason: '  too short  ',
      stepUpGrant: 'not-consumed',
    }).expect(400);
  });

  test('FR-69: one open request per order is enforced and client amounts are ignored', async () => {
    const requested = await createRequest(staff.first, { amount: '1.00' });
    expect(requested.body.amount).toBe('1550.50');
    expect((await createRequest(staff.second)).status).toBe(409);
  });

  test('FR-77a: orphan refund reconciliation does not enqueue a manual request before approval', async () => {
    const requested = await createRequest();
    await db.query(
      `UPDATE refunds
       SET requested_at = now() - INTERVAL '3 minutes'
       WHERE id = $1`,
      [requested.body.refundId]
    );
    await escrowPayments.reconcileMoneyState({ limit: 10, timeBudgetMs: 1000 });

    const { rows: jobRows } = await db.query(
      `SELECT count(*)::int AS count
       FROM pgboss.job
       WHERE name = $1 AND data->>'refundId' = $2`,
      [queue.QUEUES.REFUNDS, requested.body.refundId]
    );
    expect(jobRows[0].count).toBe(0);
    const { rows: refundRows } = await db.query(
      'SELECT status FROM refunds WHERE id = $1',
      [requested.body.refundId]
    );
    expect(refundRows[0].status).toBe('requested');
  });

  test('FR-77a: refund-job enqueue failure rolls back approval, audit, and step-up consumption', async () => {
    const requested = await createRequest();
    const grant = await createGrant(staff.second, 'refund.decide');
    const enqueue = jest.spyOn(queue, 'enqueue').mockRejectedValueOnce(new Error('test enqueue failure'));
    try {
      await sendDecision(staff.second, requested.body.refundId, 'approve', {
        reason: 'Second administrator approved this refund.',
        stepUpGrant: grant,
      }).expect(500);
    } finally {
      enqueue.mockRestore();
    }

    const { rows: refundRows } = await db.query(
      'SELECT status, approved_by, decided_at FROM refunds WHERE id = $1',
      [requested.body.refundId]
    );
    expect(refundRows[0]).toMatchObject({
      status: 'requested',
      approved_by: null,
      decided_at: null,
    });
    const digest = crypto.createHash('sha256').update(grant).digest('hex');
    const { rows: grantRows } = await db.query(
      'SELECT consumed_at FROM step_up_grants WHERE token_hash = $1',
      [digest]
    );
    expect(grantRows[0].consumed_at).toBeNull();
    const { rows: auditRows } = await db.query(
      `SELECT count(*)::int AS count
       FROM money_audit_events
       WHERE refund_id = $1 AND action = 'manual_refund_approved'`,
      [requested.body.refundId]
    );
    expect(auditRows[0].count).toBe(0);
  });

  test('FR-69: a request at the 48-hour boundary expires on balance read and cannot be decided', async () => {
    const requested = await createRequest();
    await db.query(
      `UPDATE refunds
       SET requested_at = now() - INTERVAL '48 hours'
       WHERE id = $1`,
      [requested.body.refundId]
    );

    const balance = await request(app)
      .get(`/api/admin/orders/${scenario.orderId}/refundable-balance`)
      .set('Authorization', authHeader(staff.second.id, staff.second.sessionId))
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    expect(balance.body.refundableAmount.total).toBe('1550.50');
    await sendDecision(staff.second, requested.body.refundId, 'approve', {
      reason: 'Second administrator approved this refund.',
      stepUpGrant: await createGrant(staff.second, 'refund.decide'),
    }).expect(409);

    const { rows: refundRows } = await db.query(
      'SELECT status, approved_by, decided_at FROM refunds WHERE id = $1',
      [requested.body.refundId]
    );
    expect(refundRows[0]).toMatchObject({ status: 'expired', approved_by: staff.second.id });
    expect(refundRows[0].decided_at).not.toBeNull();
    const { rows: audits } = await db.query(
      `SELECT action, actor_id, order_id, refund_id
       FROM money_audit_events WHERE refund_id = $1`,
      [requested.body.refundId]
    );
    expect(audits.some((row) => row.action === 'manual_refund_expired' &&
      row.actor_id === staff.second.id && row.order_id === scenario.orderId)).toBe(true);
  });

  test('FR-69: decision evaluates request expiry at the 48-hour boundary and moves no money', async () => {
    const requested = await createRequest();
    await db.query(
      `UPDATE refunds
       SET requested_at = now() - INTERVAL '48 hours'
       WHERE id = $1`,
      [requested.body.refundId]
    );
    await sendDecision(staff.second, requested.body.refundId, 'reject', {
      reason: 'Second administrator rejected this refund.',
      stepUpGrant: await createGrant(staff.second, 'refund.decide'),
    }).expect(409);
    const { rows } = await db.query(
      `SELECT status FROM refunds WHERE id = $1`,
      [requested.body.refundId]
    );
    expect(rows[0].status).toBe('expired');
    const { rows: jobRows } = await db.query(
      `SELECT count(*)::int AS count
       FROM pgboss.job
       WHERE name = $1 AND data->>'refundId' = $2`,
      [queue.QUEUES.REFUNDS, requested.body.refundId]
    );
    expect(jobRows[0].count).toBe(0);
  });

  test('FR-69: refundable balance subtracts earlier successful partial refunds and splits the remainder', async () => {
    await db.query(
      `INSERT INTO refunds
         (payment_id, order_id, trigger, amount, currency, status, idempotency_key, reason)
       VALUES ($1, $2, 'system_cancel', '300.00', 'PKR', 'succeeded', $3, 'Earlier partial refund')`,
      [scenario.paymentId, scenario.orderId, `prior-partial:${crypto.randomUUID()}`]
    );
    const response = await request(app)
      .get(`/api/admin/orders/${scenario.orderId}/refundable-balance`)
      .set('Authorization', authHeader(staff.first.id, staff.first.sessionId))
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    const { total, itemPrice, deliveryFee } = response.body.refundableAmount;
    expect(total).toBe('1250.50');
    expect((Number(itemPrice) + Number(deliveryFee)).toFixed(2)).toBe(total);
    expect({ itemPrice, deliveryFee }).toEqual({
      itemPrice: '1008.55',
      deliveryFee: '241.95',
    });
  });

  test('FR-69: a manual refund request is refused after payout has been released', async () => {
    await db.query(
      `INSERT INTO payout_holds (order_id, hold_started_at, state, released_at)
       VALUES ($1, now() - INTERVAL '1 day', 'released', now())`,
      [scenario.orderId]
    );
    expect((await createRequest()).status).toBe(409);
  });

  test('FR-65, FR-69: payout release is blocked while a manual refund request is open', async () => {
    await preparePayoutRelease();
    await createRequest();
    await expect(payout.releaseReservationPayout(scenario.orderId, staff.third.id, {
      payoutReference: 'test-manual-payout-reference',
      note: 'Payout release is blocked by the open refund request.',
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  test('FR-69: payout release expires a 49-hour-old manual request and audits the releasing Admin', async () => {
    await preparePayoutRelease();
    const requested = await createRequest();
    await db.query(
      `UPDATE refunds SET requested_at = now() - INTERVAL '49 hours' WHERE id = $1`,
      [requested.body.refundId]
    );

    await expect(payout.releaseReservationPayout(scenario.orderId, staff.third.id, {
      payoutReference: 'test-manual-payout-reference',
      note: 'Payout release follows the expired refund request.',
    })).resolves.toMatchObject({ orderId: scenario.orderId });

    const { rows: refundRows } = await db.query(
      `SELECT status, approved_by, decided_at, decision_note
       FROM refunds WHERE id = $1`,
      [requested.body.refundId]
    );
    expect(refundRows[0]).toMatchObject({
      status: 'expired',
      approved_by: staff.third.id,
      decision_note: 'Expired automatically after 48 hours without a decision.',
    });
    expect(refundRows[0].decided_at).not.toBeNull();
    const { rows: auditRows } = await db.query(
      `SELECT action, actor_id, count(*) OVER ()::int AS count
       FROM money_audit_events
       WHERE refund_id = $1 AND action = 'manual_refund_expired'`,
      [requested.body.refundId]
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ action: 'manual_refund_expired', actor_id: staff.third.id, count: 1 });
    await processRefundNotification(
      requested.body.refundId,
      'expired',
      'refund_request_expired',
      'Your refund request expired: PKR 1550.50.',
      'A refund request for your sale expired: PKR 1550.50.'
    );
  });

  test('FR-69: a 47-hour-59-minute-old manual request still blocks payout release', async () => {
    await preparePayoutRelease();
    const requested = await createRequest();
    await db.query(
      `UPDATE refunds SET requested_at = now() - INTERVAL '47 hours 59 minutes' WHERE id = $1`,
      [requested.body.refundId]
    );

    await expect(payout.releaseReservationPayout(scenario.orderId, staff.third.id, {
      payoutReference: 'test-manual-payout-reference',
      note: 'Payout release remains blocked by a pending refund.',
    })).rejects.toMatchObject({ statusCode: 409 });
    const { rows } = await db.query('SELECT status FROM refunds WHERE id = $1', [requested.body.refundId]);
    expect(rows[0].status).toBe('requested');
  });

  test.each(['approved', 'pending'])('FR-69: an old %s manual request still blocks payout release', async (status) => {
    await preparePayoutRelease();
    const requested = await createRequest();
    await db.query(
      `UPDATE refunds
       SET status = $2, requested_at = now() - INTERVAL '90 days',
           approved_by = $3, decided_at = now() - INTERVAL '90 days'
       WHERE id = $1`,
      [requested.body.refundId, status, staff.third.id]
    );

    await expect(payout.releaseReservationPayout(scenario.orderId, staff.third.id, {
      payoutReference: 'test-manual-payout-reference',
      note: 'Payout release remains blocked by an active refund.',
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  test('FR-69: concurrent request-versus-request has exactly one winner', async () => {
    const [grantA, grantB] = await Promise.all([
      createGrant(staff.first, 'refund.request'),
      createGrant(staff.second, 'refund.request'),
    ]);
    const results = await Promise.all([
      sendManualRequest(staff.first, {
        reason: 'First administrator requested a full refund.',
        stepUpGrant: grantA,
      }),
      sendManualRequest(staff.second, {
        reason: 'Second administrator requested a full refund.',
        stepUpGrant: grantB,
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const { rows } = await db.query(
      `SELECT count(*)::int AS count FROM refunds
       WHERE order_id = $1 AND trigger = 'manual_admin' AND status = 'requested'`,
      [scenario.orderId]
    );
    expect(rows[0].count).toBe(1);
  });

  test('FR-69, SEC-39: concurrent approve-versus-approve has exactly one winner', async () => {
    const requested = await createRequest();
    const [grantA, grantB] = await Promise.all([
      createGrant(staff.second, 'refund.decide'),
      createGrant(staff.third, 'refund.decide'),
    ]);
    const results = await Promise.all([
      sendDecision(staff.second, requested.body.refundId, 'approve', {
        reason: 'Second administrator approved the refund.',
        stepUpGrant: grantA,
      }),
      sendDecision(staff.third, requested.body.refundId, 'approve', {
        reason: 'Third administrator approved the refund.',
        stepUpGrant: grantB,
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  });

  test('FR-69, SEC-39: concurrent approve-versus-reject has exactly one winner', async () => {
    const requested = await createRequest();
    const [grantA, grantB] = await Promise.all([
      createGrant(staff.second, 'refund.decide'),
      createGrant(staff.third, 'refund.decide'),
    ]);
    const results = await Promise.all([
      sendDecision(staff.second, requested.body.refundId, 'approve', {
        reason: 'Second administrator approved the refund.',
        stepUpGrant: grantA,
      }),
      sendDecision(staff.third, requested.body.refundId, 'reject', {
        reason: 'Third administrator rejected the refund.',
        stepUpGrant: grantB,
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  });
});
