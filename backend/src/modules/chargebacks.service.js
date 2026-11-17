/**
 * FR-57, FR-58: Admin-recorded chargebacks and resolutions.
 * Tables owned: chargebacks
 */

const db = require('../db.service');
const { randomUUID } = require('node:crypto');
const escrowPayments = require('./escrowPayments.service');
const payout = require('./payout.service');
const moneyAudit = require('./moneyAudit.service');
const users = require('./users.service');
const { NotFoundError, ValidationError, ConflictError } = require('../lib/errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPEN_RETURN_STATUSES = ['requested', 'seller_responded'];

function validateUuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new ValidationError(`${field} must be a UUID.`);
  }
}

function validateText(value, field, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new ValidationError(`${field} must be ${min} to ${max} characters.`);
  }
  return value.trim();
}

function validateBody(input, allowedFields) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !allowedFields.includes(key))) {
    throw new ValidationError('Request body contains unsupported fields.');
  }
}

/** FR-57, FR-58: keep the shared payout hold while any return, dispute, or chargeback is open. */
async function hasOpenPayoutIssue(client, orderId) {
  // cross-module read: disputes (owned by disputes.service.js), return_requests (owned by returnRequests.service.js).
  const { rows } = await client.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM disputes
         WHERE order_id = $1 AND status IN ('open', 'seller_responded')
       ) OR EXISTS (
         SELECT 1 FROM return_requests
         WHERE order_id = $1 AND status = ANY($2::text[])
       ) OR EXISTS (
         SELECT 1 FROM chargebacks
         WHERE order_id = $1 AND status = 'open'
       ) AS has_open_issue`,
    [orderId, OPEN_RETURN_STATUSES]
  );
  return rows[0]?.has_open_issue === true;
}

/** FR-57, FR-58: record a captured chargeback and its refund under one transaction. */
async function recordChargeback(orderId, adminId, sessionId, input, {
  failInitiatedPayout,
} = {}) {
  validateUuid(orderId, 'orderId');
  validateBody(input, ['amount', 'reference', 'note', 'stepUpGrant']);
  const amount = input.amount;
  const reference = validateText(input.reference, 'reference', 3, 100);
  const note = validateText(input.note, 'note', 3, 300);
  if (typeof failInitiatedPayout !== 'function') {
    throw new TypeError('Chargeback payout owner is required.');
  }

  return db.withTransaction(async (client) => {
    await escrowPayments.lockManualRefundContext(client, orderId);
    const { rows: duplicateRows } = await client.query(
      'SELECT id FROM chargebacks WHERE order_id = $1 AND reference = $2 LIMIT 1',
      [orderId, reference]
    );
    if (duplicateRows[0]) {
      throw new ConflictError('A chargeback with this reference already exists for the order.');
    }

    await users.consumeStepUpGrantWithClient(
      client,
      adminId,
      sessionId,
      'refund.decide',
      input.stepUpGrant
    );
    const chargebackId = randomUUID();
    const refund = await escrowPayments.createChargebackRefund(client, {
      orderId,
      chargebackId,
      actorId: adminId,
      amount,
      reason: note,
    });
    await payout.pausePayoutHoldForIssue(client, orderId);
    const payoutResult = await failInitiatedPayout(client, {
      orderId,
      adminId,
      chargebackId,
    });
    const payoutAfterPayment = payoutResult.paidPayoutIds.length > 0;
    const { rows: recordedRows } = await client.query(
      `INSERT INTO chargebacks
         (id, order_id, amount, currency, reference, note, recorded_by, status,
          refund_id, payout_after_payment)
       VALUES ($1, $2, $3::numeric, $4, $5, $6, $7, 'open', $8, $9)
       RETURNING created_at`,
      [
        chargebackId,
        orderId,
        refund.amount,
        refund.currency,
        reference,
        note,
        adminId,
        refund.refundId,
        payoutAfterPayment,
      ]
    );
    await moneyAudit.recordMoneyAuditEvent(client, {
      actorId: adminId,
      action: 'chargeback_recorded',
      orderId,
      refundId: refund.refundId,
      approvedBy: adminId,
      reason: note,
      metadata: {
        chargebackId,
        amount: refund.amount,
        currency: refund.currency,
        reference,
        itemAmount: refund.itemAmount,
        deliveryFeeAmount: refund.deliveryFeeAmount,
        failedPayoutIds: payoutResult.failedPayoutIds,
      },
    });
    if (payoutAfterPayment) {
      await moneyAudit.recordMoneyAuditEvent(client, {
        actorId: adminId,
        action: 'chargeback_after_payout',
        orderId,
        refundId: refund.refundId,
        approvedBy: adminId,
        reason: note,
        metadata: {
          chargebackId,
          amount: refund.amount,
          paidPayoutIds: payoutResult.paidPayoutIds,
        },
      });
    }
    return {
      chargebackId,
      orderId,
      amount: refund.amount,
      currency: refund.currency,
      reference,
      note,
      status: 'open',
      recordedBy: adminId,
      refundId: refund.refundId,
      refund: {
        status: 'approved',
        amount: refund.amount,
        itemAmount: refund.itemAmount,
        deliveryFeeAmount: refund.deliveryFeeAmount,
        sellerAtFault: false,
      },
      payoutAfterPayment,
      failedPayoutIds: payoutResult.failedPayoutIds,
      createdAt: recordedRows[0].created_at,
    };
  });
}

/** FR-57, FR-58: resolve one chargeback and clear the shared hold only when no issue remains. */
async function resolveChargeback(chargebackId, adminId, sessionId, input) {
  validateUuid(chargebackId, 'chargebackId');
  validateBody(input, ['outcome', 'resolutionNote', 'stepUpGrant']);
  if (!['won', 'lost'].includes(input.outcome)) {
    throw new ValidationError('outcome must be won or lost.');
  }
  const resolutionNote = validateText(input.resolutionNote, 'resolutionNote', 3, 300);
  const { rows: initialRows } = await db.read(
    'SELECT order_id FROM chargebacks WHERE id = $1',
    [chargebackId]
  );
  if (!initialRows[0]) throw new NotFoundError('chargeback', chargebackId);
  const orderId = initialRows[0].order_id;

  return db.withTransaction(async (client) => {
    await escrowPayments.lockManualRefundContext(client, orderId);
    const { rows: chargebackRows } = await client.query(
      `SELECT id, order_id, amount::text AS amount, currency, status,
              recorded_by, refund_id
       FROM chargebacks
       WHERE id = $1
       FOR UPDATE`,
      [chargebackId]
    );
    const chargeback = chargebackRows[0];
    if (!chargeback) throw new NotFoundError('chargeback', chargebackId);
    if (chargeback.status !== 'open') {
      throw new ConflictError('This chargeback has already been resolved.');
    }
    const { rows: refundRows } = await client.query(
      `SELECT id, status
       FROM refunds
       WHERE id = $1 AND order_id = $2 AND trigger = 'chargeback'
       FOR UPDATE`,
      [chargeback.refund_id, orderId]
    );
    const refund = refundRows[0];
    if (!refund) throw new ConflictError('The chargeback refund record is unavailable.');

    await users.consumeStepUpGrantWithClient(
      client,
      adminId,
      sessionId,
      'refund.decide',
      input.stepUpGrant
    );

    let refundStatus = refund.status;
    const refundExecuted = refund.status === 'succeeded';
    if (input.outcome === 'won' && !refundExecuted && refund.status !== 'voided') {
      const { rows: voidedRows } = await client.query(
        `UPDATE refunds
         SET status = 'voided', updated_at = now()
         WHERE id = $1 AND status <> 'succeeded'
         RETURNING status`,
        [refund.id]
      );
      refundStatus = voidedRows[0]?.status || refund.status;
    }
    const { rows: resolvedRows } = await client.query(
      `UPDATE chargebacks
       SET status = $2, resolved_by = $3, resolution_note = $4,
           resolved_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'open'
       RETURNING resolved_at`,
      [chargebackId, input.outcome, adminId, resolutionNote]
    );
    if (!resolvedRows[0]) {
      throw new ConflictError('This chargeback has already been resolved.');
    }

    const holdRetained = await hasOpenPayoutIssue(client, orderId);
    await payout.clearPayoutHoldForIssue(client, orderId, { keepPaused: holdRetained });
    await moneyAudit.recordMoneyAuditEvent(client, {
      actorId: adminId,
      action: 'chargeback_resolved',
      orderId,
      refundId: refund.id,
      approvedBy: adminId,
      reason: resolutionNote,
      metadata: {
        chargebackId,
        outcome: input.outcome,
        refundStatus,
        payoutHoldRetained: holdRetained,
      },
    });
    if (input.outcome === 'won' && refundExecuted) {
      await moneyAudit.recordMoneyAuditEvent(client, {
        actorId: adminId,
        action: 'chargeback_won_after_refund',
        orderId,
        refundId: refund.id,
        approvedBy: adminId,
        reason: resolutionNote,
        metadata: { chargebackId },
      });
    }
    return {
      chargebackId,
      orderId,
      status: input.outcome,
      outcome: input.outcome,
      resolvedBy: adminId,
      resolvedAt: resolvedRows[0].resolved_at,
      resolutionNote,
      refundId: refund.id,
      refundStatus,
      refundAfterChargebackWin: input.outcome === 'won' && refundExecuted,
      payoutHoldRetained: holdRetained,
    };
  });
}

function validateListQuery(query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new ValidationError('Chargeback list query must be an object.');
  }
  const rawLimit = query.limit === undefined ? '50' : query.limit;
  if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit) ||
      !Number.isSafeInteger(Number(rawLimit)) || Number(rawLimit) < 1) {
    throw new ValidationError('limit must be a positive integer.');
  }
  const status = query.status === undefined ? null : query.status;
  if (status !== null && !['open', 'won', 'lost'].includes(status)) {
    throw new ValidationError('status must be open, won, or lost.');
  }
  return { limit: Math.min(Number(rawLimit), 100), status };
}

/** FR-57, FR-58: expose complete chargeback records to Admins. */
async function listAdminChargebacks(query = {}) {
  const { limit, status } = validateListQuery(query);
  const { rows } = await db.read(
    `SELECT id AS "chargebackId", order_id AS "orderId",
            amount::text AS amount, currency, reference, note,
            recorded_by AS "recordedBy", status,
            resolved_by AS "resolvedBy", resolution_note AS "resolutionNote",
            refund_id AS "refundId", payout_after_payment AS "payoutAfterPayment",
            created_at AS "createdAt", updated_at AS "updatedAt",
            resolved_at AS "resolvedAt"
     FROM chargebacks
     WHERE ($1::text IS NULL OR status = $1)
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [status, limit]
  );
  return { chargebacks: rows };
}

