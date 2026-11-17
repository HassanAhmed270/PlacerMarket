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
const disputes = require('./disputes.service');
const listings = require('./listings.service');
const users = require('./users.service');
const reservations = require('./reservations.service');
const escrowPayments = require('./escrowPayments.service');
const moneyAudit = require('./moneyAudit.service');
const settlement = require('./settlement.service');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_METHODS = ['bank', 'easypaisa', 'jazzcash'];
const PAYOUT_APPROVAL_THRESHOLD_SETTING = 'payout_two_admin_threshold';
const NUMERIC_SETTING_PATTERN = '^[+]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$';
const MAX_PAYOUT_EXPORT_ROWS = 5000;
const PAYOUT_EXPORT_COLUMNS = [
  ['payoutId', 'id'],
  ['orderId', 'order_id'],
  ['sellerId', 'seller_id'],
  ['attempt', 'attempt'],
  ['status', 'status'],
  ['amount', 'amount'],
  ['currency', 'currency'],
  ['method', 'method'],
  ['transferReference', 'transfer_reference'],
  ['initiatedAt', 'initiated_at'],
  ['paidOn', 'paid_on'],
  ['paidAt', 'paid_at'],
];

async function getApprovalRequirement(client, amount) {
  let threshold;
  try {
    const settings = await settlement.getSettingsForTransaction(client, [PAYOUT_APPROVAL_THRESHOLD_SETTING]);
    threshold = settings[PAYOUT_APPROVAL_THRESHOLD_SETTING];
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    return { valid: false, required: false };
  }

  const { rows } = await client.query(
    `SELECT CASE
       WHEN $1::text ~ $3 THEN
         CASE WHEN $1::numeric > 0 THEN $2::numeric > $1::numeric ELSE NULL END
       ELSE NULL
     END AS requires_approval`,
    [threshold, amount, NUMERIC_SETTING_PATTERN]
  );
  const required = rows[0].requires_approval;
  return { valid: required !== null, required: required === true };
}

async function getPayoutApprovalThreshold() {
  try {
    return await settlement.getSetting(PAYOUT_APPROVAL_THRESHOLD_SETTING);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    return null;
  }
}

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

/** FR-48: format PostgreSQL DATE values without shifting their local calendar date. */
function dateOnly(value) {
  if (value instanceof Date) {
    const year = String(value.getFullYear()).padStart(4, '0');
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  if (typeof value === 'string') return value.slice(0, 10);
  return null;
}

function validateExportDate(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError(`${name} must be a valid date in YYYY-MM-DD format.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ValidationError(`${name} must be a valid calendar date.`);
  }
  return value;
}

/** FR-48: escape one cell for the Admin payout CSV and prevent formula injection. */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let cell = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  if (/[,"\r\n]/.test(cell)) cell = `"${cell.replace(/"/g, '""')}"`;
  return cell;
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
    paidOn: dateOnly(row.paid_on),
    paidBy: row.paid_by || null,
    paidAt: row.paid_at || null,
    approvedBy: row.approved_by || null,
    approvedAt: row.approved_at || null,
    failureReason: row.failure_reason || null,
    failedBy: row.failed_by || null,
    failedAt: row.failed_at || null,
    ...(Object.hasOwn(row, 'requires_approval') ? { requiresApproval: row.requires_approval } : {}),
    disputeHold: row.dispute_hold === true,
  };
}

