const db = require('../db.service');
const {
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} = require('../lib/errors');
const events = require('../lib/events');
const eventBus = require('../lib/eventBus');
const orders = require('./orders.service');
const listings = require('./listings.service');
const users = require('./users.service');
const reservations = require('./reservations.service');
const escrowPayments = require('./escrowPayments.service');
const moneyAudit = require('./moneyAudit.service');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_METHODS = ['bank', 'easypaisa', 'jazzcash'];

function assertUuid(id, name = 'id') {
  if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
    throw new ValidationError(`${name} must be a valid UUID.`);
  }
}

function validatePaidOn(paidOn) {
  if (typeof paidOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) {
    throw new ValidationError('paidOn must be a valid date in YYYY-MM-DD format.');
  }
  const [year, month, day] = paidOn.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new ValidationError('paidOn must be a valid calendar date.');
  }
  return paidOn;
}

function formatPayoutRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    sellerId: row.seller_id,
    attempt: row.attempt,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    initiatedBy: row.initiated_by,
    initiatedAt: row.initiated_at,
    method: row.method || null,
    transferReference: row.transfer_reference || null,
    paidOn: row.paid_on ? (row.paid_on instanceof Date ? row.paid_on.toISOString().slice(0, 10) : String(row.paid_on).slice(0, 10)) : null,
    paidBy: row.paid_by || null,
    paidAt: row.paid_at || null,
    failureReason: row.failure_reason || null,
    failedBy: row.failed_by || null,
    failedAt: row.failed_at || null,
  };
}

async function lockOrderAndPayoutContext(client, payoutId) {
  const { rows: initialPayoutRows } = await client.query(
    'SELECT id, order_id, seller_id, attempt, status, amount::text, currency FROM seller_payouts WHERE id = $1',
    [payoutId]
  );
  const initialPayout = initialPayoutRows[0];
  if (!initialPayout) throw new NotFoundError('seller_payout', payoutId);

  const context = await orders.getMoneyLockContext(client, initialPayout.order_id);
  if (!context) throw new NotFoundError('order', initialPayout.order_id);
  if (!context.reservation_id) throw new NotFoundError('reservation-backed order', initialPayout.order_id);

  if (!(await listings.lockListingForMoneyAction(client, context.listing_id))) {
    throw new ConflictError('The order listing is no longer available.');
  }
  if (!(await users.lockBuyerForMoneyAction(client, context.buyer_id))) {
    throw new ConflictError('The order buyer is no longer available.');
  }
  const order = await orders.lockReservationOrderForPayout(client, initialPayout.order_id);
  if (!order) throw new ConflictError('The order changed before recording payout.');

  const reservation = await reservations.lockReservationForPayout(client, order.reservation_id);
  if (!reservation) throw new ConflictError('The order reservation changed.');

  const paymentRows = await escrowPayments.lockPaymentsForOrder(client, initialPayout.order_id);
  const payment = paymentRows.find((p) => p.status === 'succeeded');
  if (!payment) throw new ConflictError('Order must have a succeeded payment.');

  const { rows: payoutRows } = await client.query(
    'SELECT * FROM seller_payouts WHERE id = $1 FOR UPDATE',
    [payoutId]
  );
  const payout = payoutRows[0];
  if (!payout) throw new NotFoundError('seller_payout', payoutId);

  return { order, reservation, payment, payout };
}

/** FR-48: insert attempt 1 as initiated payout for an order. */
async function createInitiatedPayout(client, { orderId, sellerId, amount, currency, initiatedBy }) {
  if (!amount || Number(amount) <= 0) return null;
  const { rows } = await client.query(
    `INSERT INTO seller_payouts
       (order_id, seller_id, attempt, status, amount, currency, initiated_by)
     VALUES ($1, $2, 1, 'initiated', $3::numeric, $4, $5)
     RETURNING id, order_id, seller_id, attempt, status, amount::text, currency,
               initiated_by, initiated_at`,
    [orderId, sellerId, amount, currency, initiatedBy]
  );
  return rows[0];
}

