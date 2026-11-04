/**
 * Owns: FR-60a hosted checkout intents, FR-61 funding, FR-69 refunds, and FR-77b webhooks.
 * Tables owned: payments, webhook_inbox, refunds, ledger_entries, money_audit_events
 */

const db = require('../db.service');
const { performance } = require('node:perf_hooks');
const queue = require('../lib/queue');
const paymentGateway = require('../lib/adapters/paymentGateway');
const orders = require('./orders.service');
const reservations = require('./reservations.service');
const listings = require('./listings.service');
const users = require('./users.service');
const {
  ConflictError,
  NotFoundError,
  ValidationError,
} = require('../lib/errors');
const {
  PaymentGatewayConfigurationError,
  PaymentGatewayUnavailableError,
  buildPaymentReturnUrl,
} = paymentGateway;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WEBHOOK_AMOUNT = /^\d{1,10}(?:\.\d{1,2})?$/;
const SUPPORTED_PAYMENT_EVENTS = new Set(['payment.succeeded', 'payment.failed']);

/** FR-69: enqueue one refund job in the caller's transaction for system and manual refund creators. */
async function enqueueRefundJob(transaction, refundId) {
  if (typeof refundId !== 'string' || !UUID.test(refundId)) {
    throw new ValidationError('refundId must be a UUID.');
  }
  if (!transaction) throw new TypeError('Refund jobs must be enqueued in the refund transaction.');
  queue.asQueueDatabase(transaction);
  const key = `refund:${refundId}`;
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
    await client.query(
      `INSERT INTO money_audit_events
         (actor_id, action, order_id, payment_id, refund_id, reason, metadata)
       VALUES (NULL, $1, $2, $3, $4, $5, $6::jsonb)`,
      [
        isLateCapture ? 'late_payment_refund_requested' : 'system_refund_requested',
        order.id,
        payment.id,
        refund.id,
        auditReason,
        JSON.stringify(isLateCapture ? { trigger } : { trigger, cause }),
      ]
    );
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
  await client.query(
    `INSERT INTO money_audit_events
       (actor_id, action, order_id, payment_id, reason, metadata)
     VALUES (NULL, 'payment_webhook_manual_review', $1, $2, $3, $4::jsonb)`,
    [
      payment?.order_id || null,
      payment?.id || null,
      code,
      JSON.stringify({ errorCode: code, eventType: inbox.event_type }),
    ]
  );
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
  if (!order || order.listing_id !== context.listing_id || order.buyer_id !== context.buyer_id) return null;

  const { rows: paymentRows } = await client.query(
    `SELECT id, order_id, provider_payment_id, amount
     FROM payments
     WHERE id = $1
     FOR UPDATE`,
    [paymentId]
  );
  const payment = paymentRows[0];
  if (!payment || payment.order_id !== order.id) return null;

  const { rows: refundRows } = await client.query(
    `SELECT id, order_id, payment_id, amount, currency, status, idempotency_key,
            trigger, reason
     FROM refunds
     WHERE id = $1
     FOR UPDATE`,
    [refundId]
  );
  const refund = refundRows[0];
  if (!refund || refund.order_id !== order.id || refund.payment_id !== payment.id) return null;
  return { order, payment, refund };
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
    if (!['requested', 'pending', 'failed'].includes(refund.status)) {
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
  } catch {
    await db.withTransaction(async (client) => {
      const locked = await lockRefundPaymentOrder(
        client,
        refundIntent.orderId,
        refundIntent.paymentId,
        refundId
      );
      if (!locked) return;
      await client.query(
        `UPDATE refunds
         SET status = 'failed', updated_at = now()
         WHERE id = $1 AND status = 'pending'`,
        [refundId]
      );
    });
    throw new PaymentGatewayUnavailableError();
  }

  return db.withTransaction(async (client) => {
    const locked = await lockRefundPaymentOrder(
      client,
      refundIntent.orderId,
      refundIntent.paymentId,
      refundId
    );
    if (!locked) return { outcome: 'missing' };
    const { order, payment, refund } = locked;
    if (!['requested', 'pending', 'failed'].includes(refund.status)) {
      return { outcome: 'skipped', status: refund.status };
    }

    const { rowCount } = await client.query(
      `UPDATE refunds
       SET status = 'succeeded', provider_refund_id = $2,
           completed_at = COALESCE(completed_at, now()), updated_at = now()
       WHERE id = $1 AND status IN ('requested', 'pending', 'failed')`,
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
    await client.query(
      `INSERT INTO money_audit_events
         (actor_id, action, order_id, payment_id, refund_id, reason, metadata)
       VALUES (NULL, 'system_refund_succeeded', $1, $2, $3, $4, $5::jsonb)`,
      [
        order.id,
        payment.id,
        refund.id,
        refund.reason,
        JSON.stringify({
          trigger: refund.trigger,
          providerRefundRef: gatewayResult.providerRefundRef,
        }),
      ]
    );

    const { rows: totalRows } = await client.query(
      `SELECT COALESCE(SUM(amount), 0) = $2::numeric AS fully_refunded
       FROM refunds
       WHERE payment_id = $1 AND status = 'succeeded'`,
      [payment.id, payment.amount]
    );
    if (totalRows[0].fully_refunded) {
      await client.query(
        `UPDATE payments
         SET status = 'refunded', updated_at = now()
         WHERE id = $1 AND status <> 'refunded'`,
        [payment.id]
      );
    }
    return { outcome: 'succeeded', refundId };
  });
}

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

  return db.withTransactionRetry(async (client) => {
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
    return true;
  }

  if (reservation.status === 'paid' && order.handed_over_at !== null) {
    await client.query(
      `INSERT INTO money_audit_events (actor_id, action, order_id, reason, metadata)
       VALUES (NULL, 'takedown_after_handover', $1, 'Listing taken down after courier handover', $2::jsonb)`,
      [order.id, JSON.stringify({ listingId })]
    );
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
  return true;
}

/** FR-72: cancel and fully refund a paid order after its database handover deadline. */
async function refundUnhandedOverOrder({ orderId }) {
  validateOrderId(orderId);
  return db.withTransactionRetry(async (client) => {
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

  try {
    return await db.withTransaction(async (client) => {
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
        await client.query(
          `INSERT INTO money_audit_events
             (actor_id, action, order_id, payment_id, reason, metadata)
           VALUES (NULL, 'payment_funded', $1, $2, 'verified_webhook', $3::jsonb)`,
          [order.id, payment.id, JSON.stringify({ eventType: event.type })]
        );
      }

      return recordWebhookProcessed(client, inbox);
    });
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
    const { rows } = await client.query(
      `SELECT id
       FROM refunds
       WHERE id = $1 AND (
         (status = 'requested' AND requested_at <= now() - INTERVAL '2 minutes')
         OR (status IN ('pending', 'failed') AND updated_at <= now() - INTERVAL '10 minutes')
       )`,
      [refundContext.id]
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

  const { rows: refundRows } = await db.read(
    `SELECT id, order_id, payment_id
     FROM refunds
     WHERE (status = 'requested' AND requested_at <= now() - INTERVAL '2 minutes')
        OR (status IN ('pending', 'failed') AND updated_at <= now() - INTERVAL '10 minutes')
     ORDER BY requested_at, id
     LIMIT $1`,
    [limit]
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
  createOrReusePayment,
  getPaymentStatus,
  enqueueRefundJob,
  cancelReservationOrder,
  refundUnhandedOverOrder,
  sweepUnhandedOverOrders,
  reconcileMoneyState,
  processRefundJob,
  receiveVerifiedPaymentWebhook,
  processPaymentWebhookJob,
};
