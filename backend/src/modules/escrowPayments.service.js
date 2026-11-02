/**
 * Owns: FR-60a hosted checkout intents, FR-61 funding, and FR-77b webhooks.
 * Tables owned: payments, webhook_inbox, refunds, ledger_entries, money_audit_events
 */

const db = require('../db.service');
const queue = require('../lib/queue');
const paymentGateway = require('../lib/adapters/paymentGateway');
const orders = require('./orders.service');
const reservations = require('./reservations.service');
const listings = require('./listings.service');
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
    const { rows: orderRows } = await client.query(
      `SELECT id, buyer_id, reservation_id, status
       FROM orders
       WHERE id = $1 AND buyer_id = $2
       FOR UPDATE`,
      [orderId, buyerId]
    );
    const order = orderRows[0];
    if (!order) throw new NotFoundError('order', orderId);
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
        const { rows: orderRows } = await client.query(
          `SELECT id, listing_id, reservation_id, status
           FROM orders
           WHERE id = $1
           FOR UPDATE`,
          [paymentLookup.order_id]
        );
        order = orderRows[0] || null;

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

      const isLate = !reservation ||
        ['expired', 'released', 'cancelled'].includes(reservation.status) ||
        (reservation.status === 'active' && !reservation.is_unexpired) ||
        order?.status === 'cancelled';
      if (!order || !reservation) {
        return recordWebhookFailure(client, inbox, payment, 'unmatched_payment');
      }
      if (!isLate &&
          (reservation.status !== 'active' || !reservation.is_unexpired ||
           order.status !== 'payment_pending')) {
        return recordWebhookProcessed(client, inbox);
      }

      await client.query(
        `UPDATE payments
         SET status = $2, succeeded_at = now(), provider_updated_at = now(),
             provider_payment_id = COALESCE(provider_payment_id, $3),
             provider_reference = COALESCE(provider_reference, $3),
             updated_at = now()
         WHERE id = $1`,
        [payment.id, isLate ? 'late' : 'succeeded', event.providerPaymentRef]
      );
      await client.query(
        `INSERT INTO ledger_entries
           (order_id, payment_id, currency, amount, entry_type, idempotency_key)
         VALUES ($1, $2, $3, $4::numeric, 'capture', $5)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [order.id, payment.id, payment.currency, payment.amount, `capture:${payment.id}`]
      );

      if (isLate) {
        if (reservation.status === 'active' && !reservation.is_unexpired) {
          const expired = await reservations.expireReservationForLatePayment(client, reservation.id);
          if (expired) {
            await orders.cancelUnpaidReservationOrder(client, order.id);
            await listings.syncAvailabilityProjection(client, order.listing_id);
          }
        }
        const { rows: refundRows } = await client.query(
          `INSERT INTO refunds
             (payment_id, order_id, trigger, amount, currency, status, idempotency_key, reason)
           VALUES ($1, $2, 'system_expiry', $3::numeric, $4, 'requested', $5, 'Late payment after reservation ended')
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
          [payment.id, order.id, payment.amount, payment.currency, `refund:${payment.id}:late`]
        );
        await client.query(
          `INSERT INTO money_audit_events
             (actor_id, action, order_id, payment_id, refund_id, reason, metadata)
           VALUES (NULL, 'late_payment_refund_requested', $1, $2, $3, 'late_payment', $4::jsonb)`,
          [
            order.id,
            payment.id,
            refundRows[0]?.id || null,
            JSON.stringify({ trigger: 'system_expiry' }),
          ]
        );
      } else if (reservation.status === 'active' && reservation.is_unexpired &&
                 order.status === 'payment_pending') {
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

/** FR-77b: store verified payment events and enqueue processing atomically in PostgreSQL. */
async function receiveVerifiedPaymentWebhook(receipt) {
  return receivePaymentWebhook(receipt);
}

module.exports = {
  createOrReusePayment,
  getPaymentStatus,
  receiveVerifiedPaymentWebhook,
  processPaymentWebhookJob,
};
