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
const {
  ConflictError, NotFoundError, ValidationError,
} = require('../lib/errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

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

async function writeHandoverLog(client, { orderId, adminId, note, trackingNumber }) {
  const logNote = trackingNumber
    ? `${note}\nTracking number: ${trackingNumber}`
    : note;
  const { rows } = await client.query(
    `INSERT INTO delivery_status_log
       (order_id, status, entered_by, note)
     VALUES ($1, 'picked_up', $2, $3)
     RETURNING id`,
    [orderId, adminId, logNote]
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

/** FR-72: record an Admin-confirmed courier handover under canonical money locks. */
async function recordAdminHandover(orderId, body, adminId) {
  const handover = validateHandoverRequest(orderId, body, adminId);
  const result = await db.withTransactionRetry(async (client) => {
    const { order, reservation, hasHandoverTimeoutRefund } = await lockHandoverOrder(client, orderId);
    const pickupChecks = await validatePickupAgainstDatabaseTime(client, handover.courierPickupAt, order);

    if (order.status === 'cancelled' && hasHandoverTimeoutRefund) {
      return { kind: 'auto_cancelled' };
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
  return result;
}

/** FR-72e: list unresolved delivery exceptions newest-first, bounded to 50. */
async function listOrderExceptions() {
  const { rows } = await db.query(
    `SELECT id, order_id AS "orderId", kind,
            courier_pickup_at AS "courierPickupAt", note,
            recorded_at AS "recordedAt", resolved_at AS "resolvedAt"
     FROM order_exceptions
     WHERE resolved_at IS NULL
     ORDER BY recorded_at DESC, id DESC
     LIMIT 50`
  );
  return rows;
}

module.exports = {
  createDeliveryPartner,
  listDeliveryPartners,
  setDeliveryPartnerActive,
  logDeliveryStatus,
  getDeliveryTracking,
  recordAdminHandover,
  listOrderExceptions,
};
