const crypto = require('node:crypto');
const {
  adminDeliveredRequest,
  adminHandoverRequest,
  authHeader,
  buyerCancelRequest,
  cleanupHarness,
  cleanupScenario,
  createHarness,
  createScenario,
  createUnfundedScenario,
  db,
  escrowPayments,
  getApp,
  pickupTime,
  request,
  restoreHandoverTestEnvironment,
  setDeadlinePast,
  validHandoverBody,
} = require('./delivery-handover.helpers');
const eventBus = require('../../src/lib/eventBus');
const events = require('../../src/lib/events');
const notifications = require('../../src/modules/notifications.service');
const moneyAudit = require('../../src/modules/moneyAudit.service');
const payout = require('../../src/modules/payout.service');
const disputes = require('../../src/modules/disputes.service');
const listings = require('../../src/modules/listings.service');
const queue = require('../../src/lib/queue');
const { buildSignedFakeEvent } = require('../../src/lib/adapters/fakePaymentGateway');

let harness;
let scenario;

beforeAll(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await global.drainIntegrationListeners(5000);
  if (scenario) await cleanupScenario(harness, scenario);
  scenario = null;
});

afterAll(async () => {
  await cleanupHarness(harness);
  restoreHandoverTestEnvironment();
});

async function fundThroughWebhook(orderScenario) {
  const { rows } = await db.query(
    `SELECT provider_payment_id, amount::text AS amount, currency
     FROM payments WHERE id = $1`,
    [orderScenario.paymentId]
  );
  const payment = rows[0];
  const signed = buildSignedFakeEvent({
    type: 'payment.succeeded',
    providerPaymentRef: payment.provider_payment_id,
    amount: payment.amount,
    currency: payment.currency,
    eventId: `stage14a-${crypto.randomUUID()}`,
  });
  const response = await request(getApp())
    .post('/api/webhooks/payments/fake')
    .set('Content-Type', 'application/json')
    .set(signed.headers)
    .send(signed.rawBody.toString('utf8'));
  expect(response.status).toBe(200);

  const eventId = JSON.parse(signed.rawBody.toString('utf8')).eventId;
  const { rows: inboxRows } = await db.query(
    `SELECT id FROM webhook_inbox
     WHERE provider = 'fake' AND provider_event_id = $1`,
    [eventId]
  );
  expect(inboxRows).toHaveLength(1);
  await expect(escrowPayments.processPaymentWebhookJob({
    webhookInboxId: inboxRows[0].id,
  })).resolves.toEqual({ outcome: 'processed' });
}

async function recordHandover(orderScenario) {
  const body = await validHandoverBody(orderScenario);
  await adminHandoverRequest(harness, orderScenario, body).expect(200);
}

async function recordDelivery(orderScenario) {
  await recordHandover(orderScenario);
  await adminDeliveredRequest(harness, orderScenario, { note: 'Delivery confirmed.' }).expect(200);
}

async function processQueuedNotification(eventName, eventPayload, recipientId, eventType, expected) {
  await global.drainIntegrationListeners(5000);
  let { rows: jobs } = await db.query(
    `SELECT data FROM pgboss.job
     WHERE name = $1
       AND data->>'eventName' = $2
       AND data->'payload'->>'orderId' = $3`,
    [queue.QUEUES.NOTIFICATIONS, eventName, eventPayload.orderId]
  );
  expect(jobs).toHaveLength(1);

  eventBus.emit(eventName, eventPayload);
  await global.drainIntegrationListeners(5000);
  ({ rows: jobs } = await db.query(
    `SELECT data FROM pgboss.job
     WHERE name = $1
       AND data->>'eventName' = $2
       AND data->'payload'->>'orderId' = $3`,
    [queue.QUEUES.NOTIFICATIONS, eventName, eventPayload.orderId]
  ));
  expect(jobs).toHaveLength(1);

  const job = jobs[0].data;
  const transactionDb = {
    executeSql: (text, values = []) => transactionDb.client.query(text, values),
  };
  await db.withTransaction(async (client) => {
    transactionDb.client = client;
    await notifications.processNotificationJob(job, transactionDb);
  });
  await db.withTransaction(async (client) => {
    transactionDb.client = client;
    await notifications.processNotificationJob(job, transactionDb);
  });

  const dedupeId = eventPayload.refundId || eventPayload.disputeId || eventPayload.orderId;
  const dedupeKey = `${eventType}:${dedupeId}`;
  const { rows } = await db.query(
    `SELECT user_id, event_type, payload, dedupe_key
     FROM notifications
     WHERE user_id = $1 AND dedupe_key = $2`,
    [recipientId, dedupeKey]
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    user_id: recipientId,
    event_type: eventType,
    dedupe_key: dedupeKey,
    payload: expected,
  });
  expect(Object.keys(rows[0].payload).sort()).toEqual(['href', 'message', 'orderId']);
  const serializedPayload = JSON.stringify(rows[0].payload);
  expect(serializedPayload).not.toContain('Handover Test Recipient');
  expect(serializedPayload).not.toContain('+15551234567');
  expect(serializedPayload).not.toContain('12 Handover Test Street');
  return rows[0];
}

