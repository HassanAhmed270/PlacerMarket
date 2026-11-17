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
const { decryptEmailPayload } = require('../../src/lib/emailQueuePayload');
const queue = require('../../src/lib/queue');
const events = require('../../src/lib/events');
const notifications = require('../../src/modules/notifications.service');
const sellerHeldFunds = require('../../src/modules/sellerHeldFunds.service');

const JWT_SECRET = 'delivery-handover-integration-secret';
const THRESHOLD_KEY = 'payout_two_admin_threshold';

let harness;
let scenario;
let previousThreshold;
let originalSellerProfile;
let originalSellerEmail;
let testSellerEmail;
let originalEmailQueueSecret;
let secondAdminOriginalRole;
let businessDate;

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

async function setSellerVerification(verified) {
  return db.query(
    'UPDATE seller_profiles SET id_verified = $2 WHERE user_id = $1',
    [scenario.sellerId, verified]
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
  await adminDeliveredRequest(harness, target, { note: 'Delivered for held-funds integration test' }).expect(200);
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

function releasePayout(target) {
  return request(getApp())
    .post(`/api/admin/orders/${target.orderId}/payout/release`)
    .set('Authorization', authHeader(harness.adminId))
    .send({ note: 'Manual release for held-funds test' });
}

function decideHeldFunds(heldFundsId, adminId, sessionId, body) {
  return request(getApp())
    .post(`/api/admin/held-funds/${heldFundsId}/decision`)
    .set('Authorization', adminAuthHeader(adminId, sessionId))
    .send(body);
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
      transferReference: 'HELD-FUNDS-TEST-REF',
      paidOn: businessDate,
      stepUpGrant,
    });
}

async function createHeldFunds(target = scenario) {
  await setSellerVerification(false);
  const response = await releasePayout(target).expect(200);
  expect(response.body.payout).toMatchObject({
    status: 'held',
    heldFundsId: expect.any(String),
  });
  expect(response.body.payout.id).toBeUndefined();
  return response.body.payout.heldFundsId;
}

async function ageHeldFunds(heldFundsId, days) {
  await db.query(
    `UPDATE seller_held_funds
     SET held_at = now() - ($2::text || ' days')::interval
     WHERE id = $1`,
    [heldFundsId, days]
  );
}

async function getReminderJobs(heldFundsId, milestone) {
  const { rows } = await db.query(
    `SELECT id, data
     FROM pgboss.job
     WHERE name = $1
       AND data->>'eventName' = $2
       AND data->'payload'->>'heldFundsId' = $3
       AND data->'payload'->>'milestone' = $4`,
    [queue.QUEUES.NOTIFICATIONS, events.HELD_FUNDS_REMINDER, heldFundsId, String(milestone)]
  );
  return rows;
}

async function processReminderJobTwice(job) {
  const transactionDb = {
    executeSql: (text, values = []) => transactionDb.client.query(text, values),
  };
  await db.withTransaction(async (client) => {
    transactionDb.client = client;
    await notifications.processNotificationJob(job.data, transactionDb);
  });
  await db.withTransaction(async (client) => {
    transactionDb.client = client;
    await notifications.processNotificationJob(job.data, transactionDb);
  });
}

beforeAll(async () => {
  originalEmailQueueSecret = process.env.EMAIL_QUEUE_ENCRYPTION_SECRET;
  process.env.EMAIL_QUEUE_ENCRYPTION_SECRET = 'test-held-funds-email-queue-key-material';
  harness = await createHarness();
  const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [harness.fixture.userId]);
  originalSellerEmail = rows[0].email;
  testSellerEmail = `held-funds-${crypto.randomUUID()}@example.test`;
  businessDate = await getBusinessDate();
});

beforeEach(async () => {
  scenario = await createScenario(harness);
  await db.query('UPDATE users SET email = $1 WHERE id = $2', [testSellerEmail, harness.fixture.userId]);
  const { rows: profileRows } = await db.query(
    'SELECT id_verified FROM seller_profiles WHERE user_id = $1',
    [scenario.sellerId]
  );
  originalSellerProfile = profileRows[0] || null;
  const { rows: thresholdRows } = await db.query(
    'SELECT value FROM platform_settings WHERE key = $1',
    [THRESHOLD_KEY]
  );
  previousThreshold = thresholdRows[0] ? thresholdRows[0].value : null;
  secondAdminOriginalRole = undefined;
  await deliverScenario(scenario);
  await elapsePayoutWindows(scenario);
});

