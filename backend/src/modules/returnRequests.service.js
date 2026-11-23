/**
 * FR-43, FR-45, FR-56: buyer returns and Admin decisions.
 * Tables owned: return_requests
 */

const db = require('../db.service');
const { randomUUID } = require('node:crypto');
const orders = require('./orders.service');
const listings = require('./listings.service');
const reservations = require('./reservations.service');
const users = require('./users.service');
const payout = require('./payout.service');
const sellerPayouts = require('./sellerPayouts.service');
const escrowPayments = require('./escrowPayments.service');
const moneyAudit = require('./moneyAudit.service');
const disputes = require('./disputes.service');
const eventBus = require('../lib/eventBus');
const events = require('../lib/events');
const { NotFoundError, ValidationError, ConflictError, ForbiddenError } = require('../lib/errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPEN_STATUSES = ['requested', 'seller_responded'];

function validateText(value, field, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new ValidationError(`${field} must be ${min} to ${max} characters.`);
  }
  return value.trim();
}

function decisionOutcome(status) {
  if (status === 'approved') return 'approve_refund';
  if (status === 'rejected') return 'reject';
  return null;
}

/** FR-43: compute the return complaint window against the Asia/Karachi business date. */
async function isWithinReturnComplaintWindow(client, deliveredAt, complaintWindowDays) {
  if (!deliveredAt) return false;
  const businessDate = await sellerPayouts.getBusinessDate(client);
  const { rows } = await client.query(
    `SELECT (
       ($1::timestamptz AT TIME ZONE 'Asia/Karachi')::date + $2::integer
     ) >= $3::date AS in_window`,
    [deliveredAt, complaintWindowDays, businessDate]
  );
  return Boolean(rows[0]?.in_window);
}

async function lockReturnOrder(client, orderId) {
  const context = await orders.getMoneyLockContext(client, orderId);
  if (!context) throw new NotFoundError('order', orderId);
  if (!context.reservation_id) {
    throw new ConflictError('Returns are available for captured reservation orders only.');
  }
  if (!(await listings.lockListingForMoneyAction(client, context.listing_id))) {
    throw new ConflictError('The order listing is no longer available.');
  }
  if (!(await users.lockBuyerForMoneyAction(client, context.buyer_id))) {
    throw new ConflictError('The order buyer is no longer available.');
  }
  const order = await orders.lockReservationOrderForPayout(client, orderId);
  if (!order || order.listing_id !== context.listing_id ||
      order.buyer_id !== context.buyer_id || order.reservation_id !== context.reservation_id) {
    throw new ConflictError('The order changed before the return action.');
  }
  const reservation = await reservations.lockReservationForPayout(client, context.reservation_id);
  if (!reservation || reservation.listing_id !== order.listing_id || reservation.status !== 'paid') {
    throw new ConflictError('The order does not have a captured reservation.');
  }
  return { context, order };
}

/** FR-43: a buyer may request a return for a delivered order inside its payout hold complaint window. */
async function fileReturnRequest(orderId, buyerId, input, {
  hasOpenDispute,
} = {}) {
  const reason = validateText(input?.reason, 'reason', 3, 500);
  if (typeof hasOpenDispute !== 'function') {
    throw new TypeError('The dispute-state owner is required to file a return request.');
  }
  const returnRequest = await db.withTransaction(async (client) => {
    const { context, order } = await lockReturnOrder(client, orderId);
    if (context.buyer_id !== buyerId) {
      throw new ForbiddenError('Only the order buyer may request a return.');
    }
    if (!order.delivered_at) {
      throw new ConflictError('A return can only be requested for a delivered order.');
    }
    if (await hasOpenDispute(client, orderId)) {
      throw new ConflictError('An open dispute already exists for this order.');
    }
    const hold = await payout.getReservationOrderHold(client, orderId);
    if (!(await isWithinReturnComplaintWindow(client, order.delivered_at, hold.complaint_window_days))) {
      throw new ConflictError('The return complaint window has closed.');
    }
    const { rows: openRows } = await client.query(
      `SELECT id
       FROM return_requests
       WHERE order_id = $1 AND status = ANY($2::text[])
       LIMIT 1
       FOR UPDATE`,
      [orderId, OPEN_STATUSES]
    );
    if (openRows[0]) {
      throw new ConflictError('An open return request already exists for this order.');
    }
    const { rows } = await client.query(
      `INSERT INTO return_requests (id, order_id, buyer_id, reason)
       VALUES ($1, $2, $3, $4)
       RETURNING id, order_id, buyer_id, reason, status, created_at`,
      [randomUUID(), orderId, buyerId, reason]
    );
    const created = rows[0];
    await payout.pausePayoutHoldForIssue(client, orderId);
    await eventBus.emitAsync(events.RETURN_REQUESTED, {
      returnId: created.id,
      orderId,
    }, { transaction: client });
    return {
      returnId: created.id,
      orderId: created.order_id,
      reason: created.reason,
      status: created.status,
      createdAt: created.created_at,
    };
  });
  return returnRequest;
}

