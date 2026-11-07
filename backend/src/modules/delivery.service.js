/**
 * modules/delivery.service.js
 *
 * Owns: FR-39 to FR-42 (specs.md section "8. Delivery")
 * Tables owned: delivery_partners, delivery_status_log, order_exceptions
 *
 * Correction vs. earlier discussion in this chat: cash-remittance
 * reconciliation (FR-41a) actually lives on `cod_collections`
 * (payments.service.js), not here — confirmed against schema.sql's actual
 * column placement rather than my earlier verbal guess. delivery_status_log
 * only tracks delivery status, not money.
 *
 * FR-40a (OPEN): delivery_partners.city_id is nullable specifically so this
 * works whether the business ends up with one partner or many, city-scoped
 * or not — do not add a NOT NULL constraint or a "must have a city" guard
 * here until that's decided.
 */

const db = require('../db.service');
const eventBus = require('../lib/eventBus');
const events = require('../lib/events');
const orders = require('./orders.service');
const reservations = require('./reservations.service');
const listings = require('./listings.service');
const users = require('./users.service');
const escrowPayments = require('./escrowPayments.service');
const payout = require('./payout.service');
const disputes = require('./disputes.service');
const {
  ConflictError, NotFoundError, ValidationError,
} = require('../lib/errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

eventBus.on(events.DISPUTE_REFUND_EXCEPTION_REQUIRED, async ({ orderId, resolvedBy }, context = {}) => {
  if (!context.transaction) {
    throw new TypeError('Dispute refund exceptions must be recorded in the resolution transaction.');
  }
  await context.transaction.query(
    `INSERT INTO order_exceptions
       (order_id, kind, courier_pickup_at, note, recorded_by)
     VALUES ($1, 'dispute_refund_required', NULL,
       'Dispute resolved in the buyer''s favour; refund must be made manually', $2)
     ON CONFLICT (order_id, kind) WHERE resolved_at IS NULL DO NOTHING`,
    [orderId, resolvedBy]
  );
});

/** FR-68: validate and cap Admin order-list query parameters before the database read. */
function validateAdminOrderListQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new ValidationError('Order list query must be an object.');
  }
  const rawLimit = query.limit === undefined ? '20' : query.limit;
  if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit) ||
      !Number.isSafeInteger(Number(rawLimit)) || Number(rawLimit) < 1) {
    throw new ValidationError('limit must be a positive integer.');
  }
  const status = query.status === undefined || query.status === '' ? null : query.status;
  if (status !== null && typeof status !== 'string') {
    throw new ValidationError('status must be a single order_status value.');
  }
  const before = query.before === undefined ? null : query.before;
  if (before !== null && (typeof before !== 'string' || !UUID.test(before))) {
    throw new ValidationError('before must be a reservation-backed order UUID.');
  }
  return {
    limit: Math.min(Number(rawLimit), 50),
    status,
    before,
  };
}

// ---- FR-40, FR-40a: delivery partner config ----

/** FR-40, FR-40a: create a delivery partner (must support cash collection; city optional). */
async function createDeliveryPartner({ name, supportsCashCollection = true, cityId = null }, adminId) {
  if (!supportsCashCollection) {
    // FR-40: cash collection support is a hard requirement, not optional.
    throw new ValidationError('Delivery partner must support cash collection at the door (FR-40)');
  }
  const { rows } = await db.query(
    `INSERT INTO delivery_partners (name, supports_cash_collection, city_id) VALUES ($1, $2, $3) RETURNING *`,
    [name, supportsCashCollection, cityId]
  );
  return rows[0];
}

/** FR-40: list delivery partners. */
async function listDeliveryPartners({ activeOnly = true } = {}) {
  const { rows } = await db.query(
    activeOnly ? 'SELECT * FROM delivery_partners WHERE is_active = true ORDER BY name'
               : 'SELECT * FROM delivery_partners ORDER BY name'
  );
  return rows;
}