function orderPath(role, orderId) {
  return `${role === 'seller' ? '/seller/orders' : '/orders'}/${orderId}`;
}

async function createRefundIntent(orderScenario, trigger) {
  const { rows: paymentRows } = await db.query(
    'SELECT amount::text AS amount, currency FROM payments WHERE id = $1',
    [orderScenario.paymentId]
  );
  const manual = trigger === 'manual_admin';
  const { rows } = await db.query(
    `INSERT INTO refunds
       (payment_id, order_id, trigger, amount, currency, status, idempotency_key,
      requested_by, approved_by, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      orderScenario.paymentId,
      orderScenario.orderId,
      trigger,
      paymentRows[0].amount,
      paymentRows[0].currency,
      manual ? 'approved' : 'requested',
      `notification-refund:${crypto.randomUUID()}`,
      manual ? orderScenario.sellerId : null,
      manual ? harness.adminId : null,
      trigger === 'system_expiry' ? 'Late payment after reservation ended' : null,
    ]
  );
  return rows[0].id;
}

async function completeRefund(refundId) {
  return escrowPayments.processRefundJob({
    refundId,
    gateway: {
      createRefund: async ({ amount, providerPaymentRef }) => ({
        providerRefundRef: `notification-provider-ref-${crypto.randomUUID()}`,
        providerPaymentRef,
        amount,
        status: 'succeeded',
      }),
    },
  });
}

test.each([
  ['manual_admin', 'buyer', 'Your refund was processed: PKR 1550.50.'],
  ['manual_admin', 'seller', 'A refund was issued for your sale: PKR 1550.50.'],
  ['system_expiry', 'buyer', 'Your late payment was refunded: PKR 1550.50.'],
  ['system_expiry', 'seller', 'A late payment for your sale was refunded: PKR 1550.50.'],
  ['system_handover_timeout', 'buyer', 'Your order missed the handover deadline and was refunded: PKR 1550.50.'],
  ['system_handover_timeout', 'seller', 'Your sale missed the handover deadline and was refunded: PKR 1550.50.'],
  ['system_cancel', 'buyer', 'Your order was cancelled and refunded: PKR 1550.50.'],
  ['system_cancel', 'seller', 'Your sale was cancelled and refunded: PKR 1550.50.'],
])('FR-51: %s refund success notifies the %s once with the stored amount', async (trigger, role, message) => {
  scenario = await createScenario(harness);
  const refundId = await createRefundIntent(scenario, trigger);
  await expect(completeRefund(refundId)).resolves.toMatchObject({ outcome: 'succeeded' });
  const recipientId = role === 'seller' ? scenario.sellerId : scenario.buyerId;
  await processQueuedNotification(
    events.REFUND_STATUS_CHANGED,
    { refundId, orderId: scenario.orderId, status: 'succeeded' },
    recipientId,
    'refund_succeeded',
    { orderId: scenario.orderId, message, href: orderPath(role, scenario.orderId) }
  );
});

test('FR-51: a late payment auto-refund notifies the buyer and seller with its stored amount', async () => {
  scenario = await createUnfundedScenario(harness);
  await db.query(
    `UPDATE reservations SET expires_at = now() - INTERVAL '1 minute' WHERE id = $1`,
    [scenario.reservationId]
  );
  await fundThroughWebhook(scenario);
  const { rows } = await db.query(
    `SELECT id, trigger, amount::text AS amount
     FROM refunds WHERE order_id = $1`,
    [scenario.orderId]
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    trigger: 'system_expiry',
    amount: '1550.50',
  });
  await expect(completeRefund(rows[0].id)).resolves.toMatchObject({ outcome: 'succeeded' });

  await processQueuedNotification(
    events.REFUND_STATUS_CHANGED,
    { refundId: rows[0].id, orderId: scenario.orderId, status: 'succeeded' },
    scenario.buyerId,
    'refund_succeeded',
    {
      orderId: scenario.orderId,
      message: 'Your late payment was refunded: PKR 1550.50.',
      href: orderPath('buyer', scenario.orderId),
    }
  );
  await processQueuedNotification(
    events.REFUND_STATUS_CHANGED,
    { refundId: rows[0].id, orderId: scenario.orderId, status: 'succeeded' },
    scenario.sellerId,
    'refund_succeeded',
    {
      orderId: scenario.orderId,
      message: 'A late payment for your sale was refunded: PKR 1550.50.',
      href: orderPath('seller', scenario.orderId),
    }
  );
});

test('FR-51: a refund notification is not queued when its status transaction rolls back', async () => {
  scenario = await createScenario(harness);
  const refundId = await createRefundIntent(scenario, 'system_cancel');
  const auditSpy = jest.spyOn(moneyAudit, 'recordMoneyAuditEvent')
    .mockRejectedValueOnce(new Error('integration rollback'));
  try {
    await expect(completeRefund(refundId)).rejects.toThrow('integration rollback');
  } finally {
    auditSpy.mockRestore();
  }
  await global.drainIntegrationListeners(5000);
  const { rows: refunds } = await db.query('SELECT status FROM refunds WHERE id = $1', [refundId]);
  expect(refunds[0].status).toBe('pending');
  const { rows: jobs } = await db.query(
    `SELECT id FROM pgboss.job
     WHERE name = $1 AND data->>'eventName' = $2
       AND data->'payload'->>'refundId' = $3`,
    [queue.QUEUES.NOTIFICATIONS, events.REFUND_STATUS_CHANGED, refundId]
  );
  expect(jobs).toHaveLength(0);
});

test.each([
  ['seller', 'new_sale', 'You have a new sale; handover is recorded by our team after courier pickup.'],
  ['buyer', 'payment_confirmed', 'Payment confirmed for your order.'],
])('FR-51: %s receives a payment confirmation notification', async (role, eventType, message) => {
  scenario = await createUnfundedScenario(harness);
  await fundThroughWebhook(scenario);
  const recipientId = role === 'seller' ? scenario.sellerId : scenario.buyerId;
  await processQueuedNotification(
    events.ORDER_FUNDED,
    { orderId: scenario.orderId },
    recipientId,
    eventType,
    { orderId: scenario.orderId, message, href: orderPath(role, scenario.orderId) }
  );
});

test.each([
  ['seller', 'An order was cancelled.'],
  ['buyer', 'Your order was cancelled; a refund was requested.'],
])('FR-51: %s receives a buyer-cancellation notification', async (role, message) => {
  scenario = await createScenario(harness);
  await buyerCancelRequest(scenario).expect(200);
  const recipientId = role === 'seller' ? scenario.sellerId : scenario.buyerId;
  await processQueuedNotification(
    events.ORDER_CANCELLED,
    { orderId: scenario.orderId },
    recipientId,
    'order_cancelled',
    { orderId: scenario.orderId, message, href: orderPath(role, scenario.orderId) }
  );
});

test.each([
  ['seller', 'An order was cancelled.'],
  ['buyer', 'Your order was cancelled; a refund was requested.'],
])('FR-51: %s receives a listing-takedown cancellation notification', async (role, message) => {
  scenario = await createScenario(harness);
  await listings.rejectOrUnpublishListing(scenario.listingId, {
    reviewerId: harness.adminId,
    reason: 'Administrative listing takedown for integration test.',
  });
  const recipientId = role === 'seller' ? scenario.sellerId : scenario.buyerId;
  await processQueuedNotification(
    events.ORDER_CANCELLED,
    { orderId: scenario.orderId },
    recipientId,
    'order_cancelled',
    { orderId: scenario.orderId, message, href: orderPath(role, scenario.orderId) }
  );
});

test.each([
  ['seller', 'A sale was cancelled after the handover deadline.'],
  ['buyer', 'Your order was automatically cancelled and a refund was requested.'],
])('FR-51: %s receives a handover-deadline cancellation notification', async (role, message) => {
  scenario = await createScenario(harness);
  await setDeadlinePast(scenario);
  await expect(escrowPayments.sweepUnhandedOverOrders()).resolves.toMatchObject({ processed: 1 });
  const recipientId = role === 'seller' ? scenario.sellerId : scenario.buyerId;
  await processQueuedNotification(
    events.ORDER_AUTO_CANCELLED,
    { orderId: scenario.orderId },
    recipientId,
    'order_auto_cancelled',
    { orderId: scenario.orderId, message, href: orderPath(role, scenario.orderId) }
  );
});

test.each([
  ['seller', 'Your sale has been handed to delivery.'],
  ['buyer', 'Your order has been handed to delivery.'],
])('FR-51: %s receives a handover notification', async (role, message) => {
  scenario = await createScenario(harness);
  await recordHandover(scenario);
  const recipientId = role === 'seller' ? scenario.sellerId : scenario.buyerId;
  await processQueuedNotification(
    events.ORDER_HANDED_OVER,
    { orderId: scenario.orderId },
    recipientId,
    'order_handed_over',
    { orderId: scenario.orderId, message, href: orderPath(role, scenario.orderId) }
  );
});

test.each([
  ['seller', 'Your sale was delivered.'],
  ['buyer', 'Your order was delivered.'],
])('FR-51: %s receives a delivery notification', async (role, message) => {
  scenario = await createScenario(harness);
  await recordDelivery(scenario);
  const recipientId = role === 'seller' ? scenario.sellerId : scenario.buyerId;
  await processQueuedNotification(
    events.ORDER_DELIVERED,
    { orderId: scenario.orderId },
    recipientId,
    'order_delivered',
    { orderId: scenario.orderId, message, href: orderPath(role, scenario.orderId) }
  );
});

test('FR-51: the seller receives a dispute-filed notification', async () => {
  scenario = await createScenario(harness);
  await recordDelivery(scenario);
  const dispute = await disputes.fileDispute(scenario.orderId, scenario.buyerId, {
    reasonText: 'The item arrived damaged.',
    evidenceUrls: ['https://example.test/evidence.jpg'],
  });
  await processQueuedNotification(
    events.DISPUTE_FILED,
    { disputeId: dispute.id, orderId: scenario.orderId },
    scenario.sellerId,
    'dispute_filed',
    {
      orderId: scenario.orderId,
      message: 'A dispute was filed for your sale.',
      href: orderPath('seller', scenario.orderId),
    }
  );
  const { rows } = await db.query(
    'SELECT id FROM notifications WHERE user_id = $1 AND dedupe_key = $2',
    [scenario.buyerId, `dispute_filed:${dispute.id}`]
  );
  expect(rows).toHaveLength(0);
});

test.each([
  ['seller', '0', 'A dispute on your sale was resolved.'],
  ['buyer', '0', 'A dispute on your order was resolved.'],
  ['seller', '1250.50', 'A dispute on your sale was resolved.'],
  ['buyer', '1250.50', 'A dispute on your order was resolved.'],
])('FR-51: %s receives a notification when a dispute is resolved', async (role, amount, message) => {
  scenario = await createScenario(harness);
  await recordDelivery(scenario);
  const dispute = await disputes.fileDispute(scenario.orderId, scenario.buyerId, {
    reasonText: 'The item arrived damaged.',
    evidenceUrls: ['https://example.test/evidence.jpg'],
  });
  await global.drainIntegrationListeners(5000);
  await disputes.resolveDispute(dispute.id, {
    resolutionAmountToBuyer: amount,
    resolvedBy: harness.adminId,
    resolutionNote: 'Resolution recorded for integration test.',
  });
  const recipientId = role === 'seller' ? scenario.sellerId : scenario.buyerId;
  await processQueuedNotification(
    events.DISPUTE_RESOLUTION_COMMITTED,
    { disputeId: dispute.id, orderId: scenario.orderId },
    recipientId,
    'dispute_resolved',
    { orderId: scenario.orderId, message, href: orderPath(role, scenario.orderId) }
  );
});

test('FR-51: the seller receives a payout-released notification', async () => {
  scenario = await createScenario(harness);
  await recordDelivery(scenario);
  await db.query('UPDATE orders SET delivered_at = now() - INTERVAL \'30 days\' WHERE id = $1', [
    scenario.orderId,
  ]);
  await db.query('UPDATE payout_holds SET hold_started_at = now() - INTERVAL \'30 days\' WHERE order_id = $1', [
    scenario.orderId,
  ]);
  await payout.releaseReservationPayout(scenario.orderId, harness.adminId, {
    payoutReference: 'NOTIF-TEST-1',
    note: 'Integration test payout release.',
  });
  await processQueuedNotification(
    events.PAYOUT_RELEASED,
    { orderId: scenario.orderId },
    scenario.sellerId,
    'payout_released',
    {
      orderId: scenario.orderId,
      message: 'Your payout was released.',
      href: orderPath('seller', scenario.orderId),
    }
  );
  const { rows } = await db.query(
    'SELECT id FROM notifications WHERE user_id = $1 AND dedupe_key = $2',
    [scenario.buyerId, `payout_released:${scenario.orderId}`]
  );
  expect(rows).toHaveLength(0);
});

test('FR-51: a notification listener failure does not fail the cancellation action', async () => {
  scenario = await createScenario(harness);
  const originalEnqueue = queue.enqueue;
  const enqueueSpy = jest.spyOn(queue, 'enqueue').mockImplementation((queueName, ...args) => {
    if (queueName === queue.QUEUES.NOTIFICATIONS) return Promise.reject(new Error('notification queue unavailable'));
    return originalEnqueue.call(queue, queueName, ...args);
  });
  const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await buyerCancelRequest(scenario).expect(200);
    await global.drainIntegrationListeners(5000);
    const { rows } = await db.query('SELECT status FROM orders WHERE id = $1', [scenario.orderId]);
    expect(rows[0].status).toBe('cancelled');
    expect(errorLog).toHaveBeenCalledWith(
      'Notification job enqueue failed',
      { eventName: events.ORDER_CANCELLED, code: 'unknown' }
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('notification queue unavailable');
  } finally {
    enqueueSpy.mockRestore();
    errorLog.mockRestore();
  }
});

test('FR-51: GET notifications exposes rows only to their recipient', async () => {
  scenario = await createScenario(harness);
  const { rows: notificationRows } = await db.query(
    `INSERT INTO notifications (user_id, event_type, payload)
     VALUES ($1, 'order_delivered', $2::jsonb) RETURNING id`,
    [scenario.buyerId, JSON.stringify({ orderId: scenario.orderId, message: 'Your order was delivered.' })]
  );
  const buyerResponse = await request(getApp())
    .get('/api/notifications')
    .set('Authorization', authHeader(scenario.buyerId))
    .expect(200);
  const unrelatedResponse = await request(getApp())
    .get('/api/notifications')
    .set('Authorization', authHeader(harness.unrelatedBuyerId))
    .expect(200);
  expect(buyerResponse.body.map((item) => item.id)).toContain(notificationRows[0].id);
  expect(unrelatedResponse.body.map((item) => item.id)).not.toContain(notificationRows[0].id);
});
