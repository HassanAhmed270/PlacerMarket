/**
 * Owns: FR-60a hosted checkout intents, FR-61 funding, FR-69 refunds, and FR-77b webhooks.
 * Tables owned: payments, webhook_inbox, refunds, ledger_entries
 */

const db = require('../db.service');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const queue = require('../lib/queue');
const eventBus = require('../lib/eventBus');
const events = require('../lib/events');
const paymentGateway = require('../lib/adapters/paymentGateway');
const orders = require('./orders.service');
const reservations = require('./reservations.service');
const listings = require('./listings.service');
const users = require('./users.service');
const moneyAudit = require('./moneyAudit.service');
const {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} = require('../lib/errors');
const {
  PaymentGatewayConfigurationError,
  PaymentGatewayUnavailableError,
  buildPaymentReturnUrl,
} = paymentGateway;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANUAL_REFUND_EXPIRY_WINDOW = '48 hours';
const MANUAL_REFUND_EXPIRY_PREDICATE =
  `requested_at <= now() - INTERVAL '${MANUAL_REFUND_EXPIRY_WINDOW}'`;
const MANUAL_REFUND_EXPIRY_REASON =
  `Expired automatically after ${MANUAL_REFUND_EXPIRY_WINDOW} without a decision.`;
const REFUND_ERROR_CODES = new Set([
  'gateway_unavailable',
  'gateway_rejected',
  'gateway_invalid_response',
  'configuration',
  'unknown',
]);

function getRefundMaxAutoAttempts(env = process.env) {
  const raw = env.REFUND_MAX_AUTO_ATTEMPTS;
  const value = raw === undefined || raw === '' ? 6 : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError('REFUND_MAX_AUTO_ATTEMPTS must be a positive integer.');
  }
  return value;
}

function classifyRefundFailureCode(error) {
  if (!error || typeof error !== 'object') return 'unknown';
  if (typeof error.code === 'string' && REFUND_ERROR_CODES.has(error.code)) return error.code;
  if (error.name === 'PaymentGatewayConfigurationError') return 'configuration';
  if (error.name === 'PaymentGatewayUnavailableError') return 'gateway_unavailable';
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  if (/reject|decline|denied|declined|not allowed|not accepted/i.test(message)) return 'gateway_rejected';
  if (/invalid.*response|malformed|unexpected.*(body|payload)|missing.*provider/i.test(message)) {
    return 'gateway_invalid_response';
  }
  return 'unknown';
}

function emitRefundStatusChange(refund) {
  eventBus.emit(events.REFUND_STATUS_CHANGED, {
    refundId: refund.id,
    orderId: refund.order_id,
    status: refund.status,
  });
}

/** FR-68: return safe payment and refund summaries for an Admin reservation-order read. */
async function getAdminOrderPaymentAndRefunds(orderId) {
  const { rows } = await db.read(
    `SELECT
       (SELECT jsonb_build_object('status', p.status, 'amount', p.amount::text)
        FROM payments p
        WHERE p.order_id = $1
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 1) AS payment,
       COALESCE(
         (SELECT jsonb_agg(
                   jsonb_build_object(
                     'id', r.id,
                     'trigger', r.trigger,
                     'status', r.status,
                     'amount', r.amount::text
                   )
                   ORDER BY r.created_at, r.id)
          FROM refunds r
          WHERE r.order_id = $1),
         '[]'::jsonb
       ) AS refunds`,
    [orderId]
  );
  return {
    payment: rows[0].payment,
    refunds: rows[0].refunds,
  };
}
const WEBHOOK_AMOUNT = /^\d{1,10}(?:\.\d{1,2})?$/;
const SUPPORTED_PAYMENT_EVENTS = new Set(['payment.succeeded', 'payment.failed']);

/** FR-69: enqueue one refund job in the caller's transaction for system and manual refund creators. */
async function enqueueRefundJob(transaction, refundId, jobKey = null) {
  if (typeof refundId !== 'string' || !UUID.test(refundId)) {
    throw new ValidationError('refundId must be a UUID.');
  }
  if (!transaction) throw new TypeError('Refund jobs must be enqueued in the refund transaction.');
  queue.asQueueDatabase(transaction);
  const key = typeof jobKey === 'string' && jobKey.trim() ? jobKey : `refund:${refundId}`;
  return queue.enqueue(queue.QUEUES.REFUNDS, { refundId }, {
    idempotencyKey: key,
    orderingKey: key,
    transaction,
  });
}

function getSystemRefundCause(trigger, reason) {
  if (trigger === 'system_expiry') return 'late';
  if (trigger === 'system_handover_timeout') return 'handover_timeout';
  if (trigger === 'system_cancel') return reason === 'Listing taken down' ? 'takedown' : 'cancel';
  throw new ValidationError('Unsupported system refund trigger.');
}

/** FR-69: create one auditable, idempotent system refund intent in the caller's transaction. */
async function createSystemRefundIntent(client, { payment, order, trigger, reason }) {
  const cause = getSystemRefundCause(trigger, reason);
  if (!payment?.id || !payment.amount || !payment.currency || !order?.id) {
    throw new ValidationError('A payment and its owning order are required for a system refund.');
  }
  const idempotencyKey = `refund:${payment.id}:${cause}`;
  const { rows: inserted } = await client.query(
    `INSERT INTO refunds
       (payment_id, order_id, trigger, amount, currency, status, idempotency_key, reason)
     VALUES ($1, $2, $3, $4::numeric, $5, 'requested', $6, $7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, status`,
    [payment.id, order.id, trigger, payment.amount, payment.currency, idempotencyKey, reason]
  );
  const refund = inserted[0] || (await client.query(
    `SELECT id, status
     FROM refunds
     WHERE idempotency_key = $1`,
    [idempotencyKey]
  )).rows[0];
  if (!refund) throw new ConflictError('The system refund intent could not be loaded.');

  if (inserted[0]) {
    await enqueueRefundJob(client, refund.id);
    const isLateCapture = trigger === 'system_expiry';
    const auditReason = isLateCapture
      ? reason === 'Late payment after reservation ended'
        ? 'late_payment'
        : reason === 'Duplicate capture: reservation already paid'
          ? 'duplicate_capture'
          : 'ineligible_capture'
      : reason;
    await moneyAudit.recordMoneyAuditEvent(client, {
      action: isLateCapture ? 'late_payment_refund_requested' : 'system_refund_requested',
      orderId: order.id,
      paymentId: payment.id,
      refundId: refund.id,
      reason: auditReason,
      metadata: isLateCapture ? { trigger } : { trigger, cause },
    });
  }

  return { refundId: refund.id, status: refund.status, created: Boolean(inserted[0]) };
}

async function resolveWebhookPaymentId(client, { provider, providerPaymentRef }) {
  const { rows } = await client.query(
    `SELECT id
     FROM payments
     WHERE provider = $1 AND provider_payment_id = $2
     LIMIT 1`,
    [provider, providerPaymentRef]
  );
  return rows[0]?.id || null;
}

function parseWebhookEvent(rawBody) {
  if (!Buffer.isBuffer(rawBody)) return null;
  try {
    const event = JSON.parse(rawBody.toString('utf8'));
    return event && typeof event === 'object' && !Array.isArray(event) ? event : null;
  } catch {
    return null;
  }
}

async function findPaymentForWebhook(inbox, event) {
  if (inbox.payment_id) {
    const { rows } = await db.read(
      'SELECT id, order_id FROM payments WHERE id = $1',
      [inbox.payment_id]
    );
    return rows[0] || null;
  }
  if (typeof event?.providerPaymentRef !== 'string' || !event.providerPaymentRef) return null;
  const { rows } = await db.read(
    `SELECT id, order_id
     FROM payments
     WHERE provider = $1 AND provider_payment_id = $2
     LIMIT 1`,
    [inbox.provider, event.providerPaymentRef]
  );
  return rows[0] || null;
}

async function recordWebhookFailure(client, inbox, payment, code) {
  await moneyAudit.recordMoneyAuditEvent(client, {
    action: 'payment_webhook_manual_review',
    orderId: payment?.order_id || null,
    paymentId: payment?.id || null,
    reason: code,
    metadata: { errorCode: code, eventType: inbox.event_type },
  });
  await client.query(
    `UPDATE webhook_inbox
     SET status = 'failed', error_code = $2, processed_at = now()
     WHERE id = $1`,
    [inbox.id, code]
  );
  return { outcome: 'failed', errorCode: code };
}

async function recordWebhookProcessed(client, inbox) {
  await client.query(
    `UPDATE webhook_inbox
     SET status = 'processed', error_code = NULL,
         processed_at = COALESCE(processed_at, now())
     WHERE id = $1`,
    [inbox.id]
  );
  return { outcome: 'processed' };
}

async function recordWebhookProcessingError(webhookInboxId) {
  await db.withTransaction(async (client) => {
    await client.query(
      `UPDATE webhook_inbox
       SET attempts = attempts + 1, error_code = 'processing_error'
       WHERE id = $1 AND status IN ('received', 'processing')`,
      [webhookInboxId]
    );
  });
}

const receivePaymentWebhook = queue.createPaymentWebhookInboxReceiver({
  withTransaction: db.withTransaction,
  enqueueJob: queue.enqueue,
  resolvePaymentId: resolveWebhookPaymentId,
});