/** FR-40, FR-57: activate/deactivate a delivery partner. */
async function setDeliveryPartnerActive(partnerId, isActive, adminId) {
  const { rows } = await db.query(
    'UPDATE delivery_partners SET is_active = $1 WHERE id = $2 RETURNING *',
    [isActive, partnerId]
  );
  if (!rows[0]) throw new NotFoundError('delivery_partner', partnerId);
  return rows[0];
}

// ---- FR-41: manual status updates ----

const STATUS_VALUES = Object.freeze(['assigned', 'picked_up', 'in_transit', 'delivered', 'delivery_failed']);

/** FR-41: MANUAL entry only for MVP — ops staff key this in, no courier API/webhook. */
async function logDeliveryStatus(orderId, { status, deliveryPartnerId, enteredBy, note }) {
  await orders.assertLegacyOrder(orderId);
  if (!STATUS_VALUES.includes(status)) {
    throw new ValidationError(`status must be one of: ${STATUS_VALUES.join(', ')}`);
  }
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO delivery_status_log (order_id, delivery_partner_id, status, entered_by, note)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [orderId, deliveryPartnerId || null, status, enteredBy, note || null]
    );
    await eventBus.emitAsync(events.DELIVERY_STATUS_CHANGED, { orderId, status }, { transaction: client });
    return rows[0];
  });
}

// ---- FR-42: tracking view ----

/** FR-42: delivery status history for the buyer, seller, or an Admin. */
async function getDeliveryTracking(orderId, viewerId, canViewAll = false) {
  if (typeof orderId !== 'string' || !UUID.test(orderId)) {
    throw new NotFoundError('order', orderId);
  }
  const parties = await orders.getDeliveryOrderParties(orderId);
  if (!parties || (!canViewAll && parties.buyer_id !== viewerId && parties.seller_id !== viewerId)) {
    throw new NotFoundError('order', orderId);
  }
  const { rows } = await db.query(
    `SELECT * FROM delivery_status_log WHERE order_id = $1 ORDER BY created_at ASC`,
    [orderId]
  );
  return rows;
}

function validateIsoTimestamp(value) {
  const match = typeof value === 'string' ? ISO_TIMESTAMP.exec(value) : null;
  if (!match) throw new ValidationError('courierPickupAt must be a valid ISO timestamp.');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText || 0);
  const offsetMinute = Number(offsetMinuteText || 0);
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
  ][month - 1];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth ||
      hour > 23 || minute > 59 || second > 59 ||
      offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0) ||
      !Number.isFinite(Date.parse(value))) {
    throw new ValidationError('courierPickupAt must be a valid ISO timestamp.');
  }
  return value;
}

function validateHandoverRequest(orderId, body, adminId) {
  if (typeof orderId !== 'string' || !UUID.test(orderId)) {
    throw new ValidationError('orderId must be a UUID.');
  }
  if (typeof adminId !== 'string' || !UUID.test(adminId)) {
    throw new ValidationError('adminId must be a UUID.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('A delivery update body is required.');
  }
  if (body.status !== 'handed_to_delivery') {
    throw new ValidationError('This delivery status is not supported yet.');
  }
  const allowedFields = new Set([
    'status', 'courierPickupAt', 'handoverConfirmationNote', 'trackingNumber',
  ]);
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    throw new ValidationError('The delivery update contains unsupported fields.');
  }
  if (typeof body.handoverConfirmationNote !== 'string') {
    throw new ValidationError('A handover confirmation note of 3 to 500 characters is required.');
  }
  const note = body.handoverConfirmationNote.trim();
  if (note.length < 3 || note.length > 500) {
    throw new ValidationError('A handover confirmation note of 3 to 500 characters is required.');
  }
  let trackingNumber = null;
  if (body.trackingNumber !== undefined) {
    if (typeof body.trackingNumber !== 'string') {
      throw new ValidationError('trackingNumber must be a string from 1 to 100 characters.');
    }
    trackingNumber = body.trackingNumber.trim();
    if (!trackingNumber || trackingNumber.length > 100) {
      throw new ValidationError('trackingNumber must be a string from 1 to 100 characters.');
    }
  }
  return {
    courierPickupAt: validateIsoTimestamp(body.courierPickupAt),
    handoverConfirmationNote: note,
    trackingNumber,
  };
}