afterEach(async () => {
  await global.drainIntegrationListeners(5000);
  if (secondAdminOriginalRole !== undefined && scenario) {
    await db.query('UPDATE users SET role = $1 WHERE id = $2', [secondAdminOriginalRole, scenario.buyerId]);
  }
  if (originalSellerProfile) {
    await db.query(
      `INSERT INTO seller_profiles (user_id, id_verified)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET id_verified = EXCLUDED.id_verified`,
      [scenario.sellerId, originalSellerProfile.id_verified]
    );
  } else if (scenario) {
    await db.query('DELETE FROM seller_profiles WHERE user_id = $1', [scenario.sellerId]);
  }
  await db.query('UPDATE users SET email = $1 WHERE id = $2', [originalSellerEmail, harness.fixture.userId]);
  if (previousThreshold === null) {
    await db.query('DELETE FROM platform_settings WHERE key = $1', [THRESHOLD_KEY]);
  } else {
    await setThreshold(previousThreshold);
  }
  if (scenario) await cleanupScenario(harness, scenario);
});

afterAll(async () => {
  await cleanupHarness(harness);
  if (originalEmailQueueSecret === undefined) delete process.env.EMAIL_QUEUE_ENCRYPTION_SECRET;
  else process.env.EMAIL_QUEUE_ENCRYPTION_SECRET = originalEmailQueueSecret;
  restoreHandoverTestEnvironment();
});