async function lockRefundPaymentOrder(client, orderId, paymentId, refundId) {
  const context = await orders.getMoneyLockContext(client, orderId);
  if (!context) return null;
  const listing = await listings.lockListingForMoneyAction(client, context.listing_id);
  if (!listing) return null;
  const buyer = await users.lockBuyerForMoneyAction(client, context.buyer_id);
  if (!buyer) return null;

  const order = await orders.lockOrderForRefund(client, orderId);
  if (!order || order.listing_id !== context.listing_id || order.buyer_id !== context.buyer_id ||
      order.reservation_id !== context.reservation_id || !order.reservation_id) return null;
  const reservation = await reservations.lockReservationForPayout(client, order.reservation_id);
  if (!reservation || reservation.listing_id !== order.listing_id) return null;

  const { rows: paymentRows } = await client.query(
    `SELECT id, order_id, provider_payment_id, amount, status
     FROM payments
     WHERE id = $1
     FOR UPDATE`,
    [paymentId]
  );
  const payment = paymentRows[0];
  if (!payment || payment.order_id !== order.id) return null;

  const { rows: refundRows } = await client.query(
    `SELECT id, order_id, payment_id, amount, currency, status, idempotency_key,
            trigger, reason, approved_by, attempt_count, needs_attention_at
     FROM refunds
     WHERE id = $1
     FOR UPDATE`,
    [refundId]
  );
  const refund = refundRows[0];
  if (!refund || refund.order_id !== order.id || refund.payment_id !== payment.id) return null;
  return { order, payment, refund };
}

const MANUAL_REFUND_RESERVED_STATUSES = ['requested', 'approved', 'pending', 'failed', 'succeeded'];

function normalizeManualRefundNote(note) {
  if (typeof note !== 'string') throw new ValidationError('A reason between 20 and 1000 characters is required.');
  const trimmed = note.trim();
  if (trimmed.length < 20 || trimmed.length > 1000) {
    throw new ValidationError('A reason between 20 and 1000 characters is required.');
  }
  return trimmed;
}

async function lockManualRefundContext(client, orderId, expectedPaymentId) {
  const context = await orders.getMoneyLockContext(client, orderId);
  if (!context) throw new NotFoundError('order');
  if (!context.reservation_id) throw new ConflictError('Only captured reservation orders can be refunded manually.');
  if (!(await listings.lockListingForMoneyAction(client, context.listing_id))) {
    throw new ConflictError('The order listing is no longer available.');
  }
  if (!(await users.lockBuyerForMoneyAction(client, context.buyer_id))) {
    throw new ConflictError('The order buyer is no longer available.');
  }
  const order = await orders.lockOrderForRefund(client, orderId);
  if (!order || order.listing_id !== context.listing_id || order.buyer_id !== context.buyer_id ||
      order.reservation_id !== context.reservation_id) {
    throw new ConflictError('The order changed before the refund action.');
  }
  const reservation = await reservations.lockReservationForPayout(client, order.reservation_id);
  if (!reservation || reservation.listing_id !== order.listing_id || reservation.status !== 'paid') {
    throw new ConflictError('Only captured reservation orders can be refunded manually.');
  }

  const payments = await lockPaymentsForOrder(client, orderId);
  const capturedPayments = payments.filter((payment) => (
    ['succeeded', 'partially_refunded', 'refunded'].includes(payment.status)
  ));
  const payment = expectedPaymentId
    ? capturedPayments.find((candidate) => candidate.id === expectedPaymentId)
    : capturedPayments.length === 1 ? capturedPayments[0] : null;
  if (!payment || capturedPayments.length !== 1) {
    throw new ConflictError('The order must have exactly one captured payment.');
  }
  return { order, payment };
}

/** FR-45, FR-69: lock and read whether an order's captured payment is fully refunded. */
async function isCapturedPaymentFullyRefunded(client, orderId) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('The captured payment refund state must be read in its transaction.');
  }
  const { rows: paymentRows } = await client.query(
    `SELECT id, status
     FROM payments
     WHERE order_id = $1
     ORDER BY created_at, id
     FOR UPDATE`,
    [orderId]
  );
  const capturedPayments = paymentRows.filter((payment) => (
    ['succeeded', 'partially_refunded', 'refunded'].includes(payment.status)
  ));
  await client.query(
    `SELECT id
     FROM refunds
     WHERE order_id = $1
     ORDER BY id
     FOR UPDATE`,
    [orderId]
  );
  return capturedPayments.length === 1 && capturedPayments[0].status === 'refunded';
}

async function expireManualRefundRequests(client, orderId, paymentId, actorId, refundId) {
  const values = [orderId, paymentId, actorId];
  const targetClause = refundId ? 'AND id = $4' : '';
  if (refundId) values.push(refundId);
  const { rows } = await client.query(
    `UPDATE refunds
     SET status = 'expired',
         approved_by = $3,
         decided_at = now(),
         decision_note = '${MANUAL_REFUND_EXPIRY_REASON}',
         updated_at = now()
     WHERE order_id = $1 AND ($2::uuid IS NULL OR payment_id = $2)
       AND trigger = 'manual_admin'
       AND status = 'requested'
       AND ${MANUAL_REFUND_EXPIRY_PREDICATE}
       ${targetClause}
     RETURNING id, order_id, payment_id, requested_by, status`,
    values
  );
  for (const refund of rows) {
    await moneyAudit.recordMoneyAuditEvent(client, {
      actorId,
      action: 'manual_refund_expired',
      orderId,
      paymentId: refund.payment_id,
      refundId: refund.id,
      requestedBy: refund.requested_by,
      approvedBy: actorId,
      reason: MANUAL_REFUND_EXPIRY_REASON,
      metadata: { trigger: 'manual_admin', decision: 'expired' },
    });
  }
  return rows;
}

async function getRefundableAmount(client, order, payment) {
  const { rows } = await client.query(
    `WITH reserved AS (
       SELECT COALESCE(SUM(amount) FILTER (
                WHERE status = ANY($2::text[])
              ), 0) AS amount
       FROM refunds
       WHERE payment_id = $1
     ), balance AS (
       SELECT GREATEST($3::numeric - amount, 0)::numeric(12,2) AS total
       FROM reserved
     ), split AS (
       SELECT total,
              ROUND(total * $4::numeric / NULLIF($3::numeric, 0), 2)::numeric(12,2) AS item_price
       FROM balance
     )
     SELECT total::text AS total,
            item_price::text AS item_price,
            (total - item_price)::numeric(12,2)::text AS delivery_fee
     FROM split`,
    [payment.id, MANUAL_REFUND_RESERVED_STATUSES, payment.amount, order.agreed_item_price]
  );
  return rows[0];
}

/** FR-69, SEC-39: calculate the full captured balance and expire stale requests atomically. */
async function getRefundableBalance(orderId, actorId) {
  const result = await db.withTransaction(async (client) => {
    const { order, payment } = await lockManualRefundContext(client, orderId);
    const expiredRefunds = await expireManualRefundRequests(client, orderId, payment.id, actorId);
    const balance = await getRefundableAmount(client, order, payment);
    return {
      expiredRefunds,
      response: {
        orderId,
        refundableAmount: {
          total: balance.total,
          itemPrice: balance.item_price,
          deliveryFee: balance.delivery_fee,
        },
        currency: payment.currency,
      },
    };
  });
  notifyRefundStatusChanges(result.expiredRefunds);
  return result.response;
}

function validateAdminManualRefundListQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new ValidationError('Refund list query must be an object.');
  }
  const rawLimit = query.limit === undefined ? '20' : query.limit;
  if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit) ||
      !Number.isSafeInteger(Number(rawLimit)) || Number(rawLimit) < 1) {
    throw new ValidationError('limit must be a positive integer.');
  }
  const before = query.before === undefined ? null : query.before;
  if (before !== null && (typeof before !== 'string' || !UUID.test(before))) {
    throw new ValidationError('before must be a manual refund UUID.');
  }
  return { limit: Math.min(Number(rawLimit), 50), before };
}

/** FR-69, SEC-39: return a bounded, keyset-paginated Admin manual-refund queue. */
async function listAdminManualRefunds(query = {}, actorId) {
  const { limit, before } = validateAdminManualRefundListQuery(query);
  if (before) {
    const result = await db.read(
      `SELECT id
       FROM refunds
       WHERE id = $1 AND trigger = 'manual_admin'`,
      [before]
    );
    if (!result.rows[0]) throw new ValidationError('before must identify a manual refund.');
  }

  const { rows } = await db.read(
    `SELECT id AS "refundId",
            order_id AS "orderId",
            amount::text AS amount,
            currency,
            CASE WHEN status = 'requested' AND ${MANUAL_REFUND_EXPIRY_PREDICATE}
                 THEN 'expired' ELSE status END AS status,
            requested_by AS "requestedBy",
            requested_at AS "requestedAt",
            requested_at + INTERVAL '${MANUAL_REFUND_EXPIRY_WINDOW}' AS "expiresAt"
     FROM refunds
     WHERE trigger = 'manual_admin'
       AND ($1::uuid IS NULL OR (requested_at, id) < (
         SELECT c.requested_at, c.id
         FROM refunds c
         WHERE c.id = $1 AND c.trigger = 'manual_admin'
       ))
     ORDER BY requested_at DESC, id DESC
     LIMIT $2`,
    [before, limit + 1]
  );
  const hasMore = rows.length > limit;
  const refunds = rows.slice(0, limit).map((row) => ({
    ...row,
    requestedByMe: row.requestedBy === actorId,
  }));
  return {
    refunds,
    nextBefore: hasMore ? refunds[refunds.length - 1].refundId : null,
  };
}