async function lockHandoverOrder(client, orderId) {
  const context = await orders.getMoneyLockContext(client, orderId);
  if (!context) throw new NotFoundError('order', orderId);
  if (context.reservation_id === null) throw new NotFoundError('order', orderId);
  if (!(await listings.lockListingForMoneyAction(client, context.listing_id))) {
    throw new NotFoundError('order', orderId);
  }
  if (!(await users.lockBuyerForMoneyAction(client, context.buyer_id))) {
    throw new NotFoundError('order', orderId);
  }
  const order = await orders.lockReservationOrderForHandover(client, orderId);
  if (!order || order.listing_id !== context.listing_id ||
      order.buyer_id !== context.buyer_id || order.reservation_id !== context.reservation_id) {
    throw new NotFoundError('order', orderId);
  }
  const reservation = await reservations.lockReservationForSystemAction(client, order.reservation_id);
  if (!reservation || reservation.listing_id !== order.listing_id) {
    throw new ConflictError('The order reservation is no longer available.');
  }
  const refundRows = await escrowPayments.lockPaymentAndRefundRowsForHandover(client, order.id);
  return {
    order,
    reservation,
    refundRows,
    hasHandoverTimeoutRefund: refundRows.some((refund) => refund.trigger === 'system_handover_timeout'),
  };
}

async function validatePickupAgainstDatabaseTime(client, courierPickupAt, order) {
  if (!order.funded_at) {
    if (order.status === 'funded') throw new ConflictError('The order has no funding timestamp.');
    return { future: false, beforeFunding: false, afterDeadline: false };
  }
  const { rows } = await client.query(
    `SELECT $1::timestamptz > now() AS future,
            $1::timestamptz < $2::timestamptz AS before_funding,
            $3::timestamptz IS NOT NULL AND $1::timestamptz > $3::timestamptz AS after_deadline`,
    [courierPickupAt, order.funded_at, order.handover_deadline_at]
  );
  const checks = rows[0];
  if (checks.future) throw new ValidationError('courierPickupAt cannot be in the future.');
  if (checks.before_funding) throw new ValidationError('courierPickupAt cannot be before funded_at.');
  return {
    future: checks.future,
    beforeFunding: checks.before_funding,
    afterDeadline: checks.after_deadline,
  };
}