/** FR-57, FR-58: expose one complete chargeback record to Admins. */
async function getAdminChargeback(chargebackId) {
  validateUuid(chargebackId, 'chargebackId');
  const { rows } = await db.read(
    `SELECT id AS "chargebackId", order_id AS "orderId",
            amount::text AS amount, currency, reference, note,
            recorded_by AS "recordedBy", status,
            resolved_by AS "resolvedBy", resolution_note AS "resolutionNote",
            refund_id AS "refundId", payout_after_payment AS "payoutAfterPayment",
            created_at AS "createdAt", updated_at AS "updatedAt",
            resolved_at AS "resolvedAt"
     FROM chargebacks
     WHERE id = $1`,
    [chargebackId]
  );
  if (!rows[0]) throw new NotFoundError('chargeback', chargebackId);
  return rows[0];
}

/** FR-57, FR-58: expose status and outcome only to buyer/seller order reads. */
async function getOrderChargebackStatuses(orderIds) {
  if (!Array.isArray(orderIds)) throw new ValidationError('orderIds must be an array.');
  if (!orderIds.length) return [];
  const { rows } = await db.read(
    `SELECT order_id, status
     FROM chargebacks
     WHERE order_id = ANY($1::uuid[])
     ORDER BY order_id, created_at DESC, id DESC`,
    [orderIds]
  );
  const statusesByOrderId = new Map();
  for (const row of rows) {
    if (!statusesByOrderId.has(row.order_id)) statusesByOrderId.set(row.order_id, []);
    statusesByOrderId.get(row.order_id).push({
      status: row.status,
      outcome: row.status === 'open' ? null : row.status,
    });
  }
  return Array.from(statusesByOrderId, ([orderId, chargebacks]) => ({ orderId, chargebacks }));
}

module.exports = {
  recordChargeback,
  resolveChargeback,
  hasOpenPayoutIssue,
  listAdminChargebacks,
  getAdminChargeback,
  getOrderChargebackStatuses,
};