async function assertNoDisputeHold(client, orderId, guards) {
  if (!guards || typeof guards.hasPausedDisputeHold !== 'function' ||
      typeof guards.hasOpenDispute !== 'function' ||
      typeof guards.hasOpenDisputeRefund !== 'function') {
    throw new TypeError('Payout hold and dispute owners are required to record a payout.');
  }
  if (!(await orders.lockReservationOrderForPayout(client, orderId))) {
    throw new NotFoundError('order', orderId);
  }
  const hasPausedHold = await guards.hasPausedDisputeHold(client, orderId);
  const hasOpenDispute = await guards.hasOpenDispute(client, orderId);
  if (hasPausedHold || hasOpenDispute) {
    throw new ConflictError('Payout is paused while an unresolved dispute hold exists.');
  }
  if (await guards.hasOpenDisputeRefund(client, orderId)) {
    throw new ConflictError('Payout is blocked while the dispute refund is unresolved.');
  }
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
async function createInitiatedPayout(
  client,
  { orderId, sellerId, amount, currency, initiatedBy },
  guards
) {
  if (amount === null || amount === undefined || amount === '') return null;
  if (typeof amount !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(amount)) {
    throw new ValidationError('Payout amount must be a non-negative decimal string with at most two decimal places.');
  }
  const [whole, fraction = ''] = amount.split('.');
  if (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) === 0n) return null;
  await assertNoDisputeHold(client, orderId, guards);
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

/** FR-69: return an order's active or paid payout state inside the caller transaction. */
async function getOrderPayoutStatus(client, orderId) {
  const { rows } = await client.query(
    `SELECT status
     FROM seller_payouts
     WHERE order_id = $1
     ORDER BY attempt DESC
     LIMIT 1`,
    [orderId]
  );
  return rows[0]?.status || null;
}

/** FR-45, FR-69: fail initiated payouts in the caller's buyer-favor dispute transaction. */
async function failInitiatedPayoutForDispute(client, { orderId, disputeId, adminId }) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('Dispute payout failure requires the resolution transaction.');
  }
  const { rows: payouts } = await client.query(
    `SELECT id, attempt
     FROM seller_payouts
     WHERE order_id = $1 AND status = 'initiated'
     ORDER BY attempt DESC
     FOR UPDATE`,
    [orderId]
  );
  const failedPayoutIds = [];
  for (const payout of payouts) {
    const { rows } = await client.query(
      `UPDATE seller_payouts
       SET status = 'failed',
           failure_reason = 'dispute_decision',
           failed_by = $1,
           failed_at = now()
       WHERE id = $2 AND status = 'initiated'
       RETURNING id`,
      [adminId, payout.id]
    );
    if (!rows[0]) throw new ConflictError('Payout status changed before dispute decision.');
    await moneyAudit.recordMoneyAuditEvent(client, {
      actorId: adminId,
      action: 'seller_payout_failed_by_dispute',
      orderId,
      reason: 'dispute_decision',
      metadata: {
        payoutId: rows[0].id,
        disputeId,
      },
    });
    failedPayoutIds.push(rows[0].id);
  }
  return failedPayoutIds;
}