/** FR-69, SEC-39: return one safe manual-refund detail for Admin review. */
async function getAdminManualRefund(refundId, actorId) {
  if (typeof refundId !== 'string' || !UUID.test(refundId)) {
    throw new ValidationError('refundId must be a UUID.');
  }
  const { rows } = await db.read(
    `SELECT id AS "refundId",
            order_id AS "orderId",
            amount::text AS amount,
            currency,
            CASE WHEN status = 'requested' AND ${MANUAL_REFUND_EXPIRY_PREDICATE}
                 THEN 'expired' ELSE status END AS status,
            requested_by AS "requestedBy",
            approved_by AS "approvedBy",
            requested_at AS "requestedAt",
            requested_at + INTERVAL '${MANUAL_REFUND_EXPIRY_WINDOW}' AS "expiresAt",
            approved_at AS "approvedAt",
            decided_at AS "decidedAt",
            reason,
            decision_note AS "decisionNote"
     FROM refunds
     WHERE id = $1 AND trigger = 'manual_admin'`,
    [refundId]
  );
  const refund = rows[0];
  if (!refund) throw new NotFoundError('refund');
  return { ...refund, requestedByMe: refund.requestedBy === actorId };
}

/** FR-69, SEC-39: create a full-balance manual request with a one-use request grant. */
async function requestManualRefund(orderId, actorId, sessionId, input, { isOrderPayoutReleased }) {
  const reason = normalizeManualRefundNote(input?.reason);
  if (typeof isOrderPayoutReleased !== 'function') throw new TypeError('Payout-state owner is required.');
  const result = await db.withTransaction(async (client) => {
    const { order, payment } = await lockManualRefundContext(client, orderId);
    const expiredRefunds = await expireManualRefundRequests(client, orderId, payment.id, actorId);
    if (await isOrderPayoutReleased(client, orderId)) {
      throw new ConflictError('A refund cannot be requested after payout release.');
    }

    const { rows: openRows } = await client.query(
      `SELECT id
       FROM refunds
       WHERE order_id = $1 AND trigger = 'manual_admin'
         AND status IN ('requested', 'approved', 'pending', 'failed')
       LIMIT 1`,
      [orderId]
    );
    if (openRows[0]) throw new ConflictError('An open manual refund request already exists.');

    const balance = await getRefundableAmount(client, order, payment);
    if (Number(balance.total) <= 0) throw new ConflictError('No refundable balance remains.');

    await users.consumeStepUpGrantWithClient(client, actorId, sessionId, 'refund.request', input.stepUpGrant);
    const refundId = randomUUID();
    const idempotencyKey = `refund:${payment.id}:manual:${refundId}`;
    await client.query(
      `INSERT INTO refunds
         (id, payment_id, order_id, trigger, amount, currency, status, idempotency_key,
          requested_by, reason)
       VALUES ($1, $2, $3, 'manual_admin', $4::numeric, $5, 'requested', $6, $7, $8)`,
      [refundId, payment.id, orderId, balance.total, payment.currency, idempotencyKey, actorId, reason]
    );
    await moneyAudit.recordMoneyAuditEvent(client, {
      actorId,
      action: 'manual_refund_requested',
      orderId,
      paymentId: payment.id,
      refundId,
      requestedBy: actorId,
      reason,
      metadata: { trigger: 'manual_admin' },
    });
    return {
      expiredRefunds,
      response: { refundId, status: 'requested', amount: balance.total, currency: payment.currency },
    };
  });
  notifyRefundStatusChanges(result.expiredRefunds);
  return result.response;
}

/** FR-69, SEC-39: approve or reject a pending manual request with a separate Admin grant. */
async function decideManualRefund(refundId, actorId, sessionId, input, { isOrderPayoutReleased }) {
  if (typeof refundId !== 'string' || !UUID.test(refundId)) {
    throw new ValidationError('refundId must be a UUID.');
  }
  if (!['approved', 'rejected'].includes(input?.decision)) {
    throw new ValidationError('A valid refund decision is required.');
  }
  const decisionNote = normalizeManualRefundNote(input?.reason);
  if (typeof isOrderPayoutReleased !== 'function') throw new TypeError('Payout-state owner is required.');
  const { rows: initialRows } = await db.read(
    `SELECT order_id, payment_id
     FROM refunds
     WHERE id = $1 AND trigger = 'manual_admin'`,
    [refundId]
  );
  const initial = initialRows[0];
  if (!initial) throw new NotFoundError('refund');

  const result = await db.withTransaction(async (client) => {
    const { order, payment } = await lockManualRefundContext(client, initial.order_id, initial.payment_id);
    const expiredRefunds = await expireManualRefundRequests(client, order.id, payment.id, actorId, refundId);
    const { rows: refundRows } = await client.query(
      `SELECT id, order_id, payment_id, requested_by, status
       FROM refunds
       WHERE id = $1 AND trigger = 'manual_admin'
       FOR UPDATE`,
      [refundId]
    );
    const refund = refundRows[0];
    if (!refund || refund.order_id !== order.id || refund.payment_id !== payment.id) {
      throw new NotFoundError('refund');
    }
    if (refund.status === 'expired') return { conflict: 'expired', expiredRefunds };
    if (refund.status !== 'requested') return { conflict: 'decided', expiredRefunds };
    if (refund.requested_by === actorId) {
      throw new ForbiddenError('The requester cannot decide their own refund.');
    }
    if (input.decision === 'approved' && await isOrderPayoutReleased(client, order.id)) {
      throw new ConflictError('A refund cannot be approved after payout release.');
    }

    await users.consumeStepUpGrantWithClient(client, actorId, sessionId, 'refund.decide', input.stepUpGrant);
    await client.query(
      `UPDATE refunds
       SET status = $2,
           approved_by = $3,
           approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END,
           decided_at = now(),
           decision_note = $4,
           updated_at = now()
       WHERE id = $1 AND status = 'requested'`,
      [refundId, input.decision, actorId, decisionNote]
    );
    if (input.decision === 'approved') await enqueueRefundJob(client, refundId);
    await moneyAudit.recordMoneyAuditEvent(client, {
      actorId,
      action: input.decision === 'approved' ? 'manual_refund_approved' : 'manual_refund_rejected',
      orderId: order.id,
      paymentId: payment.id,
      refundId,
      requestedBy: refund.requested_by,
      approvedBy: actorId,
      reason: decisionNote,
      metadata: { trigger: 'manual_admin', decision: input.decision },
    });
    return {
      expiredRefunds,
      refund: input.decision === 'rejected'
        ? { id: refundId, order_id: order.id, status: 'rejected' }
        : null,
      response: { refundId, status: input.decision, decision: input.decision },
    };
  });

  notifyRefundStatusChanges(result.expiredRefunds);
  if (result.refund) emitRefundStatusChange(result.refund);
  if (result.conflict === 'expired') throw new ConflictError('The manual refund request has expired.');
  if (result.conflict === 'decided') throw new ConflictError('The manual refund request has already been decided.');
  return result.response;
}

/** FR-69: expire stale requests and block seller payout while a manual refund is unresolved. */
async function assertNoOpenManualRefund(client, orderId, actorId) {
  const expiredRefunds = await expireManualRefundRequests(client, orderId, null, actorId);
  const { rows } = await client.query(
    `SELECT id
     FROM refunds
     WHERE order_id = $1 AND trigger = 'manual_admin'
       AND status IN ('requested', 'approved', 'pending', 'failed')
     LIMIT 1`,
    [orderId]
  );
  if (rows[0]) throw new ConflictError('An open manual refund request blocks payout release.');
  return expiredRefunds;
}

/** FR-69: publish committed refund status changes through the notification event path. */
function notifyRefundStatusChanges(refunds) {
  for (const refund of refunds) emitRefundStatusChange(refund);
}

function validateFailedRefundAttentionQuery(query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new ValidationError('Refund attention query must be an object.');
  }
  const rawLimit = query.limit === undefined ? '20' : query.limit;
  if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit) ||
      !Number.isSafeInteger(Number(rawLimit)) || Number(rawLimit) < 1 || Number(rawLimit) > 50) {
    throw new ValidationError('limit must be an integer from 1 to 50.');
  }
  const before = query.before === undefined ? null : query.before;
  if (before !== null && (typeof before !== 'string' || !UUID.test(before))) {
    throw new ValidationError('before must be a refund UUID.');
  }
  const includeUnflagged = query.includeUnflagged === true || query.includeUnflagged === 'true';
  return { limit: Number(rawLimit), before, includeUnflagged };
}

/** FR-69: return failed refunds that need admin attention. */
async function listFailedRefundsNeedingAttention(query = {}) {
  const { limit, before, includeUnflagged } = validateFailedRefundAttentionQuery(query);
  if (before) {
    const { rows } = await db.read(
      `SELECT id
       FROM refunds
       WHERE id = $1 AND status = 'failed'`,
      [before]
    );
    if (!rows[0]) throw new ValidationError('before must identify a failed refund.');
  }
  const cursorValue = before
    ? `SELECT COALESCE(c.needs_attention_at, TIMESTAMPTZ '1970-01-01T00:00:00Z'), c.id
       FROM refunds c WHERE c.id = $1`
    : null;
  const { rows } = await db.read(
    `SELECT id AS "refundId",
            order_id AS "orderId",
            trigger,
            amount::text AS amount,
            currency,
            attempt_count AS "attemptCount",
            last_error_code AS "lastErrorCode",
            last_attempt_at AS "lastAttemptAt",
            needs_attention_at AS "needsAttentionAt",
            requested_at AS "requestedAt"
     FROM refunds
     WHERE status = 'failed'
       AND (
         needs_attention_at IS NOT NULL
         OR $3 = TRUE
       )
       AND ($1::uuid IS NULL OR (
         COALESCE(needs_attention_at, TIMESTAMPTZ '1970-01-01T00:00:00Z'), id
       ) < (
         ${cursorValue || "TIMESTAMPTZ '1970-01-01T00:00:00Z', NULL::uuid"}
       ))
     ORDER BY needs_attention_at DESC NULLS LAST, id DESC
     LIMIT $2`,
    [before, limit + 1, includeUnflagged]
  );
  const hasMore = rows.length > limit;
  const refunds = rows.slice(0, limit);
  return {
    refunds,
    nextBefore: hasMore ? refunds[refunds.length - 1].refundId : null,
  };
}