/** FR-48, FR-49: record an initiated payout as paid with transfer details and cash ledger entry. */
async function markPaid(payoutId, adminId, sessionId, input) {
  assertUuid(payoutId, 'payoutId');
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Request body must be an object.');
  }
  const { method, transferReference, paidOn, note, stepUpGrant } = input;
  if (!method || typeof method !== 'string' || !VALID_METHODS.includes(method)) {
    throw new ValidationError('method must be one of bank, easypaisa, or jazzcash.');
  }
  if (!transferReference || typeof transferReference !== 'string') {
    throw new ValidationError('transferReference is required.');
  }
  const trimmedRef = transferReference.trim();
  if (trimmedRef.length < 3 || trimmedRef.length > 100) {
    throw new ValidationError('transferReference must be 3 to 100 characters.');
  }

  validatePaidOn(paidOn);

  let trimmedNote = null;
  if (note !== undefined && note !== null) {
    if (typeof note !== 'string') throw new ValidationError('note must be a string.');
    trimmedNote = note.trim();
    if (trimmedNote.length > 300) throw new ValidationError('note cannot exceed 300 characters.');
  }

  if (!stepUpGrant || typeof stepUpGrant !== 'string') {
    throw new ForbiddenError('A valid step-up grant is required.');
  }

  const result = await db.withTransaction(async (client) => {
    const { rows: dateCheck } = await client.query(
      `SELECT ($1::date > CURRENT_DATE) AS is_future,
              ($1::date < CURRENT_DATE - INTERVAL '90 days') AS is_too_old`,
      [paidOn]
    );
    if (dateCheck[0].is_future) {
      throw new ValidationError('paidOn cannot be in the future.');
    }
    if (dateCheck[0].is_too_old) {
      throw new ValidationError('paidOn cannot be older than 90 days.');
    }

    const { payout, payment } = await lockOrderAndPayoutContext(client, payoutId);
    if (payout.status !== 'initiated') {
      throw new ConflictError('Payout is not in initiated status.');
    }

    await users.consumeStepUpGrantWithClient(client, adminId, sessionId, 'payout.record', stepUpGrant);

    const { rows: updatedRows } = await client.query(
      `UPDATE seller_payouts
       SET status = 'paid',
           method = $1,
           transfer_reference = $2,
           paid_on = $3::date,
           paid_by = $4,
           paid_at = now()
       WHERE id = $5 AND status = 'initiated'
       RETURNING id, order_id, seller_id, attempt, status, amount::text, currency,
                 initiated_by, initiated_at, method, transfer_reference,
                 paid_on, paid_by, paid_at`,
      [method, trimmedRef, paidOn, adminId, payoutId]
    );
    if (!updatedRows[0]) throw new ConflictError('Payout status changed.');

    await escrowPayments.recordPaidSellerPayoutLedgerEntry(client, {
      orderId: payout.order_id,
      paymentId: payment.id,
      currency: payout.currency,
      amount: payout.amount,
    });

    await moneyAudit.recordMoneyAuditEvent(client, {
      actorId: adminId,
      action: 'seller_payout_paid',
      orderId: payout.order_id,
      paymentId: payment.id,
      reason: trimmedNote,
      metadata: {
        payoutId,
        attempt: payout.attempt,
        amount: payout.amount,
        currency: payout.currency,
        method,
        transferReference: trimmedRef,
        paidOn,
        note: trimmedNote,
      },
    });

    return updatedRows[0];
  });

  eventBus.emit(events.PAYOUT_PAID, {
    payoutId: result.id,
    orderId: result.order_id,
    sellerId: result.seller_id,
    amount: result.amount,
    currency: result.currency,
    method: result.method,
    transferReference: result.transfer_reference,
    paidOn: result.paid_on,
  });

  return formatPayoutRow(result);
}

/** FR-48: record an initiated payout as failed without writing a ledger entry. */
async function markFailed(payoutId, adminId, sessionId, input) {
  assertUuid(payoutId, 'payoutId');
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Request body must be an object.');
  }
  const { reason, stepUpGrant } = input;
  if (!reason || typeof reason !== 'string') {
    throw new ValidationError('reason is required.');
  }
  const trimmedReason = reason.trim();
  if (trimmedReason.length < 3 || trimmedReason.length > 300) {
    throw new ValidationError('reason must be 3 to 300 characters.');
  }
  if (!stepUpGrant || typeof stepUpGrant !== 'string') {
    throw new ForbiddenError('A valid step-up grant is required.');
  }

  const result = await db.withTransaction(async (client) => {
    const { payout, payment } = await lockOrderAndPayoutContext(client, payoutId);
    if (payout.status !== 'initiated') {
      throw new ConflictError('Payout is not in initiated status.');
    }

    await users.consumeStepUpGrantWithClient(client, adminId, sessionId, 'payout.record', stepUpGrant);

    const { rows: updatedRows } = await client.query(
      `UPDATE seller_payouts
       SET status = 'failed',
           failure_reason = $1,
           failed_by = $2,
           failed_at = now()
       WHERE id = $3 AND status = 'initiated'
       RETURNING id, order_id, seller_id, attempt, status, amount::text, currency,
                 initiated_by, initiated_at, failure_reason, failed_by, failed_at`,
      [trimmedReason, adminId, payoutId]
    );
    if (!updatedRows[0]) throw new ConflictError('Payout status changed.');

    await moneyAudit.recordMoneyAuditEvent(client, {
      actorId: adminId,
      action: 'seller_payout_failed',
      orderId: payout.order_id,
      paymentId: payment.id,
      reason: trimmedReason,
      metadata: {
        payoutId,
        attempt: payout.attempt,
        reason: trimmedReason,
      },
    });

    return updatedRows[0];
  });

  eventBus.emit(events.PAYOUT_FAILED, {
    payoutId: result.id,
    orderId: result.order_id,
    sellerId: result.seller_id,
    amount: result.amount,
    currency: result.currency,
  });

  return formatPayoutRow(result);
}