describe('FR-65: held funds for unverified sellers', () => {
  test('FR-65: release for an unverified seller creates one held-funds row, no seller_payouts row, ZERO ledger entries and a seller_funds_held audit; a verified seller still gets the normal initiated payout', async () => {
    const heldFundsId = await createHeldFunds();
    const { rows: heldRows } = await db.query(
      'SELECT id, amount::text, currency, state FROM seller_held_funds WHERE order_id = $1',
      [scenario.orderId]
    );
    const { rows: payoutRows } = await db.query('SELECT id FROM seller_payouts WHERE order_id = $1', [scenario.orderId]);
    const { rows: ledgerRows } = await db.query('SELECT id FROM ledger_entries WHERE order_id = $1', [scenario.orderId]);
    const { rows: heldAudits } = await db.query(
      'SELECT id FROM money_audit_events WHERE order_id = $1 AND action = $2',
      [scenario.orderId, 'seller_funds_held']
    );
    expect(heldRows).toHaveLength(1);
    expect(heldRows[0]).toMatchObject({ id: heldFundsId, currency: 'PKR', state: 'held' });
    expect(payoutRows).toHaveLength(0);
    expect(ledgerRows).toHaveLength(0);
    expect(heldAudits).toHaveLength(1);

    await setSellerVerification(true);
    const verifiedScenario = await createScenario(harness);
    try {
      await deliverScenario(verifiedScenario);
      await elapsePayoutWindows(verifiedScenario);
      const verified = await releasePayout(verifiedScenario).expect(200);
      expect(verified.body.payout).toMatchObject({ status: 'initiated', attempt: 1 });
      expect(verified.body.payout.heldFundsId).toBeUndefined();
    } finally {
      await cleanupScenario(harness, verifiedScenario);
    }
  });

  test('FR-65: a seller_profiles row missing counts as unverified', async () => {
    await db.query('DELETE FROM seller_profiles WHERE user_id = $1', [scenario.sellerId]);
    const response = await releasePayout(scenario).expect(200);
    expect(response.body.payout).toMatchObject({
      status: 'held',
      heldFundsId: expect.any(String),
    });
    const { rows: payouts } = await db.query('SELECT id FROM seller_payouts WHERE order_id = $1', [scenario.orderId]);
    expect(payouts).toHaveLength(0);
  });

  test('FR-51, FR-65: processReminders run twice in parallel after moving held_at back 7, then 30, then 90 days produces exactly one in-app notification and one email job per milestone; nothing before 7 days', async () => {
    const heldFundsId = await createHeldFunds();
    const { rows: otherUsers } = await db.query(
      'SELECT full_name FROM users WHERE id = ANY($1::uuid[])',
      [[harness.adminId, harness.unrelatedBuyerId, scenario.buyerId]]
    );
    await ageHeldFunds(heldFundsId, 0);
    await Promise.all([sellerHeldFunds.processReminders(), sellerHeldFunds.processReminders()]);
    expect(await getReminderJobs(heldFundsId, 7)).toHaveLength(0);

    for (const milestone of [7, 30, 90]) {
      await ageHeldFunds(heldFundsId, milestone);
      await Promise.all([sellerHeldFunds.processReminders(), sellerHeldFunds.processReminders()]);

      const jobs = await getReminderJobs(heldFundsId, milestone);
      expect(jobs).toHaveLength(1);
      await processReminderJobTwice(jobs[0]);

      const dedupeKey = `held_funds_reminder:${heldFundsId}:${milestone}`;
      const { rows: notificationsRows } = await db.query(
        'SELECT event_type, payload FROM notifications WHERE user_id = $1 AND dedupe_key = $2',
        [scenario.sellerId, dedupeKey]
      );
      expect(notificationsRows).toHaveLength(1);
      expect(notificationsRows[0].event_type).toBe('held_funds_reminder');
      for (const user of otherUsers) {
        expect(notificationsRows[0].payload.message).not.toContain(user.full_name);
      }
      expect(notificationsRows[0].payload.href).toBe(`/seller/orders/${scenario.orderId}`);

      const emailKey = `held-funds-reminder:${heldFundsId}:${milestone}`;
      const { rows: emailJobs } = await db.query(
        'SELECT id, data FROM pgboss.job WHERE name = $1 AND singleton_key = $2',
        [queue.QUEUES.EMAIL, `held-funds-email:${heldFundsId}:${milestone}`]
      );
      expect(emailJobs).toHaveLength(1);
      expect(emailJobs[0].id).toBe(queue.deterministicJobId(queue.QUEUES.EMAIL, emailKey));
      const email = decryptEmailPayload(
        emailJobs[0].data.encryptedPayload,
        process.env.EMAIL_QUEUE_ENCRYPTION_SECRET
      );
      expect(email.text).toContain('identity verification');
      expect(email.text).toContain(`/seller/orders/${scenario.orderId}`);
      const emailWithoutOrderLink = email.text.replace(`/seller/orders/${scenario.orderId}`, '');
      expect(emailWithoutOrderLink).not.toContain(heldFundsId);
      expect(emailWithoutOrderLink).not.toContain(scenario.orderId);
      for (const user of otherUsers) {
        expect(email.text).not.toContain(user.full_name);
      }
    }
  });

  test('FR-65: at 180 days needs_decision_at is set once and the record appears in GET /held-funds?needsDecision=true', async () => {
    const heldFundsId = await createHeldFunds();
    await ageHeldFunds(heldFundsId, 180);
    await Promise.all([sellerHeldFunds.processReminders(), sellerHeldFunds.processReminders()]);

    const { rows } = await db.query(
      'SELECT needs_decision_at FROM seller_held_funds WHERE id = $1',
      [heldFundsId]
    );
    expect(rows[0].needs_decision_at).toBeInstanceOf(Date);
    const firstValue = rows[0].needs_decision_at;
    await sellerHeldFunds.processReminders();
    const { rows: afterSecondRun } = await db.query(
      'SELECT needs_decision_at FROM seller_held_funds WHERE id = $1',
      [heldFundsId]
    );
    expect(afterSecondRun[0].needs_decision_at).toEqual(firstValue);

    const response = await request(getApp())
      .get('/api/admin/held-funds?needsDecision=true')
      .set('Authorization', authHeader(harness.adminId))
      .expect(200);
    expect(response.body.heldFunds).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: heldFundsId })])
    );
  });

  test('FR-65: decision release for a still-unverified seller is 409, nothing changes, grant not consumed; for a verified seller it creates exactly one initiated payout (which requires the normal approval above the threshold) and marks the record released', async () => {
    const heldFundsId = await createHeldFunds();
    const initiatorSession = await createAdminSession(harness.adminId);
    const decisionGrant = await insertStepUpGrant(harness.adminId, initiatorSession);
    await decideHeldFunds(heldFundsId, harness.adminId, initiatorSession, {
      decision: 'release',
      stepUpGrant: decisionGrant,
    }).expect(409);
    expect(await grantConsumedAt(decisionGrant)).toBeNull();

    const { rows: unchangedRows } = await db.query(
      'SELECT state, released_payout_id FROM seller_held_funds WHERE id = $1',
      [heldFundsId]
    );
    const { rows: noPayouts } = await db.query(
      'SELECT id FROM seller_payouts WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(unchangedRows[0]).toEqual({ state: 'held', released_payout_id: null });
    expect(noPayouts).toHaveLength(0);

    await setSellerVerification(true);
    await setThreshold('0.01');
    const released = await decideHeldFunds(heldFundsId, harness.adminId, initiatorSession, {
      decision: 'release',
      stepUpGrant: decisionGrant,
    }).expect(200);
    expect(released.body.heldFunds.state).toBe('released');
    expect(released.body.payout).toMatchObject({ status: 'initiated', attempt: 1 });
    const secondAdminId = await promoteSecondAdmin();
    const paymentGrant = await insertStepUpGrant(harness.adminId, initiatorSession);
    await markPaid(released.body.payout.id, harness.adminId, initiatorSession, paymentGrant).expect(409);
    expect(await grantConsumedAt(paymentGrant)).toBeNull();

    const approvalSession = await createAdminSession(secondAdminId);
    const approvalGrant = await insertStepUpGrant(secondAdminId, approvalSession, 'payout.approve');
    await approvePayout(released.body.payout.id, secondAdminId, approvalSession, approvalGrant).expect(200);

    const { rows: releaseAudits } = await db.query(
      'SELECT id FROM money_audit_events WHERE order_id = $1 AND action = $2',
      [scenario.orderId, 'seller_funds_released']
    );
    expect(releaseAudits).toHaveLength(1);
  });

  test('FR-65: ten parallel decisions give exactly one winner and one payout', async () => {
    const heldFundsId = await createHeldFunds();
    await setSellerVerification(true);
    const sessionId = await createAdminSession(harness.adminId);
    const grants = await Promise.all(
      Array.from({ length: 10 }, () => insertStepUpGrant(harness.adminId, sessionId))
    );
    const responses = await Promise.all(
      grants.map((stepUpGrant) => decideHeldFunds(heldFundsId, harness.adminId, sessionId, {
        decision: 'release',
        stepUpGrant,
      }))
    );

    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(9);
    const { rows: payouts } = await db.query('SELECT id FROM seller_payouts WHERE order_id = $1', [scenario.orderId]);
    expect(payouts).toHaveLength(1);
  });

  test('FR-65: keep_held requires a note, writes one audit and does not change state', async () => {
    const heldFundsId = await createHeldFunds();
    const sessionId = await createAdminSession(harness.adminId);
    const grant = await insertStepUpGrant(harness.adminId, sessionId);

    await decideHeldFunds(heldFundsId, harness.adminId, sessionId, {
      decision: 'keep_held',
      stepUpGrant: grant,
    }).expect(400);
    expect(await grantConsumedAt(grant)).toBeNull();

    const kept = await decideHeldFunds(heldFundsId, harness.adminId, sessionId, {
      decision: 'keep_held',
      note: 'Continue holding',
      stepUpGrant: grant,
    }).expect(200);
    expect(kept.body.heldFunds).toMatchObject({
      id: heldFundsId,
      state: 'held',
      last_decision_note: 'Continue holding',
      last_decision_by: harness.adminId,
    });
    const { rows: audits } = await db.query(
      'SELECT id FROM money_audit_events WHERE order_id = $1 AND action = $2',
      [scenario.orderId, 'seller_funds_keep_held']
    );
    expect(audits).toHaveLength(1);
  });

  test('FR-65, SEC-35: Seller, Buyer, Moderator and anonymous callers get 403/401 on both routes; limit=1.5 gives 400', async () => {
    const heldFundsId = await createHeldFunds();
    const callers = [
      { token: authHeader(scenario.sellerId), status: 403 },
      { token: authHeader(harness.unrelatedBuyerId), status: 403 },
      { token: authHeader(harness.moderatorId), status: 403 },
      { token: null, status: 401 },
    ];

    for (const caller of callers) {
      const get = request(getApp()).get('/api/admin/held-funds');
      const post = request(getApp())
        .post(`/api/admin/held-funds/${heldFundsId}/decision`)
        .send({});
      if (caller.token) {
        get.set('Authorization', caller.token);
        post.set('Authorization', caller.token);
      }
      await get.expect(caller.status);
      await post.expect(caller.status);
    }

    await request(getApp())
      .get('/api/admin/held-funds?limit=1.5')
      .set('Authorization', authHeader(harness.adminId))
      .expect(400);
  });

  test('FR-65: no ledger entry exists for the order until a payout created from held funds is marked paid', async () => {
    const heldFundsId = await createHeldFunds();
    await setSellerVerification(true);
    await setThreshold('999999');
    const sessionId = await createAdminSession(harness.adminId);
    const decisionGrant = await insertStepUpGrant(harness.adminId, sessionId);
    const released = await decideHeldFunds(heldFundsId, harness.adminId, sessionId, {
      decision: 'release',
      stepUpGrant: decisionGrant,
    }).expect(200);

    let { rows: ledgerRows } = await db.query(
      'SELECT id FROM ledger_entries WHERE order_id = $1',
      [scenario.orderId]
    );
    expect(ledgerRows).toHaveLength(0);

    const paidGrant = await insertStepUpGrant(harness.adminId, sessionId);
    await markPaid(released.body.payout.id, harness.adminId, sessionId, paidGrant).expect(200);
    ({ rows: ledgerRows } = await db.query(
      "SELECT id, entry_type FROM ledger_entries WHERE order_id = $1 AND entry_type = 'seller_payout_manual'",
      [scenario.orderId]
    ));
    expect(ledgerRows).toHaveLength(1);
  });
});