/** FR-69: retry a failed refund with the same money intent and a distinct retry job key. */
async function retryFailedRefund(refundId, adminId, { isOrderPayoutReleased } = {}) {
  if (typeof refundId !== 'string' || !UUID.test(refundId)) {
    throw new ValidationError('refundId must be a UUID.');
  }
  if (typeof isOrderPayoutReleased !== 'function') {
    throw new TypeError('Payout-state owner is required.');
  }
  const result = await db.withTransaction(async (client) => {
    const { rows: initialRows } = await client.query(
      `SELECT order_id, payment_id
       FROM refunds
       WHERE id = $1
       FOR UPDATE`,
      [refundId]
    );
    const initial = initialRows[0];
    if (!initial) throw new NotFoundError('refund');

    const locked = await lockRefundPaymentOrder(client, initial.order_id, initial.payment_id, refundId);
    if (!locked) throw new NotFoundError('refund');
    const { order, payment, refund } = locked;
    if (refund.status !== 'failed') {
      throw new ConflictError('This refund is no longer failed and cannot be retried.');
    }
    if (refund.trigger === 'manual_admin' && await isOrderPayoutReleased(client, order.id)) {
      throw new ConflictError('A refund cannot be retried after payout release.');
    }

    const jobId = await enqueueRefundJob(
      client,
      refundId,
      `refund-retry:${refundId}:${refund.attempt_count}`
    );
    if (jobId) {
      await moneyAudit.recordMoneyAuditEvent(client, {
        actorId: adminId,
        action: 'refund_retry_requested',
        orderId: order.id,
        paymentId: payment.id,
        refundId: refund.id,
        metadata: {
          trigger: refund.trigger,
          attemptCount: refund.attempt_count,
        },
      });
    }
    return {
      refundId: refund.id,
      status: refund.status,
      retryQueued: Boolean(jobId),
    };
  });
  return result;
}