/** FR-48: retry a failed payout creating attempt + 1 as initiated. */
async function retryPayout(payoutId, adminId, sessionId, input) {
  assertUuid(payoutId, 'payoutId');
  const stepUpGrant = input?.stepUpGrant;
  if (!stepUpGrant || typeof stepUpGrant !== 'string') {
    throw new ForbiddenError('A valid step-up grant is required.');
  }

  const result = await db.withTransaction(async (client) => {
    const { payout, payment } = await lockOrderAndPayoutContext(client, payoutId);
    if (payout.status !== 'failed') {
      throw new ConflictError('Only a failed payout can be retried.');
    }

    const { rows: activeSiblings } = await client.query(
      `SELECT id, status FROM seller_payouts
       WHERE order_id = $1 AND status IN ('initiated', 'paid')`,
      [payout.order_id]
    );
    if (activeSiblings.length > 0) {
      throw new ConflictError('An active or paid payout already exists for this order.');
    }

    const { rows: maxRows } = await client.query(
      'SELECT COALESCE(MAX(attempt), 0) AS max_attempt FROM seller_payouts WHERE order_id = $1',
      [payout.order_id]
    );
    const nextAttempt = Number(maxRows[0].max_attempt) + 1;

    await users.consumeStepUpGrantWithClient(client, adminId, sessionId, 'payout.record', stepUpGrant);

    const { rows: newPayoutRows } = await client.query(
      `INSERT INTO seller_payouts
         (order_id, seller_id, attempt, status, amount, currency, initiated_by)
       VALUES ($1, $2, $3, 'initiated', $4::numeric, $5, $6)
       RETURNING id, order_id, seller_id, attempt, status, amount::text, currency,
                 initiated_by, initiated_at`,
      [payout.order_id, payout.seller_id, nextAttempt, payout.amount, payout.currency, adminId]
    );

    await moneyAudit.recordMoneyAuditEvent(client, {
      actorId: adminId,
      action: 'seller_payout_retried',
      orderId: payout.order_id,
      paymentId: payment.id,
      metadata: {
        previousPayoutId: payoutId,
        newPayoutId: newPayoutRows[0].id,
        attempt: nextAttempt,
      },
    });

    return newPayoutRows[0];
  });

  return formatPayoutRow(result);
}

/** FR-48: list seller payouts with optional status filter and limit. */
async function listSellerPayouts(query = {}) {
  let statusFilter = null;
  if (query.status !== undefined && query.status !== null && query.status !== '') {
    if (!['initiated', 'paid', 'failed'].includes(query.status)) {
      throw new ValidationError('status must be initiated, paid, or failed.');
    }
    statusFilter = query.status;
  }
  let limit = 20;
  if (query.limit !== undefined && query.limit !== null && query.limit !== '') {
    const parsedLimit = Number(query.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      throw new ValidationError('limit must be a positive integer.');
    }
    limit = Math.min(parsedLimit, 100);
  }

  const values = [];
  let sql = `
    SELECT id, order_id, seller_id, attempt, status,
           amount::text, currency, initiated_by,
           initiated_at, method, transfer_reference,
           paid_on, paid_by, paid_at,
           failure_reason, failed_by, failed_at
    FROM seller_payouts
  `;
  if (statusFilter) {
    values.push(statusFilter);
    sql += ` WHERE status = $${values.length}`;
  }
  values.push(limit);
  sql += ` ORDER BY initiated_at DESC, id DESC LIMIT $${values.length}`;

  const { rows } = await db.query(sql, values);
  return { payouts: rows.map(formatPayoutRow) };
}

/** FR-48: get single seller payout details without sensitive seller account information. */
async function getSellerPayout(payoutId) {
  assertUuid(payoutId, 'payoutId');
  const { rows } = await db.query(
    `SELECT id, order_id, seller_id, attempt, status,
            amount::text, currency, initiated_by,
            initiated_at, method, transfer_reference,
            paid_on, paid_by, paid_at,
            failure_reason, failed_by, failed_at
     FROM seller_payouts
     WHERE id = $1`,
    [payoutId]
  );
  if (!rows[0]) throw new NotFoundError('seller_payout', payoutId);
  return formatPayoutRow(rows[0]);
}

module.exports = {
  createInitiatedPayout,
  markPaid,
  markFailed,
  retryPayout,
  listSellerPayouts,
  getSellerPayout,
};