/** FR-43: the seller may add one response note to an open return request. */
async function respondToReturnRequest(returnId, sellerId, input) {
  if (typeof returnId !== 'string' || !UUID.test(returnId)) {
    throw new ValidationError('returnId must be a UUID.');
  }
  const sellerNote = validateText(input?.sellerNote, 'sellerNote', 3, 300);
  return db.withTransaction(async (client) => {
    const { rows: initialRows } = await client.query(
      'SELECT order_id FROM return_requests WHERE id = $1',
      [returnId]
    );
    if (!initialRows[0]) throw new NotFoundError('return request', returnId);
    const { order } = await lockReturnOrder(client, initialRows[0].order_id);
    if (order.seller_id !== sellerId) {
      throw new ForbiddenError('Only the order seller may respond to this return request.');
    }
    const { rows } = await client.query(
      `UPDATE return_requests
       SET seller_note = $2, status = 'seller_responded',
           responded_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'requested'
       RETURNING id, order_id, status, seller_note, responded_at`,
      [returnId, sellerNote]
    );
    if (!rows[0]) {
      throw new ConflictError('The seller may respond only once while the return request is open.');
    }
    await eventBus.emitAsync(events.RETURN_SELLER_RESPONDED, {
      returnId,
      orderId: rows[0].order_id,
    }, { transaction: client });
    return {
      returnId,
      orderId: rows[0].order_id,
      status: rows[0].status,
      sellerNote: rows[0].seller_note,
      respondedAt: rows[0].responded_at,
    };
  });
}