/** FR-69: execute a stored refund intent through the idempotent gateway outside database transactions. */
async function processRefundJob({ refundId, gateway } = {}) {
  if (typeof refundId !== 'string' || !UUID.test(refundId)) {
    throw new ValidationError('refundId must be a UUID.');
  }
  const { rows: initialRefundRows } = await db.read(
    'SELECT id, order_id, payment_id FROM refunds WHERE id = $1',
    [refundId]
  );
  const initialRefund = initialRefundRows[0];
  if (!initialRefund) return { outcome: 'missing' };

  const refundIntent = await db.withTransaction(async (client) => {
    const locked = await lockRefundPaymentOrder(
      client,
      initialRefund.order_id,
      initialRefund.payment_id,
      refundId
    );
    if (!locked) return null;
    const { refund, payment } = locked;
    if (!['requested', 'approved', 'pending', 'failed'].includes(refund.status)) {
      return { outcome: 'skipped', status: refund.status };
    }
    if (gateway && process.env.NODE_ENV === 'production') {
      throw new PaymentGatewayConfigurationError();
    }

    await client.query(
      `UPDATE refunds
       SET status = 'pending', updated_at = now()
       WHERE id = $1`,
      [refund.id]
    );
    return {
      orderId: refund.order_id,
      paymentId: payment.id,
      providerPaymentRef: payment.provider_payment_id,
      amount: String(refund.amount),
      idempotencyKey: refund.idempotency_key,
    };
  });
  if (!refundIntent) return { outcome: 'missing' };
  if (refundIntent.outcome) return refundIntent;

  const selectedGateway = gateway || paymentGateway.getPaymentGateway();
  let gatewayResult;
  try {
    if (typeof refundIntent.providerPaymentRef !== 'string' || !refundIntent.providerPaymentRef) {
      throw new PaymentGatewayUnavailableError();
    }
    gatewayResult = await selectedGateway.createRefund({
      providerPaymentRef: refundIntent.providerPaymentRef,
      amount: refundIntent.amount,
      idempotencyKey: refundIntent.idempotencyKey,
    });
    if (!gatewayResult || typeof gatewayResult.providerRefundRef !== 'string' ||
        !gatewayResult.providerRefundRef ||
        gatewayResult.providerPaymentRef !== refundIntent.providerPaymentRef ||
        String(gatewayResult.amount) !== refundIntent.amount ||
        gatewayResult.status !== 'succeeded') {
      throw new PaymentGatewayUnavailableError();
    }
  } catch (error) {
    const failureCode = classifyRefundFailureCode(error);
    const maxAttempts = getRefundMaxAutoAttempts();
    const failedRefund = await db.withTransaction(async (client) => {
      const locked = await lockRefundPaymentOrder(
        client,
        refundIntent.orderId,
        refundIntent.paymentId,
        refundId
      );
      if (!locked) return null;
      const { refund } = locked;
      const newlyNeedsAttention = !refund.needs_attention_at &&
        refund.attempt_count + 1 >= maxAttempts;
      const { rows } = await client.query(
        `UPDATE refunds
         SET status = 'failed',
             attempt_count = attempt_count + 1,
             last_error_code = $2,
             last_attempt_at = now(),
             updated_at = now(),
             needs_attention_at = CASE
               WHEN attempt_count + 1 >= $3 AND needs_attention_at IS NULL THEN now()
               ELSE needs_attention_at
             END
         WHERE id = $1 AND status = 'pending'
         RETURNING id, order_id, trigger, status, attempt_count, last_error_code, needs_attention_at`,
        [refundId, failureCode, maxAttempts]
      );
      const update = rows[0] || null;
      if (update && newlyNeedsAttention && update.needs_attention_at) {
        await moneyAudit.recordMoneyAuditEvent(client, {
          action: 'refund_needs_attention',
          orderId: update.order_id,
          paymentId: refundIntent.paymentId,
          refundId: update.id,
          metadata: {
            attemptCount: update.attempt_count,
            lastErrorCode: update.last_error_code,
            trigger: update.trigger,
          },
        });
      }
      return update ? { ...update, newlyNeedsAttention } : null;
    });
    if (failedRefund) {
      emitRefundStatusChange({ id: failedRefund.id, order_id: failedRefund.order_id, status: failedRefund.status });
      if (failedRefund.newlyNeedsAttention && failedRefund.needs_attention_at) {
        console.error(JSON.stringify({
          refundId,
          orderId: failedRefund.order_id,
          trigger: failedRefund.trigger,
          code: failureCode,
        }));
      }
    }
    throw new PaymentGatewayUnavailableError();
  }

  const result = await db.withTransaction(async (client) => {
    const locked = await lockRefundPaymentOrder(
      client,
      refundIntent.orderId,
      refundIntent.paymentId,
      refundId
    );
    if (!locked) return { outcome: 'missing' };
    const { order, payment, refund } = locked;
    if (!['requested', 'approved', 'pending', 'failed'].includes(refund.status)) {
      return { outcome: 'skipped', status: refund.status };
    }

    const { rowCount } = await client.query(
      `UPDATE refunds
       SET status = 'succeeded', provider_refund_id = $2,
           completed_at = COALESCE(completed_at, now()), updated_at = now()
       WHERE id = $1 AND status IN ('requested', 'approved', 'pending', 'failed')`,
      [refundId, gatewayResult.providerRefundRef]
    );
    if (!rowCount) return { outcome: 'skipped', status: refund.status };

    await client.query(
      `INSERT INTO ledger_entries
         (order_id, payment_id, refund_id, currency, amount, entry_type, idempotency_key)
       VALUES ($1, $2, $3, $4, -($5::numeric), 'refund', $6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        order.id,
        payment.id,
        refund.id,
        refund.currency,
        refund.amount,
        `refund:${refund.id}`,
      ]
    );
    await moneyAudit.recordMoneyAuditEvent(client, {
      action: 'system_refund_succeeded',
      orderId: order.id,
      paymentId: payment.id,
      refundId: refund.id,
      reason: refund.reason,
      metadata: {
        trigger: refund.trigger,
        providerRefundRef: gatewayResult.providerRefundRef,
      },
    });

    const { rows: totalRows } = await client.query(
      `SELECT COALESCE(SUM(amount), 0) = $2::numeric AS fully_refunded
       FROM refunds
       WHERE payment_id = $1 AND status = 'succeeded'`,
      [payment.id, payment.amount]
    );
    let paymentBecameRefunded = false;
    if (totalRows[0].fully_refunded) {
      const { rowCount } = await client.query(
        `UPDATE payments
         SET status = 'refunded', updated_at = now()
         WHERE id = $1 AND status <> 'refunded'`,
        [payment.id]
      );
      paymentBecameRefunded = rowCount === 1;
    }
    if (refund.trigger === 'manual_admin' && paymentBecameRefunded) {
      const registered = await eventBus.emitAsync(
        events.MANUAL_REFUND_SUCCEEDED,
        {
          orderId: order.id,
          paymentId: payment.id,
          refundId: refund.id,
          approvedBy: refund.approved_by,
        },
        { transaction: client }
      );
      if (!registered) {
        throw new TypeError('The delivery exception owner is not listening for manual refund completion.');
      }
    }
    return {
      outcome: 'succeeded',
      refundId,
      refundStatusChange: { id: refund.id, order_id: order.id, status: 'succeeded' },
    };
  });
  if (result.refundStatusChange) emitRefundStatusChange(result.refundStatusChange);
  const { refundStatusChange, ...publicResult } = result;
  return publicResult;
}

/** FR-65, FR-72: lock an order's payment rows after its reservation is locked. */
async function lockPaymentsForOrder(client, orderId) {
  const { rows } = await client.query(
    `SELECT id, order_id, status, amount, currency
     FROM payments
     WHERE order_id = $1
     ORDER BY created_at, id
     FOR UPDATE`,
    [orderId]
  );
  return rows;
}

/** FR-65: record a manual seller payout in the caller's transaction. */
async function recordManualSellerPayout(client, {
  orderId,
  paymentId,
  adminId,
  payoutReference,
  note,
  itemPrice,
  deliveryFee,
  sellerNetAmount,
  commissionAmount,
  currency,
}) {
  if (sellerNetAmount !== '0.00') {
    await client.query(
      `INSERT INTO ledger_entries
         (order_id, payment_id, currency, amount, entry_type, idempotency_key)
       VALUES ($1, $2, $3, -($4::numeric), 'seller_payout_manual', $5)`,
      [orderId, paymentId, currency, sellerNetAmount, `seller_payout_manual:${orderId}`]
    );
  }
  await moneyAudit.recordMoneyAuditEvent(client, {
    actorId: adminId,
    action: 'seller_payout_manual_released',
    orderId,
    paymentId,
    reason: note,
    metadata: {
      payoutReference,
      note,
      itemPrice,
      deliveryFee,
      sellerNetAmount,
      commissionAmount,
      currency,
    },
  });
}

/** FR-72: lock payment and refund rows after the order reservation is locked. */
async function lockPaymentAndRefundRowsForHandover(client, orderId) {
  await lockPaymentsForOrder(client, orderId);
  const { rows } = await client.query(
    `SELECT id, trigger
     FROM refunds
     WHERE order_id = $1
     ORDER BY created_at, id
     FOR UPDATE`,
    [orderId]
  );
  return rows;
}

/** FR-72: write the financial audit record for an Admin-recorded courier handover. */
async function recordCourierHandoverAuditEvent(client, { orderId, adminId, courierPickupAt, hasTrackingNumber }) {
  await moneyAudit.recordMoneyAuditEvent(client, {
    actorId: adminId,
    action: 'courier_handover_recorded',
    orderId,
    reason: 'Admin recorded courier handover',
    metadata: { courierPickupAt, hasTrackingNumber },
  });
}

/** FR-68: write the financial audit record for an Admin-recorded delivery. */
async function recordOrderDeliveredAuditEvent(client, { orderId, adminId }) {
  await moneyAudit.recordMoneyAuditEvent(client, {
    actorId: adminId,
    action: 'order_delivered',
    orderId,
    reason: 'Admin marked reservation-backed order delivered',
  });
}

/** FR-72e: write the financial audit record for an Admin-resolved order exception. */
async function recordOrderExceptionResolvedAuditEvent(client, {
  orderId, adminId, exceptionId, kind, resolutionNote,
}) {
  await moneyAudit.recordMoneyAuditEvent(client, {
    actorId: adminId,
    action: 'order_exception_resolved',
    orderId,
    reason: resolutionNote,
    metadata: { exceptionId, kind },
  });
}

/** FR-45: record a dispute-resolution money audit once in the caller's transaction. */
async function recordDisputeResolutionAuditEvent(client, {
  orderId, adminId, disputeId, resolutionStatus,
}) {
  const action = resolutionStatus === 'resolved_refund'
    ? 'dispute_refund_required'
    : 'dispute_resolved_release';
  const reason = resolutionStatus === 'resolved_refund'
    ? 'Dispute resolved in the buyer\'s favour; refund must be made manually'
    : 'Dispute resolved in the seller\'s favour; payout hold resumed';
  return moneyAudit.recordMoneyAuditEventOnce(client, {
    actorId: adminId,
    action,
    orderId,
    reason,
    metadata: { disputeId, resolutionStatus },
    uniqueMetadataKey: 'disputeId',
    uniqueMetadataValue: disputeId,
  });
}

function getCapturedPayment(payments) {
  return payments.find((payment) => ['succeeded', 'refunded', 'partially_refunded'].includes(payment.status));
}

async function getBuyerCancellationRefund(client, orderId, payments) {
  const keys = payments.map((payment) => `refund:${payment.id}:cancel`);
  if (!keys.length) return null;
  const { rows } = await client.query(
    `SELECT status
     FROM refunds
     WHERE order_id = $1 AND idempotency_key = ANY($2::text[])
     LIMIT 1`,
    [orderId, keys]
  );
  return rows[0] ? { status: rows[0].status } : null;
}

/** FR-33a: cancel a reservation-backed buyer order and request its full system refund when captured. */
async function cancelReservationOrder({ orderId, buyerId }) {
  validateOrderId(orderId);
  if (typeof buyerId !== 'string' || !UUID.test(buyerId)) {
    throw new ValidationError('buyerId must be a UUID.');
  }

  const result = await db.withTransactionRetry(async (client) => {
    const context = await orders.getMoneyLockContext(client, orderId);
    if (!context) throw new NotFoundError('order', orderId);
    if (context.buyer_id !== buyerId) throw new NotFoundError('order', orderId);
    if (!(await listings.lockListingForMoneyAction(client, context.listing_id))) {
      throw new NotFoundError('listing', context.listing_id);
    }
    if (!(await users.lockBuyerForMoneyAction(client, buyerId))) {
      throw new NotFoundError('buyer', buyerId);
    }
    const order = await orders.lockReservationOrderForSystemAction(client, orderId);
    if (!order || order.listing_id !== context.listing_id || order.buyer_id !== context.buyer_id) {
      throw new NotFoundError('order', orderId);
    }
    if (order.reservation_id === null) return { legacy: true };
    if (order.buyer_id !== buyerId) throw new NotFoundError('order', orderId);

    const reservation = await reservations.lockReservationForSystemAction(client, order.reservation_id);
    if (!reservation || reservation.listing_id !== order.listing_id) {
      throw new ConflictError('The order reservation is no longer available.');
    }
    const payments = await lockPaymentsForOrder(client, order.id);

    if (order.status === 'cancelled' && reservation.end_reason === 'buyer_cancelled') {
      return {
        legacy: false,
        orderId: order.id,
        status: 'cancelled',
        refund: await getBuyerCancellationRefund(client, order.id, payments),
      };
    }

    const isUnpaid = ['reserved', 'payment_pending'].includes(order.status) &&
      reservation.status === 'active';
    const isCaptured = ['funded', 'seller_preparing'].includes(order.status) &&
      reservation.status === 'paid' && order.handed_over_at === null;
    if (!isUnpaid && !isCaptured) {
      throw new ConflictError('This order is no longer eligible for pre-handover cancellation.');
    }

    const cancelledOrder = await orders.cancelReservationOrder(
      client,
      order.id,
      [order.status]
    );
    if (!cancelledOrder) throw new ConflictError('The order state changed before cancellation.');

    const endedReservation = await reservations.endReservationForSystemAction(client, reservation.id, {
      status: isUnpaid ? 'cancelled' : 'released',
      endReason: 'buyer_cancelled',
      allowedStatuses: [reservation.status],
    });
    if (!endedReservation) throw new ConflictError('The reservation state changed before cancellation.');

    if (isUnpaid) {
      await client.query(
        `UPDATE payments
         SET status = 'cancelled', updated_at = now()
         WHERE order_id = $1 AND status IN ('created', 'pending')`,
        [order.id]
      );
    }

    let refund = null;
    if (isCaptured) {
      const payment = getCapturedPayment(payments);
      if (!payment || payment.status !== 'succeeded') {
        throw new ConflictError('The captured payment is not available for cancellation refund.');
      }
      const intent = await createSystemRefundIntent(client, {
        payment,
        order,
        trigger: 'system_cancel',
        reason: 'Buyer cancelled before courier handover',
      });
      refund = { status: intent.status };
    }

    await listings.syncAvailabilityProjection(client, order.listing_id);
    return { legacy: false, orderId: order.id, status: 'cancelled', refund };
  });
  if (!result.legacy && result.status === 'cancelled') {
    eventBus.emit(events.ORDER_CANCELLED, { orderId });
  }
  return result;
}

/** FR-63a: cancel a reserved listing's unpaid or unhanded paid order during moderator take-down. */
async function handleListingTakedown(client, listingId) {
  const candidate = await reservations.getLiveReservationForListing(client, listingId);
  if (!candidate) return false;
  const orderId = await orders.getOrderIdForReservation(client, candidate.id);
  if (!orderId) throw new ConflictError('The live reservation has no owning order.');

  const context = await orders.getMoneyLockContext(client, orderId);
  if (!context || context.listing_id !== listingId) return false;
  if (!(await users.lockBuyerForMoneyAction(client, context.buyer_id))) return false;
  const order = await orders.lockReservationOrderForSystemAction(client, orderId);
  if (!order || order.reservation_id !== candidate.id || order.listing_id !== listingId ||
      order.buyer_id !== context.buyer_id) {
    return false;
  }
  const reservation = await reservations.lockReservationForSystemAction(client, candidate.id);
  if (!reservation || reservation.listing_id !== listingId) return false;
  const payments = await lockPaymentsForOrder(client, order.id);

  const isUnpaid = reservation.status === 'active' &&
    ['reserved', 'payment_pending'].includes(order.status);
  if (isUnpaid) {
    const cancelledOrder = await orders.cancelReservationOrder(client, order.id, [order.status]);
    const releasedReservation = await reservations.endReservationForSystemAction(client, reservation.id, {
      status: 'released',
      endReason: 'listing_taken_down',
      allowedStatuses: ['active'],
    });
    if (!cancelledOrder || !releasedReservation) {
      throw new ConflictError('The listing reservation changed during take-down.');
    }
    await client.query(
      `UPDATE payments
       SET status = 'cancelled', updated_at = now()
       WHERE order_id = $1 AND status IN ('created', 'pending')`,
      [order.id]
    );
    return order.id;
  }

  if (reservation.status === 'paid' && order.handed_over_at !== null) {
    await moneyAudit.recordMoneyAuditEvent(client, {
      action: 'takedown_after_handover',
      orderId: order.id,
      reason: 'Listing taken down after courier handover',
      metadata: { listingId },
    });
    return true;
  }

  const isUnhandedPaidOrder = reservation.status === 'paid' &&
    ['funded', 'seller_preparing'].includes(order.status) &&
    order.handed_over_at === null;
  if (!isUnhandedPaidOrder) return true;

  const payment = getCapturedPayment(payments);
  if (!payment || payment.status !== 'succeeded') {
    throw new ConflictError('The captured payment is not available for take-down refund.');
  }
  const cancelledOrder = await orders.cancelReservationOrder(client, order.id, [order.status]);
  const releasedReservation = await reservations.endReservationForSystemAction(client, reservation.id, {
    status: 'released',
    endReason: 'listing_taken_down',
    allowedStatuses: ['paid'],
  });
  if (!cancelledOrder || !releasedReservation) {
    throw new ConflictError('The listing reservation changed during take-down.');
  }
  await createSystemRefundIntent(client, {
    payment,
    order,
    trigger: 'system_cancel',
    reason: 'Listing taken down',
  });
  return order.id;
}

/** FR-72: cancel and fully refund a paid order after its database handover deadline. */
async function refundUnhandedOverOrder({ orderId }) {
  validateOrderId(orderId);
  const result = await db.withTransactionRetry(async (client) => {
    const context = await orders.getMoneyLockContext(client, orderId);
    if (!context || context.reservation_id === null) return { outcome: 'skipped' };
    if (!(await listings.lockListingForMoneyAction(client, context.listing_id)) ||
        !(await users.lockBuyerForMoneyAction(client, context.buyer_id))) {
      return { outcome: 'skipped' };
    }
    const order = await orders.lockReservationOrderForSystemAction(client, orderId);
    if (!order || order.reservation_id === null || order.listing_id !== context.listing_id ||
        order.buyer_id !== context.buyer_id) return { outcome: 'skipped' };
    const reservation = await reservations.lockReservationForSystemAction(client, order.reservation_id);
    if (!reservation) return { outcome: 'skipped' };
    const payments = await lockPaymentsForOrder(client, order.id);

    if (!['funded', 'seller_preparing'].includes(order.status) ||
        order.handed_over_at !== null || !order.handover_due ||
        reservation.status !== 'paid') {
      return { outcome: 'not_due' };
    }
    const payment = getCapturedPayment(payments);
    if (!payment || payment.status !== 'succeeded') {
      return { outcome: 'skipped' };
    }

    const cancelledOrder = await orders.cancelReservationOrder(client, order.id, [order.status]);
    const releasedReservation = await reservations.endReservationForSystemAction(client, reservation.id, {
      status: 'released',
      endReason: 'handover_timeout',
      allowedStatuses: ['paid'],
    });
    if (!cancelledOrder || !releasedReservation) {
      throw new ConflictError('The order state changed before the handover timeout.');
    }
    const intent = await createSystemRefundIntent(client, {
      payment,
      order,
      trigger: 'system_handover_timeout',
      reason: 'Seller handover deadline exceeded',
    });
    await listings.syncAvailabilityProjection(client, order.listing_id);
    return { outcome: 'refunded', refundId: intent.refundId };
  });
  if (result.outcome === 'refunded') {
    eventBus.emit(events.ORDER_AUTO_CANCELLED, { orderId });
  }
  return result;
}

function validateOrderId(orderId) {
  if (typeof orderId !== 'string' || !UUID.test(orderId)) {
    throw new ValidationError('orderId must be a UUID.');
  }
}

function hostedCheckoutResponse(payment, reservationExpiresAt, created) {
  return {
    paymentId: payment.id,
    status: payment.status,
    checkoutUrl: payment.hosted_checkout_url || null,
    expiresAt: reservationExpiresAt,
    amount: String(payment.amount),
    currency: payment.currency,
    created,
  };
}

function validateCheckoutResult(result) {
  if (!result || typeof result.providerPaymentRef !== 'string' || !result.providerPaymentRef ||
      typeof result.checkoutUrl !== 'string' || !result.checkoutUrl) {
    throw new PaymentGatewayUnavailableError();
  }
  let url;
  try { url = new URL(result.checkoutUrl); } catch { throw new PaymentGatewayUnavailableError(); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname) {
    throw new PaymentGatewayUnavailableError();
  }
}

/** FR-60a: persist and reuse one reservation payment intent before hosted checkout creation. */
async function createOrReusePayment({ orderId, buyerId }) {
  validateOrderId(orderId);
  if (typeof buyerId !== 'string' || !UUID.test(buyerId)) {
    throw new ValidationError('buyerId must be a UUID.');
  }

  const gateway = paymentGateway.getPaymentGateway();
  const returnUrl = buildPaymentReturnUrl(orderId);
  const intent = await db.withTransaction(async (client) => {
    const context = await orders.getMoneyLockContext(client, orderId);
    if (!context || context.buyer_id !== buyerId) throw new NotFoundError('order', orderId);
    if (!(await listings.lockListingForMoneyAction(client, context.listing_id))) {
      throw new NotFoundError('listing', context.listing_id);
    }
    if (!(await users.lockBuyerForMoneyAction(client, buyerId))) {
      throw new NotFoundError('buyer', buyerId);
    }
    const { rows: orderRows } = await client.query(
      `SELECT id, listing_id, buyer_id, reservation_id, status
       FROM orders
       WHERE id = $1 AND buyer_id = $2
       FOR UPDATE`,
      [orderId, buyerId]
    );
    const order = orderRows[0];
    if (!order || order.listing_id !== context.listing_id) throw new NotFoundError('order', orderId);
    if (!order.reservation_id ||
        !['reserved', 'payment_pending'].includes(order.status)) {
      throw new ConflictError('Order is not available for payment.');
    }

    const { rows: reservationRows } = await client.query(
      `SELECT id, status, total_amount_snapshot, currency, expires_at,
              expires_at > now() AS is_unexpired
       FROM reservations
       WHERE id = $1
       FOR UPDATE`,
      [order.reservation_id]
    );
    const reservation = reservationRows[0];
    if (!reservation || reservation.status !== 'active' || !reservation.is_unexpired) {
      throw new ConflictError('Reservation is no longer active.');
    }

    const { rows: paymentRows } = await client.query(
      `SELECT id, status, amount, currency, idempotency_key,
              provider_payment_id, hosted_checkout_reference, hosted_checkout_url
       FROM payments
       WHERE order_id = $1
       ORDER BY created_at DESC, id DESC
       FOR UPDATE`,
      [orderId]
    );
    if (paymentRows.some((payment) => payment.status === 'succeeded')) {
      throw new ConflictError('Order payment has already succeeded.');
    }

    await client.query(
      `UPDATE orders
       SET status = 'payment_pending'
       WHERE id = $1 AND status = 'reserved'`,
      [orderId]
    );

    const openPayment = paymentRows.find((payment) => ['created', 'pending'].includes(payment.status));
    if (openPayment) {
      if (openPayment.status === 'pending') {
        if (!openPayment.hosted_checkout_url) {
          throw new PaymentGatewayUnavailableError();
        }
        return {
          payment: openPayment,
          reservationExpiresAt: reservation.expires_at,
          created: false,
          needsCheckout: false,
        };
      }
      return {
        payment: openPayment,
        reservationExpiresAt: reservation.expires_at,
        created: false,
        needsCheckout: true,
      };
    }

    const { rows: attempts } = await client.query(
      `SELECT count(*)::int AS failed_attempts
       FROM payments
       WHERE order_id = $1 AND status IN ('failed', 'cancelled')`,
      [orderId]
    );
    const attempt = attempts[0].failed_attempts + 1;
    const idempotencyKey = `pay:${reservation.id}:${attempt}`;
    const { rows: insertedRows } = await client.query(
      `INSERT INTO payments
         (order_id, provider, status, amount, currency, gateway_fee_currency, idempotency_key)
       VALUES ($1, $2, 'created', $3::numeric, $4, 'PKR', $5)
       RETURNING id, status, amount, currency, idempotency_key,
                 provider_payment_id, hosted_checkout_reference, hosted_checkout_url`,
      [orderId, gateway.provider, reservation.total_amount_snapshot, reservation.currency, idempotencyKey]
    );
    return {
      payment: insertedRows[0],
      reservationExpiresAt: reservation.expires_at,
      created: true,
      needsCheckout: true,
    };
  });

  if (!intent.needsCheckout) {
    return hostedCheckoutResponse(intent.payment, intent.reservationExpiresAt, intent.created);
  }

  let checkout;
  try {
    checkout = await gateway.createHostedCheckout({
      orderRef: orderId,
      amount: String(intent.payment.amount),
      currency: intent.payment.currency,
      idempotencyKey: intent.payment.idempotency_key,
      returnUrl,
    });
    validateCheckoutResult(checkout);
  } catch (error) {
    if (error instanceof PaymentGatewayConfigurationError) throw error;
    throw new PaymentGatewayUnavailableError(error);
  }

  const storedPayment = await db.withTransaction(async (client) => {
    const { rows: updatedRows } = await client.query(
      `UPDATE payments
       SET provider_payment_id = $2,
           provider_reference = $2,
           hosted_checkout_reference = $2,
           hosted_checkout_url = $3,
           provider_created_at = now(),
           provider_updated_at = now(),
           status = 'pending',
           updated_at = now()
       WHERE id = $1 AND status = 'created' AND hosted_checkout_reference IS NULL
       RETURNING id, status, amount, currency, hosted_checkout_url`,
      [intent.payment.id, checkout.providerPaymentRef, checkout.checkoutUrl]
    );
    if (updatedRows[0]) return updatedRows[0];

    const { rows: currentRows } = await client.query(
      `SELECT id, status, amount, currency, hosted_checkout_url
       FROM payments
       WHERE id = $1`,
      [intent.payment.id]
    );
    const current = currentRows[0];
    if (current?.status === 'pending' && current.hosted_checkout_url) return current;
    throw new PaymentGatewayUnavailableError();
  });

  return hostedCheckoutResponse(storedPayment, intent.reservationExpiresAt, intent.created);
}

/** FR-61: return only stored order, reservation, and payment state; never infer a payment from a browser return. */
async function getPaymentStatus({ orderId, buyerId }) {
  validateOrderId(orderId);
  if (typeof buyerId !== 'string' || !UUID.test(buyerId)) {
    throw new ValidationError('buyerId must be a UUID.');
  }
  const { rows } = await db.read(
    `SELECT o.id AS order_id, o.status AS order_status,
            r.id AS reservation_id, r.status AS reservation_status, r.expires_at,
            p.id AS payment_id, p.status AS payment_status, p.amount, p.currency,
            p.hosted_checkout_url
     FROM orders o
     LEFT JOIN reservations r ON r.id = o.reservation_id
     LEFT JOIN LATERAL (
       SELECT id, status, amount, currency, hosted_checkout_url
       FROM payments
       WHERE order_id = o.id
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) p ON true
     WHERE o.id = $1 AND o.buyer_id = $2`,
    [orderId, buyerId]
  );
  const row = rows[0];
  if (!row) throw new NotFoundError('order', orderId);
  if (!row.reservation_id) throw new ConflictError('Order does not have a fixed-price reservation.');
  return {
    orderId: row.order_id,
    reservationStatus: row.reservation_status,
    orderStatus: row.order_status,
    paymentId: row.payment_id,
    status: row.payment_status,
    checkoutUrl: row.hosted_checkout_url,
    expiresAt: row.expires_at,
    amount: row.amount === null ? null : String(row.amount),
    currency: row.currency,
  };
}

/** FR-61, FR-62: process a verified webhook exactly once using database locks and time. */
async function processPaymentWebhookJob({ webhookInboxId }) {
  if (typeof webhookInboxId !== 'string' || !UUID.test(webhookInboxId)) {
    throw new ValidationError('webhookInboxId must be a UUID.');
  }

  const { rows: initialInboxRows } = await db.read(
    `SELECT id, provider, event_type, raw_body, payment_id, status
     FROM webhook_inbox
     WHERE id = $1`,
    [webhookInboxId]
  );
  const initialInbox = initialInboxRows[0];
  if (!initialInbox) return { outcome: 'missing' };
  const initialEvent = parseWebhookEvent(initialInbox.raw_body);
  const paymentLookup = await findPaymentForWebhook(initialInbox, initialEvent);

  let fundedOrderId = null;
  try {
    const result = await db.withTransaction(async (client) => {
      let order = null;
      let reservation = null;
      let payment = null;
      if (paymentLookup) {
        const context = await orders.getMoneyLockContext(client, paymentLookup.order_id);
        if (context) {
          const listing = await listings.lockListingForMoneyAction(client, context.listing_id);
          const buyer = listing && await users.lockBuyerForMoneyAction(client, context.buyer_id);
          if (listing && buyer) {
            const { rows: orderRows } = await client.query(
              `SELECT id, listing_id, buyer_id, reservation_id, status
               FROM orders
               WHERE id = $1
               FOR UPDATE`,
              [paymentLookup.order_id]
            );
            order = orderRows[0] || null;
            if (!order || order.listing_id !== context.listing_id ||
                order.buyer_id !== context.buyer_id) order = null;

            if (order?.reservation_id) {
              const { rows: reservationRows } = await client.query(
                `SELECT id, status, expires_at, expires_at > now() AS is_unexpired
                 FROM reservations
                 WHERE id = $1
                 FOR UPDATE`,
                [order.reservation_id]
              );
              reservation = reservationRows[0] || null;
            }
          }
        }

        const { rows: paymentRows } = await client.query(
          `SELECT id, order_id, provider, provider_payment_id, provider_reference,
                  status, amount, currency
           FROM payments
           WHERE id = $1
           FOR UPDATE`,
          [paymentLookup.id]
        );
        payment = paymentRows[0] || null;
      }

      const { rows: inboxRows } = await client.query(
        `SELECT id, provider, provider_event_id, event_type, raw_body, payment_id, status
         FROM webhook_inbox
         WHERE id = $1
         FOR UPDATE`,
        [webhookInboxId]
      );
      const inbox = inboxRows[0];
      if (!inbox) return { outcome: 'missing' };
      await client.query(
        'UPDATE webhook_inbox SET attempts = attempts + 1 WHERE id = $1',
        [webhookInboxId]
      );
      if (inbox.status === 'processed' || inbox.status === 'failed') {
        return { outcome: inbox.status };
      }

      const event = parseWebhookEvent(inbox.raw_body);
      const paymentMatches = payment && paymentLookup &&
        payment.id === paymentLookup.id &&
        payment.order_id === paymentLookup.order_id &&
        payment.provider === inbox.provider &&
        typeof event?.providerPaymentRef === 'string' &&
        payment.provider_payment_id === event.providerPaymentRef &&
        (inbox.payment_id === null || inbox.payment_id === payment.id);

      if (paymentMatches && inbox.payment_id === null) {
        await client.query(
          'UPDATE webhook_inbox SET payment_id = $2 WHERE id = $1 AND payment_id IS NULL',
          [inbox.id, payment.id]
        );
      }

      if (!event || event.type !== inbox.event_type ||
          event.eventId !== inbox.provider_event_id) {
        return recordWebhookFailure(client, inbox, paymentMatches ? payment : null, 'invalid_event');
      }
      if (!paymentMatches) {
        return recordWebhookFailure(client, inbox, null, 'unmatched_payment');
      }
      if (!SUPPORTED_PAYMENT_EVENTS.has(event.type)) {
        return recordWebhookFailure(client, inbox, payment, 'unsupported_event_type');
      }
      if (typeof event.amount !== 'string' || !WEBHOOK_AMOUNT.test(event.amount)) {
        return recordWebhookFailure(client, inbox, payment, 'amount_mismatch');
      }
      const { rows: amountRows } = await client.query(
        'SELECT $1::numeric = $2::numeric AS matches',
        [event.amount, payment.amount]
      );
      if (!amountRows[0].matches) {
        return recordWebhookFailure(client, inbox, payment, 'amount_mismatch');
      }
      if (typeof event.currency !== 'string' || event.currency !== payment.currency) {
        return recordWebhookFailure(client, inbox, payment, 'currency_mismatch');
      }
      if (payment.status === 'succeeded' || payment.status === 'late') {
        return recordWebhookProcessed(client, inbox);
      }

      if (event.type === 'payment.failed') {
        await client.query(
          `UPDATE payments
           SET status = 'failed', provider_updated_at = now(), updated_at = now()
           WHERE id = $1 AND status NOT IN ('succeeded', 'late')`,
          [payment.id]
        );
        return recordWebhookProcessed(client, inbox);
      }

      if (!order) {
        return recordWebhookFailure(client, inbox, payment, 'unmatched_payment');
      }
      const isLate = !reservation ||
        ['expired', 'released', 'cancelled'].includes(reservation.status) ||
        (reservation.status === 'active' && !reservation.is_unexpired) ||
        order?.status === 'cancelled';
      const isFunding = reservation?.status === 'active' &&
        reservation.is_unexpired && order.status === 'payment_pending';
      const refundReason = isLate
        ? 'Late payment after reservation ended'
        : reservation?.status === 'paid'
          ? 'Duplicate capture: reservation already paid'
          : 'Ineligible capture: order not awaiting payment';

      await client.query(
        `UPDATE payments
         SET status = $2, succeeded_at = now(), provider_updated_at = now(),
             provider_payment_id = COALESCE(provider_payment_id, $3),
             provider_reference = COALESCE(provider_reference, $3),
             updated_at = now()
         WHERE id = $1`,
        [payment.id, isFunding ? 'succeeded' : 'late', event.providerPaymentRef]
      );
      await client.query(
        `INSERT INTO ledger_entries
           (order_id, payment_id, currency, amount, entry_type, idempotency_key)
         VALUES ($1, $2, $3, $4::numeric, 'capture', $5)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [order.id, payment.id, payment.currency, payment.amount, `capture:${payment.id}`]
      );

      if (!isFunding) {
        if (isLate && reservation?.status === 'active' && !reservation.is_unexpired) {
          const expired = await reservations.expireReservationForLatePayment(client, reservation.id);
          if (expired) {
            await orders.cancelUnpaidReservationOrder(client, order.id);
            await listings.syncAvailabilityProjection(client, order.listing_id);
          }
        }
        await createSystemRefundIntent(client, {
          payment,
          order,
          trigger: 'system_expiry',
          reason: refundReason,
        });
      } else {
        const paid = await reservations.markReservationPaid(client, reservation.id);
        const funded = await orders.fundReservationOrder(client, order.id, reservation.id);
        if (!paid || !funded) {
          throw new ConflictError('Payment funding state changed before commit.');
        }
        await listings.syncAvailabilityProjection(client, order.listing_id);
        await moneyAudit.recordMoneyAuditEvent(client, {
          action: 'payment_funded',
          orderId: order.id,
          paymentId: payment.id,
          reason: 'verified_webhook',
          metadata: { eventType: event.type },
        });
        fundedOrderId = order.id;
      }

      return recordWebhookProcessed(client, inbox);
    });
    if (fundedOrderId) eventBus.emit(events.ORDER_FUNDED, { orderId: fundedOrderId });
    return result;
  } catch (error) {
    try {
      await recordWebhookProcessingError(webhookInboxId);
    } catch (recordError) {
      recordError.cause = error;
      throw recordError;
    }
    throw error;
  }
}

