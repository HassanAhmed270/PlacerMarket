/**
 * Owns: FR-60a hosted checkout intents and FR-61 database-only payment status.
 * Tables owned: payments
 */

const db = require('../db.service');
const paymentGateway = require('../lib/adapters/paymentGateway');
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

module.exports = { createOrReusePayment, getPaymentStatus };