/** FR-43, FR-45, FR-56: decide a return, refund and settle its payout hold atomically. */
async function decideReturnRequest(returnId, adminId, sessionId, input, {
  hasOpenDispute,
  hasOpenOtherPayoutIssue,
  failInitiatedPayout,
} = {}) {
  if (typeof returnId !== 'string' || !UUID.test(returnId)) {
    throw new ValidationError('returnId must be a UUID.');
  }
  const decision = input?.decision;
  if (!['approve_refund', 'reject'].includes(decision)) {
    throw new ValidationError('decision must be approve_refund or reject.');
  }
  const decisionNote = validateText(input?.decisionNote, 'decisionNote', 3, 300);
  if (input.sellerAtFault !== undefined && typeof input.sellerAtFault !== 'boolean') {
    throw new ValidationError('sellerAtFault must be a boolean.');
  }
  const sellerAtFault = decision === 'approve_refund' && input.sellerAtFault === true;
  if (typeof hasOpenDispute !== 'function' ||
      typeof hasOpenOtherPayoutIssue !== 'function' ||
      typeof failInitiatedPayout !== 'function') {
    throw new TypeError('Return decision payout and dispute owners are required.');
  }

  return db.withTransaction(async (client) => {
    const { rows: initialRows } = await client.query(
      'SELECT order_id FROM return_requests WHERE id = $1',
      [returnId]
    );
    if (!initialRows[0]) throw new NotFoundError('return request', returnId);
    const orderId = initialRows[0].order_id;
    await lockReturnOrder(client, orderId);
    const { rows: requestRows } = await client.query(
      `SELECT id, order_id, buyer_id, reason, status, seller_note
       FROM return_requests
       WHERE id = $1
       FOR UPDATE`,
      [returnId]
    );
    const request = requestRows[0];
    if (!request) throw new NotFoundError('return request', returnId);
    if (!OPEN_STATUSES.includes(request.status)) {
      throw new ConflictError('This return request has already been decided.');
    }
    if (await hasOpenDispute(client, orderId)) {
      throw new ConflictError('An open dispute blocks this return decision.');
    }

    await users.consumeStepUpGrantWithClient(
      client,
      adminId,
      sessionId,
      'refund.decide',
      input.stepUpGrant
    );

    let refund = null;
    let payoutResult = { failedPayoutIds: [], paidPayoutIds: [] };
    if (decision === 'approve_refund') {
      payoutResult = await failInitiatedPayout(client, {
        orderId,
        adminId,
        returnRequestId: returnId,
      });
      refund = await escrowPayments.createReturnRefund(client, {
        orderId,
        returnRequestId: returnId,
        actorId: adminId,
        reason: decisionNote,
        sellerAtFault,
      });
    }

    const { rows: updatedRows } = await client.query(
      `UPDATE return_requests
       SET status = $2, decided_by = $3, decision_note = $4,
           seller_at_fault = $5, refund_id = $6, decided_at = now(),
           updated_at = now()
       WHERE id = $1 AND status = ANY($7::text[])
       RETURNING id, order_id, status, decided_at`,
      [
        returnId,
        decision === 'approve_refund' ? 'approved' : 'rejected',
        adminId,
        decisionNote,
        sellerAtFault,
        refund?.refundId ?? null,
        OPEN_STATUSES,
      ]
    );
    if (!updatedRows[0]) throw new ConflictError('This return request has already been decided.');

    const keepPaused = await hasOpenOtherPayoutIssue(client, orderId);
    await payout.clearPayoutHoldForIssue(client, orderId, { keepPaused });
    await moneyAudit.recordMoneyAuditEvent(client, {
      actorId: adminId,
      action: 'return_decided',
      orderId,
      refundId: refund?.refundId || null,
      approvedBy: adminId,
      reason: decisionNote,
      metadata: {
        returnRequestId: returnId,
        decision,
        sellerAtFault,
        refundAmount: refund?.amount ?? null,
        refundAfterPayout: refund?.refundAfterPayout ?? false,
        failedPayoutIds: payoutResult.failedPayoutIds,
      },
    });
    if (decision === 'approve_refund' &&
        (payoutResult.paidPayoutIds.length > 0 || refund?.refundAfterPayout)) {
      await moneyAudit.recordMoneyAuditEvent(client, {
        actorId: adminId,
        action: 'return_after_payout',
        orderId,
        refundId: refund.refundId,
        approvedBy: adminId,
        reason: decisionNote,
        metadata: {
          returnRequestId: returnId,
          amount: refund.amount,
          paidPayoutIds: payoutResult.paidPayoutIds,
        },
      });
    }
    await eventBus.emitAsync(events.RETURN_DECIDED, {
      returnId,
      orderId,
      status: updatedRows[0].status,
    }, { transaction: client });
    return {
      returnId,
      orderId,
      status: updatedRows[0].status,
      outcome: decision,
      decidedAt: updatedRows[0].decided_at,
      refund: refund ? {
        refundId: refund.refundId,
        amount: refund.amount,
        itemAmount: refund.itemAmount,
        deliveryFeeAmount: refund.deliveryFeeAmount,
        sellerAtFault: refund.sellerAtFault,
      } : null,
      payoutAfterPayment: payoutResult.paidPayoutIds.length > 0 || Boolean(refund?.refundAfterPayout),
      payoutHoldRetained: keepPaused,
    };
  });
}