/** FR-72: sweep due handovers and issue timeout refunds through the existing idempotent path. */
async function sweepUnhandedOverOrders({ limit = 100, timeBudgetMs = 20000, logger = console } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError('Handover sweep batch limit must be from 1 to 100.');
  }
  if (!Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0) {
    throw new ValidationError('Handover sweep time budget must be positive.');
  }
  const startedAt = performance.now();
  const orderIds = await orders.getDueHandoverOrderIds(limit);
  const counts = { processed: 0, skipped: 0, failed: 0 };
  for (let index = 0; index < orderIds.length; index += 1) {
    if (performance.now() - startedAt >= timeBudgetMs) {
      counts.skipped += orderIds.length - index;
      break;
    }
    try {
      const result = await refundUnhandedOverOrder({ orderId: orderIds[index] });
      if (result.outcome === 'refunded') counts.processed += 1;
      else counts.skipped += 1;
    } catch {
      counts.failed += 1;
    }
  }
  logger.info('Handover timeout sweep completed', counts);
  return counts;
}

async function reenqueueOrphanRefund(refundContext) {
  return db.withTransaction(async (client) => {
    const locked = await lockRefundPaymentOrder(
      client,
      refundContext.order_id,
      refundContext.payment_id,
      refundContext.id
    );
    if (!locked) return false;
    const maxAttempts = getRefundMaxAutoAttempts();
    const { rows } = await client.query(
      `SELECT id
       FROM refunds
       WHERE id = $1 AND (
         (trigger <> 'manual_admin' AND status = 'requested'
           AND requested_at <= now() - INTERVAL '2 minutes')
         OR (trigger = 'manual_admin' AND status = 'approved'
           AND approved_at <= now() - INTERVAL '2 minutes')
         OR (status = 'pending' AND updated_at <= now() - INTERVAL '10 minutes')
         OR (status = 'failed'
             AND attempt_count < $2
             AND COALESCE(last_attempt_at, updated_at) <= now() - INTERVAL '10 minutes')
       )`,
      [refundContext.id, maxAttempts]
    );
    if (!rows[0]) return false;
    await enqueueRefundJob(client, refundContext.id);
    return true;
  });
}