/** FR-48, FR-49: record an initiated payout as paid with transfer details and cash ledger entry. */
async function markPaid(payoutId, adminId, sessionId, input, guards) {
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
    await assertNoDisputeHold(client, payout.order_id, guards);

    const approvalRequirement = await getApprovalRequirement(client, payout.amount);
    if (!approvalRequirement.valid) {
      throw new ConflictError('Payout approval threshold is invalid.');
    }
    if (approvalRequirement.required && !payout.approved_by) {
      throw new ConflictError('Approval required.');
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
                 paid_on, paid_by, paid_at, approved_by, approved_at`,
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
    paidOn: dateOnly(result.paid_on),
  });

  return formatPayoutRow(result);
}

/** FR-48: require a different Admin to approve payouts strictly above the configured threshold. */
async function approvePayout(payoutId, adminId, sessionId, input, guards) {
  assertUuid(payoutId, 'payoutId');
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Request body must be an object.');
  }
  const { stepUpGrant } = input;
  if (!stepUpGrant || typeof stepUpGrant !== 'string') {
    throw new ForbiddenError('A valid step-up grant is required.');
  }

  const result = await db.withTransaction(async (client) => {
    const { payout, payment } = await lockOrderAndPayoutContext(client, payoutId);
    if (payout.status !== 'initiated') {
      throw new ConflictError('Payout is not in initiated status.');
    }
    await assertNoDisputeHold(client, payout.order_id, guards);
    if (payout.approved_by) {
      throw new ConflictError('Payout has already been approved.');
    }
    if (adminId === payout.initiated_by) {
      throw new ForbiddenError('The Admin who initiated a payout cannot approve it.');
    }

    const approvalRequirement = await getApprovalRequirement(client, payout.amount);
    if (!approvalRequirement.valid) {
      throw new ConflictError('Payout approval threshold is invalid.');
    }
    if (!approvalRequirement.required) {
      throw new ConflictError('Approval not required.');
    }

    await users.consumeStepUpGrantWithClient(client, adminId, sessionId, 'payout.approve', stepUpGrant);

    const { rows: updatedRows } = await client.query(
      `UPDATE seller_payouts
       SET approved_by = $1, approved_at = now()
       WHERE id = $2 AND status = 'initiated' AND approved_by IS NULL
       RETURNING id, order_id, seller_id, attempt, status, amount::text, currency,
                 initiated_by, initiated_at, approved_by, approved_at`,
      [adminId, payoutId]
    );
    if (!updatedRows[0]) throw new ConflictError('Payout approval status changed.');

    await moneyAudit.recordMoneyAuditEvent(client, {
      actorId: adminId,
      action: 'seller_payout_approved',
      orderId: payout.order_id,
      paymentId: payment.id,
      metadata: {
        payoutId,
        attempt: payout.attempt,
        amount: payout.amount,
        currency: payout.currency,
      },
    });

    return updatedRows[0];
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
async function retryPayout(payoutId, adminId, sessionId, input, guards) {
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
    await assertNoDisputeHold(client, payout.order_id, guards);

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

/** FR-49: return the latest payout snapshot for each seller order in a single lookup. */
async function getSellerOrderPayoutSummaries(orderIds) {
  if (!Array.isArray(orderIds)) {
    throw new ValidationError('orderIds must be an array of UUIDs.');
  }
  if (orderIds.length === 0) return [];
  if (orderIds.length > 50) {
    throw new ValidationError('orderIds must contain at most 50 UUIDs.');
  }
  for (const orderId of orderIds) {
    if (typeof orderId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
      throw new ValidationError('Each orderId must be a valid UUID.');
    }
  }

  const { rows } = await db.read(
    `SELECT DISTINCT ON (order_id)
        order_id, status, amount::text AS amount, currency,
        method, transfer_reference AS transfer_reference, paid_on
     FROM seller_payouts
     WHERE order_id = ANY($1::uuid[])
     ORDER BY order_id, attempt DESC, initiated_at DESC, id DESC`,
    [orderIds]
  );

  return rows.map((row) => ({
    orderId: row.order_id,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    method: row.status === 'paid' ? row.method : null,
    transferReference: row.status === 'paid' ? row.transfer_reference : null,
    paidOn: row.status === 'paid' ? dateOnly(row.paid_on) : null,
  }));
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

  const threshold = await getPayoutApprovalThreshold();
  const values = [threshold];
  let sql = `
    SELECT id, order_id, seller_id, attempt, status,
           amount::text, currency, initiated_by,
           initiated_at, method, transfer_reference,
           paid_on, paid_by, paid_at,
           failure_reason, failed_by, failed_at,
           CASE
             WHEN $1::text IS NULL THEN true
             WHEN $1::text ~ '${NUMERIC_SETTING_PATTERN}' THEN
               CASE WHEN $1::numeric > 0 THEN amount::numeric > $1::numeric ELSE true END
             ELSE true
           END AS requires_approval,
           (
             EXISTS (
               SELECT 1 FROM payout_holds hold
               WHERE hold.order_id = seller_payouts.order_id
                 AND hold.state = 'paused_for_dispute'
             )
             OR EXISTS (
               SELECT 1 FROM disputes dispute
               WHERE dispute.order_id = seller_payouts.order_id
                 AND dispute.status IN ('open', 'seller_responded')
             )
           ) AS dispute_hold
    FROM seller_payouts
  `;
  if (statusFilter) {
    values.push(statusFilter);
    sql += ` WHERE status = $${values.length}`;
  }
  values.push(limit);
  sql += ` ORDER BY initiated_at DESC, id DESC LIMIT $${values.length}`;

  // cross-module read: payout_holds (owned by payout.service.js), disputes (owned by disputes.service.js); batched Admin list view.
  const { rows } = await db.query(sql, values);
  return { payouts: rows.map(formatPayoutRow) };
}

/** FR-48, FR-69: get payout details and dispute-hold status without seller account data. */
async function getSellerPayout(payoutId, getDisputeHoldStatus) {
  assertUuid(payoutId, 'payoutId');
  if (typeof getDisputeHoldStatus !== 'function') {
    throw new TypeError('The payout hold owner is required to read dispute status.');
  }
  const threshold = await getPayoutApprovalThreshold();
  const { rows } = await db.query(
    `SELECT id, order_id, seller_id, attempt, status,
            amount::text, currency, initiated_by,
            initiated_at, method, transfer_reference,
            paid_on, paid_by, paid_at,
            failure_reason, failed_by, failed_at,
            CASE
              WHEN $2::text IS NULL THEN true
              WHEN $2::text ~ '${NUMERIC_SETTING_PATTERN}' THEN
                CASE WHEN $2::numeric > 0 THEN amount::numeric > $2::numeric ELSE true END
              ELSE true
            END AS requires_approval
     FROM seller_payouts
     WHERE id = $1`,
    [payoutId, threshold]
  );
  if (!rows[0]) throw new NotFoundError('seller_payout', payoutId);
  return formatPayoutRow({
    ...rows[0],
    dispute_hold: await getDisputeHoldStatus(rows[0].order_id),
  });
}

/** FR-48: export a capped, step-up-protected payout CSV without account details. */
async function exportSellerPayoutsCsv(adminId, sessionId, filters) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new ValidationError('Export filters must be an object.');
  }
  const { status, from, to, stepUpGrant } = filters;
  let statusFilter = null;
  if (status !== undefined && status !== null && status !== '') {
    if (!['initiated', 'paid', 'failed'].includes(status)) {
      throw new ValidationError('status must be initiated, paid, or failed.');
    }
    statusFilter = status;
  }

  const fromFilter = from === undefined || from === null || from === ''
    ? null
    : validateExportDate(from, 'from');
  const toFilter = to === undefined || to === null || to === ''
    ? null
    : validateExportDate(to, 'to');
  if (fromFilter && toFilter && fromFilter > toFilter) {
    throw new ValidationError('from must be on or before to.');
  }
  if (!stepUpGrant || typeof stepUpGrant !== 'string') {
    throw new ForbiddenError('A valid step-up grant is required.');
  }

  const values = [];
  const conditions = [];
  if (statusFilter) {
    values.push(statusFilter);
    conditions.push(`status = $${values.length}`);
  }
  if (fromFilter) {
    values.push(fromFilter);
    conditions.push(`initiated_at >= ($${values.length}::date::timestamp AT TIME ZONE 'UTC')`);
  }
  if (toFilter) {
    values.push(toFilter);
    conditions.push(`initiated_at < (($${values.length}::date + INTERVAL '1 day') AT TIME ZONE 'UTC')`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  return db.withTransaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*) AS row_count FROM seller_payouts ${whereClause}`,
      values
    );
    const rowCount = Number(countRows[0].row_count);
    if (rowCount > MAX_PAYOUT_EXPORT_ROWS) {
      throw new ValidationError('Payout export exceeds 5000 rows; use a narrower date range or filters.');
    }

    await users.consumeStepUpGrantWithClient(client, adminId, sessionId, 'payout.export', stepUpGrant);

    const { rows } = await client.query(
      `SELECT id, order_id, seller_id, attempt, status, amount::text, currency,
              method, transfer_reference, initiated_at, paid_on, paid_at
       FROM seller_payouts
       ${whereClause}
       ORDER BY initiated_at, id`,
      values
    );
    const csvRows = [
      PAYOUT_EXPORT_COLUMNS.map(([header]) => header).join(','),
      ...rows.map((row) => PAYOUT_EXPORT_COLUMNS.map(([, column]) => {
        const value = row[column];
        const formattedValue = column === 'paid_on' ? dateOnly(value) : value;
        return csvCell(formattedValue);
      }).join(',')),
    ];

    await moneyAudit.recordMoneyAuditEvent(client, {
      actorId: adminId,
      action: 'seller_payout_exported',
      metadata: {
        status: statusFilter,
        from: fromFilter,
        to: toFilter,
        rowCount,
      },
    });

    return csvRows.join('\r\n');
  });
}

module.exports = {
  createInitiatedPayout,
  getOrderPayoutStatus,
  failInitiatedPayoutForDispute,
  getSellerOrderPayoutSummaries,
  markPaid,
  approvePayout,
  markFailed,
  retryPayout,
  listSellerPayouts,
  getSellerPayout,
  exportSellerPayoutsCsv,
  csvCell,
  dateOnly,
  MAX_PAYOUT_EXPORT_ROWS,
};