/** FR-43, FR-56: expose only return status and outcome to buyer/seller order reads. */
async function getOrderReturnStatus(orderId) {
  const { rows } = await db.read(
    `SELECT status, decided_at
     FROM return_requests
     WHERE order_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [orderId]
  );
  const row = rows[0];
  return row ? {
    status: row.status,
    outcome: decisionOutcome(row.status),
    decidedAt: row.decided_at,
  } : null;
}

/** FR-43: report whether the buyer may request a return for an order summary. */
async function getReturnFilingStatus(orderId) {
  if (typeof orderId !== 'string' || !UUID.test(orderId)) {
    throw new ValidationError('orderId must be a UUID.');
  }
  return db.withTransaction(async (client) => {
    const { rows: orderRows } = await client.query(
      `SELECT delivered_at FROM orders WHERE id = $1`,
      [orderId]
    );
    if (!orderRows[0]?.delivered_at) return { canRequestReturn: false };

    let hold;
    try {
      hold = await payout.getReservationOrderHold(client, orderId);
    } catch (cause) {
      if (cause instanceof NotFoundError) return { canRequestReturn: false };
      throw cause;
    }
    if (await disputes.hasOpenDisputeInTransaction(client, orderId)) {
      return { canRequestReturn: false };
    }
    if (await hasOpenReturnRequest(client, orderId)) {
      return { canRequestReturn: false };
    }
    const canRequestReturn = await isWithinReturnComplaintWindow(
      client,
      orderRows[0].delivered_at,
      hold.complaint_window_days
    );
    return { canRequestReturn };
  });
}

/** FR-43, FR-56: batch safe return status fields for buyer and seller order reads. */
async function getOrderReturnStatuses(orderIds) {
  if (!Array.isArray(orderIds)) throw new ValidationError('orderIds must be an array.');
  if (orderIds.length === 0) return [];
  const { rows } = await db.read(
    `SELECT DISTINCT ON (order_id) order_id, status, decided_at
     FROM return_requests
     WHERE order_id = ANY($1::uuid[])
     ORDER BY order_id, created_at DESC, id DESC`,
    [orderIds]
  );
  return rows.map((row) => ({
    orderId: row.order_id,
    status: row.status,
    outcome: decisionOutcome(row.status),
    decidedAt: row.decided_at,
  }));
}

/** FR-43, FR-56: expose the latest full return record to owner-scoped order reads. */
async function getOrderReturnRequests(orderIds) {
  if (!Array.isArray(orderIds)) throw new ValidationError('orderIds must be an array.');
  if (orderIds.length === 0) return [];
  const { rows } = await db.read(
    `SELECT DISTINCT ON (order_id)
            id, order_id, reason, status, seller_note, responded_at, decided_at, created_at
     FROM return_requests
     WHERE order_id = ANY($1::uuid[])
     ORDER BY order_id, created_at DESC, id DESC`,
    [orderIds]
  );
  return rows.map((row) => ({
    orderId: row.order_id,
    returnRequest: {
      id: row.id,
      status: row.status,
      outcome: decisionOutcome(row.status),
      reason: row.reason,
      sellerNote: row.seller_note ?? null,
      createdAt: row.created_at,
      respondedAt: row.responded_at ?? null,
      decidedAt: row.decided_at ?? null,
    },
  }));
}

/** FR-43, FR-56: expose one latest return record for a single owner-scoped order read. */
async function getOrderReturnRequest(orderId) {
  if (typeof orderId !== 'string' || !UUID.test(orderId)) {
    throw new ValidationError('orderId must be a UUID.');
  }
  const rows = await getOrderReturnRequests([orderId]);
  return rows[0]?.returnRequest ?? null;
}

/** FR-43, FR-56: report whether an order has an open return request in a caller transaction. */
async function hasOpenReturnRequest(client, orderId) {
  const { rows } = await client.query(
    `SELECT 1 FROM return_requests
     WHERE order_id = $1 AND status = ANY($2::text[])
     LIMIT 1`,
    [orderId, OPEN_STATUSES]
  );
  return rows.length > 0;
}

/** FR-43, FR-56: return Admin-visible return records without using the Admin facade as a table owner. */
async function listAdminReturnRequests(query = {}) {
  const rawLimit = query.limit === undefined ? '50' : query.limit;
  if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit) ||
      !Number.isSafeInteger(Number(rawLimit)) || Number(rawLimit) < 1) {
    throw new ValidationError('limit must be a positive integer.');
  }
  const limit = Math.min(Number(rawLimit), 100);
  const status = query.status === undefined ? null : query.status;
  if (status !== null &&
      !['requested', 'seller_responded', 'approved', 'rejected'].includes(status)) {
    throw new ValidationError('status is not a return-request status.');
  }
  const { rows } = await db.read(
    `SELECT id AS "returnId", order_id AS "orderId", buyer_id AS "buyerId",
            reason, status, seller_note AS "sellerNote",
            decided_by AS "decidedBy", decision_note AS "decisionNote",
            seller_at_fault AS "sellerAtFault", refund_id AS "refundId",
            responded_at AS "respondedAt", decided_at AS "decidedAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM return_requests
     WHERE ($1::text IS NULL OR status = $1)
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [status, limit]
  );
  return { returnRequests: rows };
}

/** FR-43, FR-56: return one full return record for Admin review. */
async function getAdminReturnRequest(returnId) {
  if (typeof returnId !== 'string' || !UUID.test(returnId)) {
    throw new ValidationError('returnId must be a UUID.');
  }
  const { rows } = await db.read(
    `SELECT id AS "returnId", order_id AS "orderId", buyer_id AS "buyerId",
            reason, status, seller_note AS "sellerNote",
            decided_by AS "decidedBy", decision_note AS "decisionNote",
            seller_at_fault AS "sellerAtFault", refund_id AS "refundId",
            responded_at AS "respondedAt", decided_at AS "decidedAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM return_requests
     WHERE id = $1`,
    [returnId]
  );
  if (!rows[0]) throw new NotFoundError('return request', returnId);
  return rows[0];
}

module.exports = {
  fileReturnRequest,
  respondToReturnRequest,
  decideReturnRequest,
  getOrderReturnStatus,
  getReturnFilingStatus,
  getOrderReturnStatuses,
  getOrderReturnRequests,
  getOrderReturnRequest,
  hasOpenReturnRequest,
  listAdminReturnRequests,
  getAdminReturnRequest,
};