async function writeHandoverLog(client, {
  orderId, adminId, note, trackingNumber, status = 'picked_up',
}) {
  const logNote = trackingNumber
    ? `${note}\nTracking number: ${trackingNumber}`
    : note;
  const { rows } = await client.query(
    `INSERT INTO delivery_status_log
       (order_id, status, entered_by, note)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [orderId, status, adminId, logNote]
  );
  return rows[0];
}

async function recordLateHandoverException(orderId, adminId, handover) {
  return db.withTransactionRetry(async (client) => {
    const { order, hasHandoverTimeoutRefund } = await lockHandoverOrder(client, orderId);
    await validatePickupAgainstDatabaseTime(client, handover.courierPickupAt, order);
    if (order.status !== 'cancelled' || !hasHandoverTimeoutRefund) return false;
    await client.query(
      `INSERT INTO order_exceptions
         (order_id, kind, courier_pickup_at, note, recorded_by)
       VALUES ($1, 'late_handover_after_auto_cancel', $2::timestamptz, $3, $4)
       ON CONFLICT (order_id, kind) WHERE resolved_at IS NULL DO NOTHING`,
      [orderId, handover.courierPickupAt, handover.handoverConfirmationNote, adminId]
    );
    return true;
  });
}

function cancelledOrderCause(reservation, refundRows) {
  const hasSystemCancelRefund = refundRows.some((refund) => refund.trigger === 'system_cancel');
  if (reservation.end_reason === 'buyer_cancelled' && hasSystemCancelRefund) {
    return 'Order was cancelled by the buyer';
  }
  if (reservation.end_reason === 'listing_taken_down' && hasSystemCancelRefund) {
    return 'Order was cancelled because the listing was taken down';
  }
  return 'Order was cancelled';
}

async function recordHandoverAfterCancelException(orderId, adminId, handover) {
  return db.withTransactionRetry(async (client) => {
    const {
      order, reservation, hasHandoverTimeoutRefund, refundRows,
    } = await lockHandoverOrder(client, orderId);
    await validatePickupAgainstDatabaseTime(client, handover.courierPickupAt, order);
    if (order.status !== 'cancelled' || !order.funded_at || hasHandoverTimeoutRefund) {
      return { created: false, existingExceptionId: null };
    }

    const cause = cancelledOrderCause(reservation, refundRows);
    const { rows } = await client.query(
      `INSERT INTO order_exceptions
         (order_id, kind, courier_pickup_at, note, recorded_by)
       VALUES ($1, 'handover_after_cancel', $2::timestamptz, $3, $4)
       ON CONFLICT (order_id, kind) WHERE resolved_at IS NULL DO NOTHING
       RETURNING id`,
      [
        orderId,
        handover.courierPickupAt,
        `${handover.handoverConfirmationNote}\n${cause}`,
        adminId,
      ]
    );
    if (rows[0]) return { created: true, existingExceptionId: null };

    const existing = await client.query(
      `SELECT id
       FROM order_exceptions
       WHERE order_id = $1 AND kind = 'handover_after_cancel' AND resolved_at IS NULL`,
      [orderId]
    );
    return { created: false, existingExceptionId: existing.rows[0]?.id || null };
  });
}

/** FR-72: record an Admin-confirmed courier handover under canonical money locks. */
async function recordAdminHandover(orderId, body, adminId) {
  const handover = validateHandoverRequest(orderId, body, adminId);
  const result = await db.withTransactionRetry(async (client) => {
    const {
      order, reservation, hasHandoverTimeoutRefund,
    } = await lockHandoverOrder(client, orderId);
    const pickupChecks = await validatePickupAgainstDatabaseTime(client, handover.courierPickupAt, order);

    if (order.status === 'cancelled' && hasHandoverTimeoutRefund) {
      return { kind: 'auto_cancelled' };
    }
    if (order.status === 'cancelled' && order.funded_at !== null) {
      return { kind: 'cancelled_after_funding' };
    }
    if (order.status !== 'funded' || reservation.status !== 'paid' ||
        order.handed_over_at !== null || !order.handover_deadline_at) {
      throw new ConflictError('The order is not eligible for courier handover.');
    }
    if (pickupChecks.afterDeadline) {
      throw new ConflictError('The courier pickup occurred after the handover deadline.');
    }

    const updatedOrder = await orders.recordCourierHandover(
      client,
      orderId,
      handover.courierPickupAt
    );
    if (!updatedOrder) throw new ConflictError('The order state changed before handover was recorded.');
    await writeHandoverLog(client, {
      orderId,
      adminId,
      note: handover.handoverConfirmationNote,
      trackingNumber: handover.trackingNumber,
    });
    await escrowPayments.recordCourierHandoverAuditEvent(client, {
      orderId,
      adminId,
      courierPickupAt: updatedOrder.courier_pickup_at.toISOString(),
      hasTrackingNumber: Boolean(handover.trackingNumber),
    });
    return {
      orderId,
      deliveryStatus: updatedOrder.status,
      courierPickupAt: updatedOrder.courier_pickup_at,
      handoverRecordedAt: updatedOrder.handover_recorded_at,
      trackingNumber: handover.trackingNumber,
      updatedAt: updatedOrder.handover_recorded_at,
    };
  });

  if (result.kind === 'auto_cancelled') {
    const exceptionRecorded = await recordLateHandoverException(orderId, adminId, handover);
    if (!exceptionRecorded) {
      throw new ConflictError('The order was already cancelled and cannot be reopened.');
    }
    throw new ConflictError('The order was auto-cancelled and refunded; it will not be reopened and requires manual resolution.');
  }
  if (result.kind === 'cancelled_after_funding') {
    const exception = await recordHandoverAfterCancelException(orderId, adminId, handover);
    if (!exception.created) {
      if (exception.existingExceptionId) {
        throw new ConflictError(
          `The order is already cancelled and cannot be reopened; an existing exception (${exception.existingExceptionId}) is unresolved for handover-after-cancel.`
        );
      }
      throw new ConflictError('The order is no longer eligible for a handover-after-cancel exception.');
    }
    throw new ConflictError('The order was cancelled and refunded; it will not be reopened. A handover-after-cancel exception was recorded for manual resolution.');
  }
  return result;
}

function validateDeliveredRequest(orderId, body, adminId) {
  if (typeof orderId !== 'string' || !UUID.test(orderId)) {
    throw new ValidationError('orderId must be a UUID.');
  }
  if (typeof adminId !== 'string' || !UUID.test(adminId)) {
    throw new ValidationError('adminId must be a UUID.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'note') ||
      typeof body.note !== 'string') {
    throw new ValidationError('A delivery note of 1 to 500 characters is required.');
  }
  const note = body.note.trim();
  if (note.length < 1 || note.length > 500) {
    throw new ValidationError('A delivery note of 1 to 500 characters is required.');
  }
  return note;
}

/** FR-68: mark a reservation-backed order delivered and start its payout hold atomically. */
async function markOrderDelivered(orderId, body, adminId) {
  const note = validateDeliveredRequest(orderId, body, adminId);
  const result = await db.withTransactionRetry(async (client) => {
    const { order, reservation } = await lockHandoverOrder(client, orderId);
    if (!['handed_to_delivery', 'out_for_delivery'].includes(order.status) ||
        reservation.status !== 'paid' ||
        !order.handed_over_at ||
        order.delivered_at !== null) {
      throw new ConflictError('The order is not eligible to be marked delivered.');
    }

    const updatedOrder = await orders.markReservationOrderDelivered(client, orderId);
    if (!updatedOrder) {
      throw new ConflictError('The order state changed before delivery was recorded.');
    }
    const holdCreated = await payout.startHoldForReservationOrder(client, orderId);
    const hold = await payout.getReservationOrderHold(client, orderId);
    await writeHandoverLog(client, {
      orderId,
      adminId,
      note,
      status: 'delivered',
    });
    await escrowPayments.recordOrderDeliveredAuditEvent(client, { orderId, adminId });
    return {
      orderId,
      status: updatedOrder.status,
      deliveredAt: updatedOrder.delivered_at,
      holdCreated,
      payoutHold: {
        state: hold.state,
        holdStartedAt: hold.hold_started_at,
        holdWindowDays: hold.hold_window_days,
        complaintWindowDays: hold.complaint_window_days,
      },
    };
  });

  if (result.holdCreated) eventBus.emit(events.PAYOUT_HELD, { orderId });
  const { holdCreated: _holdCreated, ...response } = result;
  return response;
}

/** FR-72e: list Admin delivery exceptions using status, kind, and bounded limit filters. */
async function listOrderExceptions(filters = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new ValidationError('Order exception filters must be an object.');
  }
  const status = filters.status === undefined ? 'unresolved' : filters.status;
  if (!['unresolved', 'resolved', 'all'].includes(status)) {
    throw new ValidationError('status must be unresolved, resolved, or all.');
  }
  const allowedKinds = new Set([
    'late_handover_after_auto_cancel',
    'handover_after_cancel',
    'dispute_refund_required',
  ]);
  const kind = filters.kind;
  if (kind !== undefined && (typeof kind !== 'string' || !allowedKinds.has(kind))) {
    throw new ValidationError('kind is not a supported order exception kind.');
  }
  const rawLimit = filters.limit === undefined ? '50' : filters.limit;
  if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) {
    throw new ValidationError('limit must be a positive integer.');
  }
  const limit = Math.min(Number(rawLimit), 100);
  const conditions = [];
  const params = [];
  if (status !== 'all') conditions.push(status === 'resolved' ? 'resolved_at IS NOT NULL' : 'resolved_at IS NULL');
  if (kind !== undefined) {
    params.push(kind);
    conditions.push(`kind = $${params.length}`);
  }
  params.push(limit);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT id, order_id AS "orderId", kind,
            courier_pickup_at AS "courierPickupAt", note,
            recorded_at AS "recordedAt", resolved_at AS "resolvedAt",
            resolved_by AS "resolvedBy", resolution_note AS "resolutionNote"
     FROM order_exceptions
     ${where}
     ORDER BY recorded_at DESC, id DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

/** FR-72e: resolve one Admin delivery exception and audit the resolution atomically. */
async function resolveOrderException(exceptionId, { resolvedBy, resolutionNote } = {}) {
  if (typeof exceptionId !== 'string' || !UUID.test(exceptionId)) {
    throw new ValidationError('exceptionId must be a UUID.');
  }
  if (typeof resolvedBy !== 'string' || !UUID.test(resolvedBy)) {
    throw new ValidationError('resolvedBy must be a UUID.');
  }
  if (typeof resolutionNote !== 'string') {
    throw new ValidationError('resolutionNote must be 3 to 500 characters.');
  }
  const note = resolutionNote.trim();
  if (note.length < 3 || note.length > 500) {
    throw new ValidationError('resolutionNote must be 3 to 500 characters.');
  }

  return db.withTransaction(async (client) => {
    const { rows: exceptionRows } = await client.query(
      `SELECT id, order_id, kind, resolved_at
       FROM order_exceptions
       WHERE id = $1
       FOR UPDATE`,
      [exceptionId]
    );
    const exception = exceptionRows[0];
    if (!exception) throw new NotFoundError('order exception', exceptionId);
    if (exception.resolved_at !== null) {
      throw new ConflictError('This order exception has already been resolved.');
    }

    const { rows } = await client.query(
      `UPDATE order_exceptions
       SET resolved_at = now(), resolved_by = $2, resolution_note = $3
       WHERE id = $1
       RETURNING id, order_id AS "orderId", kind,
                 courier_pickup_at AS "courierPickupAt", note,
                 recorded_at AS "recordedAt", resolved_at AS "resolvedAt",
                 resolved_by AS "resolvedBy", resolution_note AS "resolutionNote"`,
      [exceptionId, resolvedBy, note]
    );
    await escrowPayments.recordOrderExceptionResolvedAuditEvent(client, {
      orderId: exception.order_id,
      adminId: resolvedBy,
      exceptionId,
      kind: exception.kind,
      resolutionNote: note,
    });
    return rows[0];
  });
}

/** FR-68: list reservation-backed orders for the Admin using one bounded keyset query. */
async function listAdminOrders(query = {}) {
  const { limit, status, before } = validateAdminOrderListQuery(query);
  let result;
  try {
    // Cross-module reads are permitted here because this is a single multi-table Admin list view.
    // cross-module read: orders (owned by orders.service.js)
    // cross-module read: listings (owned by listings.service.js)
    // cross-module read: reservations (owned by reservations.service.js)
    // cross-module read: payments (owned by escrowPayments.service.js)
    // cross-module read: payout_holds (owned by payout.service.js)
    // cross-module read: disputes (owned by disputes.service.js)
    result = await db.read(
      `WITH cursor_order AS (
         SELECT id, created_at
         FROM orders
         WHERE id = $1::uuid AND reservation_id IS NOT NULL
       ),
       order_status_filter AS MATERIALIZED (
         SELECT $3::order_status AS status
       )
       SELECT cursor_check.valid AS cursor_valid, page.*
       FROM (
         SELECT $1::uuid IS NULL OR EXISTS (SELECT 1 FROM cursor_order) AS valid
       ) cursor_check
       LEFT JOIN LATERAL (
         SELECT o.id AS "orderId", o.status,
                l.id AS "listingId", l.title AS "listingTitle",
                r.item_price_snapshot::text AS "itemPrice",
                r.delivery_fee_snapshot::text AS "deliveryFee",
                r.total_amount_snapshot::text AS total,
                latest_payment.status AS "paymentStatus",
                o.funded_at AS "fundedAt",
                o.handover_deadline_at AS "handoverDeadlineAt",
                o.handed_over_at AS "handedOverAt",
                o.delivered_at AS "deliveredAt",
                EXISTS (
                  SELECT 1 FROM disputes d
                  WHERE d.order_id = o.id AND d.status IN ('open', 'seller_responded')
                ) AS "hasOpenDispute",
                EXISTS (
                  SELECT 1 FROM order_exceptions oe
                  WHERE oe.order_id = o.id AND oe.resolved_at IS NULL
                ) AS "hasUnresolvedException",
                o.created_at AS "createdAt"
         FROM orders o
         JOIN listings l ON l.id = o.listing_id
         JOIN reservations r ON r.id = o.reservation_id
         LEFT JOIN LATERAL (
           SELECT p.status
           FROM payments p
           WHERE p.order_id = o.id
           ORDER BY p.created_at DESC, p.id DESC
           LIMIT 1
         ) latest_payment ON true
         CROSS JOIN order_status_filter status_filter
         WHERE o.reservation_id IS NOT NULL
           AND (status_filter.status IS NULL OR o.status = status_filter.status)
           AND ($1::uuid IS NULL OR (o.created_at, o.id) < (
             SELECT created_at, id FROM cursor_order
           ))
         ORDER BY o.created_at DESC, o.id DESC
         LIMIT $2
       ) page ON true`,
      [before, limit + 1, status]
    );
  } catch (error) {
    if (status !== null && error?.code === '22P02') {
      throw new ValidationError('status is not a value in the order_status enum.');
    }
    throw error;
  }
  const first = result.rows[0];
  if (before !== null && !first?.cursor_valid) {
    throw new ValidationError('before must identify a reservation-backed order.');
  }
  const rows = result.rows.filter((row) => row.orderId !== null);
  const hasMore = rows.length > limit;
  const ordersForPage = rows.slice(0, limit).map((row) => ({
    orderId: row.orderId,
    status: row.status,
    listing: { id: row.listingId, title: row.listingTitle },
    amounts: {
      itemPrice: String(row.itemPrice),
      deliveryFee: String(row.deliveryFee),
      total: String(row.total),
    },
    paymentStatus: row.paymentStatus,
    fundedAt: row.fundedAt,
    handoverDeadlineAt: row.handoverDeadlineAt,
    handedOverAt: row.handedOverAt,
    deliveredAt: row.deliveredAt,
    hasOpenDispute: row.hasOpenDispute,
    hasUnresolvedException: row.hasUnresolvedException,
    createdAt: row.createdAt,
  }));
  return {
    orders: ordersForPage,
    nextBefore: hasMore ? ordersForPage[ordersForPage.length - 1].orderId : null,
  };
}

/** FR-68: return the latest stored tracking number and safe exception metadata for an Admin order view. */
async function getAdminOrderDeliveryMetadata(orderId) {
  const { rows } = await db.read(
    `SELECT
       (SELECT log.note
        FROM delivery_status_log log
        WHERE log.order_id = $1 AND log.note LIKE '%Tracking number:%'
        ORDER BY log.created_at DESC, log.id DESC
        LIMIT 1) AS tracking_note,
       COALESCE(
         (SELECT jsonb_agg(
                   jsonb_build_object(
                     'id', oe.id,
                     'kind', oe.kind,
                     'recordedAt', oe.recorded_at,
                     'resolvedAt', oe.resolved_at
                   )
                   ORDER BY oe.recorded_at, oe.id)
          FROM order_exceptions oe
          WHERE oe.order_id = $1),
         '[]'::jsonb
       ) AS exceptions`,
    [orderId]
  );
  const trackingMatch = rows[0].tracking_note?.match(/(?:^|\r?\n)Tracking number: ([^\r\n]+)/);
  const exceptions = rows[0].exceptions;
  return {
    trackingNumber: trackingMatch ? trackingMatch[1].trim() : null,
    exceptions,
    hasUnresolvedException: exceptions.some((exception) => exception.resolvedAt === null),
  };
}

/** FR-68: compose an Admin reservation-order detail from owner-scoped read helpers. */
async function getAdminOrderDetail(orderId) {
  const order = await orders.getAdminReservationOrderContext(orderId);
  if (!order) throw new NotFoundError('order', orderId);

  const [
    listing,
    parties,
    reservation,
    paymentAndRefunds,
    payoutHold,
    disputeSummary,
    deliveryMetadata,
  ] = await Promise.all([
    listings.getAdminOrderSummary(order.listing_id),
    users.getAdminOrderParties(order.buyer_id, order.seller_id),
    reservations.getAdminOrderReservationSnapshot(order.reservation_id),
    escrowPayments.getAdminOrderPaymentAndRefunds(order.id),
    payout.getAdminOrderHoldSnapshot(order.id, order.delivered_at),
    disputes.getAdminOrderDisputes(order.id),
    getAdminOrderDeliveryMetadata(order.id),
  ]);
  if (!listing || !parties || !reservation) throw new NotFoundError('order', orderId);

  return {
    orderId: order.id,
    status: order.status,
    listing,
    amounts: reservation.amounts,
    paymentStatus: paymentAndRefunds.payment?.status ?? null,
    fundedAt: order.funded_at,
    handoverDeadlineAt: order.handover_deadline_at,
    handedOverAt: order.handed_over_at,
    deliveredAt: order.delivered_at,
    hasOpenDispute: disputeSummary.hasOpenDispute,
    hasUnresolvedException: deliveryMetadata.hasUnresolvedException,
    createdAt: order.created_at,
    buyer: parties.buyer,
    seller: parties.seller,
    deliveryAddress: reservation.deliveryAddress,
    reservation: {
      id: reservation.id,
      status: reservation.status,
      expiresAt: reservation.expiresAt,
    },
    payment: paymentAndRefunds.payment || { status: null, amount: null },
    courierPickupAt: order.courier_pickup_at,
    handoverRecordedAt: order.handover_recorded_at,
    trackingNumber: deliveryMetadata.trackingNumber,
    payoutHold,
    disputes: disputeSummary.disputes,
    exceptions: deliveryMetadata.exceptions,
    refunds: paymentAndRefunds.refunds,
  };
}

module.exports = {
  createDeliveryPartner,
  listDeliveryPartners,
  setDeliveryPartnerActive,
  logDeliveryStatus,
  getDeliveryTracking,
  recordAdminHandover,
  markOrderDelivered,
  listOrderExceptions,
  resolveOrderException,
  validateAdminOrderListQuery,
  listAdminOrders,
  getAdminOrderDetail,
  getAdminOrderDeliveryMetadata,
};
