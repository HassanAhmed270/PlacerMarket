/**
 * modules/delivery.service.js
 *
 * Owns: FR-39 to FR-42 (specs.md section "8. Delivery")
 * Tables owned: delivery_partners, delivery_status_log
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
const { NotFoundError, ValidationError } = require('../lib/errors');

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
  if (!STATUS_VALUES.includes(status)) {
    throw new ValidationError(`status must be one of: ${STATUS_VALUES.join(', ')}`);
  }
  const { rows } = await db.query(
    `INSERT INTO delivery_status_log (order_id, delivery_partner_id, status, entered_by, note)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [orderId, deliveryPartnerId || null, status, enteredBy, note || null]
  );
  eventBus.emit(events.DELIVERY_STATUS_CHANGED, { orderId, status });
  return rows[0];
}

// ---- FR-42: tracking view ----

/** FR-42: delivery status history for an order. */
async function getDeliveryTracking(orderId) {
  const { rows } = await db.query(
    `SELECT * FROM delivery_status_log WHERE order_id = $1 ORDER BY created_at ASC`,
    [orderId]
  );
  return rows;
}

module.exports = {
  createDeliveryPartner,
  listDeliveryPartners,
  setDeliveryPartnerActive,
  logDeliveryStatus,
  getDeliveryTracking,
};