async function reenqueueOrphanWebhook(webhookInboxId) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT provider, provider_event_id, received_at, status
       FROM webhook_inbox
       WHERE id = $1`,
      [webhookInboxId]
    );
    const inbox = rows[0];
    if (!inbox || inbox.status !== 'received') return false;
    const { rows: dueRows } = await client.query(
      `SELECT id
       FROM webhook_inbox
       WHERE id = $1 AND received_at <= now() - INTERVAL '2 minutes'`,
      [webhookInboxId]
    );
    if (!dueRows[0]) return false;
    const key = `${inbox.provider}:${inbox.provider_event_id}`;
    await queue.enqueue(queue.QUEUES.PAYMENT_WEBHOOKS, { webhookInboxId }, {
      idempotencyKey: key,
      orderingKey: webhookInboxId,
      transaction: client,
    });
    return true;
  });
}

async function reconcilePendingPayment(paymentContext, gateway) {
  const result = await gateway.fetchPayment({
    providerPaymentRef: paymentContext.provider_payment_id,
  });
  if (!result || !['succeeded', 'failed', 'pending'].includes(result.status)) {
    throw new PaymentGatewayUnavailableError();
  }
  if (result.status === 'pending') return false;

  const outcome = result.status;
  const event = {
    type: `payment.${outcome}`,
    eventId: `reconcile:${paymentContext.id}:${outcome}`,
    providerPaymentRef: paymentContext.provider_payment_id,
    amount: String(paymentContext.amount),
    currency: paymentContext.currency,
  };
  const rawBody = Buffer.from(JSON.stringify(event));
  return receivePaymentWebhook({
    provider: paymentContext.provider,
    event: {
      eventId: event.eventId,
      type: event.type,
      providerPaymentRef: event.providerPaymentRef,
    },
    rawBody,
    signatureMetadata: { reconciled: true, source: 'gateway_lookup' },
    timestampMetadata: { reconciled: true },
    verifiedAt: new Date(),
  });
}

/** FR-70: requeue orphan money work and recover missed gateway outcomes via the normal inbox path. */
async function reconcileMoneyState({ limit = 100, timeBudgetMs = 20000, logger = console, gateway } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError('Money reconciliation batch limit must be from 1 to 100.');
  }
  if (!Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0) {
    throw new ValidationError('Money reconciliation time budget must be positive.');
  }

  const startedAt = performance.now();
  const counts = { processed: 0, skipped: 0, failed: 0 };
  const processBatch = async (rows, handler) => {
    for (let index = 0; index < rows.length; index += 1) {
      if (performance.now() - startedAt >= timeBudgetMs) {
        counts.skipped += rows.length - index;
        return false;
      }
      try {
        if (await handler(rows[index])) counts.processed += 1;
        else counts.skipped += 1;
      } catch {
        counts.failed += 1;
      }
    }
    return true;
  };

  const maxAttempts = getRefundMaxAutoAttempts();
  const { rows: refundRows } = await db.read(
    `SELECT id, order_id, payment_id
     FROM refunds
     WHERE (trigger <> 'manual_admin' AND status = 'requested'
              AND requested_at <= now() - INTERVAL '2 minutes')
        OR (trigger = 'manual_admin' AND status = 'approved'
              AND approved_at <= now() - INTERVAL '2 minutes')
        OR (status = 'pending' AND updated_at <= now() - INTERVAL '10 minutes')
        OR (status = 'failed'
              AND attempt_count < $2
              AND COALESCE(last_attempt_at, updated_at) <= now() - INTERVAL '10 minutes')
     ORDER BY COALESCE(last_attempt_at, updated_at), id
     LIMIT $1`,
    [limit, maxAttempts]
  );
  let withinBudget = await processBatch(refundRows, reenqueueOrphanRefund);

  if (withinBudget) {
    const { rows: inboxRows } = await db.read(
      `SELECT id
       FROM webhook_inbox
       WHERE status = 'received' AND received_at <= now() - INTERVAL '2 minutes'
       ORDER BY received_at, id
       LIMIT $1`,
      [limit]
    );
    withinBudget = await processBatch(inboxRows, ({ id }) => reenqueueOrphanWebhook(id));
  }

  if (withinBudget) {
    const { rows: paymentRows } = await db.read(
      `SELECT id, provider, provider_payment_id, amount, currency
       FROM payments
       WHERE status = 'pending'
         AND provider_payment_id IS NOT NULL
         AND provider_created_at <= now() - INTERVAL '15 minutes'
       ORDER BY provider_created_at, id
       LIMIT $1`,
      [limit]
    );
    await processBatch(paymentRows, (payment) =>
      reconcilePendingPayment(payment, gateway || paymentGateway.getPaymentGateway()));
  }

  logger.info('Money reconciliation completed', counts);
  return counts;
}

/** FR-77b: store verified payment events and enqueue processing atomically in PostgreSQL. */
async function receiveVerifiedPaymentWebhook(receipt) {
  return receivePaymentWebhook(receipt);
}

listings.setSystemTakedownHandler(handleListingTakedown);

module.exports = {
  getAdminOrderPaymentAndRefunds,
  getRefundableBalance,
  listAdminManualRefunds,
  getAdminManualRefund,
  requestManualRefund,
  decideManualRefund,
  assertNoOpenManualRefund,
  notifyRefundStatusChanges,
  createOrReusePayment,
  getPaymentStatus,
  enqueueRefundJob,
  cancelReservationOrder,
  refundUnhandedOverOrder,
  lockPaymentAndRefundRowsForHandover,
  lockPaymentsForOrder,
  recordManualSellerPayout,
  recordCourierHandoverAuditEvent,
  recordOrderDeliveredAuditEvent,
  recordOrderExceptionResolvedAuditEvent,
  recordDisputeResolutionAuditEvent,
  isCapturedPaymentFullyRefunded,
  sweepUnhandedOverOrders,
  reconcileMoneyState,
  processRefundJob,
  listFailedRefundsNeedingAttention,
  retryFailedRefund,
  receiveVerifiedPaymentWebhook,
  processPaymentWebhookJob,
};
