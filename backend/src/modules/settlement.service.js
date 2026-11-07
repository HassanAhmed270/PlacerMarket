/**
 * modules/settlement.service.js
 *
 * Owns: FR-46 to FR-50a (specs.md section "10. Commission & Settlement")
 * Tables owned: platform_settings, settlements
 *
 * platform_settings doubles as GLOBAL APP CONFIG, not just commission
 * settings — several other modules read from it via getSetting():
 * - users.service.js reads 'high_value_threshold_pkr' (FR-08a)
 * - disputes.service.js reads 'complaint_window_days' (FR-43)
 * - payout.service.js reads 'payout_hold_days' (FR-45c)
 * This file does NOT require those modules back — to avoid a circular
 * require, cross-module coordination for the FR-50a guard below is done by
 * having the CALLER (payout.service.js) pass in resolutionAmountToBuyer
 * explicitly, rather than this file reaching into the `disputes` table.
 */

const db = require('../db.service');
const { NotFoundError, ValidationError, NotYetSpecifiedError } = require('../lib/errors');

// ---- FR-50: generic settings accessor (used across modules) ----

/** FR-50: generic platform_settings read, used across modules. */
async function getSetting(key) {
  const { rows } = await db.query('SELECT value FROM platform_settings WHERE key = $1', [key]);
  if (!rows[0]) throw new NotFoundError('platform_setting', key);
  return rows[0].value;
}

/** FR-50: read platform settings using the caller's existing transaction. */
async function getSettingsForTransaction(client, keys) {
  const { rows } = await client.query(
    'SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])',
    [keys]
  );
  const settings = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  for (const key of keys) {
    if (!Object.hasOwn(settings, key)) throw new NotFoundError('platform_setting', key);
  }
  return settings;
}

/** FR-50: generic platform_settings upsert. */
async function setSetting(key, value, adminId) {
  const { rows } = await db.query(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING *`,
    [key, String(value), adminId]
  );
  return rows[0];
}

// ---- FR-46, FR-46a: commission ----

/** FR-46, FR-46a: single global % (admin-adjustable), applied to item price ONLY — delivery fee excluded. */
async function calculateCommission(itemPrice) {
  const percent = Number(await getSetting('commission_percent'));
  const commissionAmount = Number(itemPrice) * (percent / 100);
  return { percent, commissionAmount };
}

function decimalToMinorUnits(value, fieldName) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    throw new ValidationError(`${fieldName} must be a non-negative decimal string with at most two decimal places.`);
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function minorUnitsToDecimal(value) {
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

/** FR-47: calculate reservation settlement amounts exactly from decimal strings. */
function calculateReservationSettlement(itemPrice, commissionPercent) {
  const itemPriceMinor = decimalToMinorUnits(itemPrice, 'itemPrice');
  if (typeof commissionPercent !== 'string' ||
      !/^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/.test(commissionPercent)) {
    throw new ValidationError('commissionPercent must be a decimal string from 0 to 100.');
  }
  const percentParts = commissionPercent.split('.');
  const percentMinor = BigInt(percentParts[0]) * 100n + BigInt((percentParts[1] || '').padEnd(2, '0'));
  if (percentMinor > 10000n) {
    throw new ValidationError('commissionPercent must be a decimal string from 0 to 100.');
  }

  const commissionMinor = (itemPriceMinor * percentMinor + 5000n) / 10000n;
  return {
    commissionPercent,
    commissionAmount: minorUnitsToDecimal(commissionMinor),
    sellerNetAmount: minorUnitsToDecimal(itemPriceMinor - commissionMinor),
  };
}

/** FR-47, FR-49: insert a reservation settlement in the payout transaction. */
async function recordReservationSettlement(client, orderId, adminId, amounts) {
  const { rows } = await client.query(
    `INSERT INTO settlements
       (order_id, commission_percent, commission_amount, seller_net_payout,
        payout_initiated_by, payout_initiated_at)
     VALUES ($1, $2, $3::numeric, $4::numeric, $5, now())
     RETURNING order_id, commission_percent, commission_amount, seller_net_payout,
               payout_initiated_by, payout_initiated_at`,
    [orderId, amounts.commissionPercent, amounts.commissionAmount, amounts.sellerNetAmount, adminId]
  );
  return rows[0];
}

// ---- FR-47, FR-49: settlement record ----

/**
 * FR-47: called by payout.service.js once cash is confirmed remitted AND
 * the hold window has passed (or admin force-released) with no unresolved
 * dispute — this file does not decide WHEN to settle, only HOW MUCH.
 *
 * FR-50a (OPEN): if resolutionAmountToBuyer is passed and is neither 0 nor
 * the full agreed_item_price, that's a partial-refund scenario this
 * function refuses to compute — FR-45a hasn't decided partial-refund policy
 * yet, and settlement math for it is explicitly blocked on that decision.
 */
async function calculateSettlement(orderId, { agreedItemPrice, resolutionAmountToBuyer } = {}) {
  if (
    resolutionAmountToBuyer !== undefined &&
    resolutionAmountToBuyer !== null &&
    Number(resolutionAmountToBuyer) !== 0 &&
    Number(resolutionAmountToBuyer) !== Number(agreedItemPrice)
  ) {
    throw new NotYetSpecifiedError(
      'FR-50a',
      'settlement math for a partial-refund dispute resolution is blocked on the FR-45a decision'
    );
  }

  const { percent, commissionAmount } = await calculateCommission(agreedItemPrice);
  // If the dispute resolved as a full refund to the buyer, the seller's net
  // payout is 0 for this order (commission also does not apply — TODO:
  // confirm this "commission waived on full refund" assumption once
  // FR-50a's broader scope firms up).
  const sellerNetPayout =
    resolutionAmountToBuyer && Number(resolutionAmountToBuyer) === Number(agreedItemPrice)
      ? 0
      : Number(agreedItemPrice) - commissionAmount;

  const { rows } = await db.query(
    `INSERT INTO settlements (order_id, commission_percent, commission_amount, seller_net_payout)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (order_id) DO UPDATE
       SET commission_percent = EXCLUDED.commission_percent,
           commission_amount = EXCLUDED.commission_amount,
           seller_net_payout = EXCLUDED.seller_net_payout
     RETURNING *`,
    [orderId, percent, commissionAmount, sellerNetPayout]
  );
  return rows[0];
}

/** FR-48 / FR-66 / FR-83l: enforce seller payout eligibility at disbursement initiation. */
async function initiateSellerPayout(orderId, adminId, assertPayoutAllowed) {
  if (typeof assertPayoutAllowed !== 'function') throw new TypeError('Payout eligibility guard is required.');
  const { rows: orders } = await db.query('SELECT seller_id FROM orders WHERE id = $1', [orderId]);
  if (!orders[0]) throw new NotFoundError('order', orderId);
  await assertPayoutAllowed(orders[0].seller_id);
  const { rows } = await db.query(
    `UPDATE settlements SET payout_initiated_by = $1, payout_initiated_at = now() WHERE order_id = $2 RETURNING *`,
    [adminId, orderId]
  );
  if (!rows[0]) throw new NotFoundError('settlement', orderId);
  return rows[0];
}

/** FR-49: reconciliation record lookup. */
async function getSettlementRecord(orderId) {
  const { rows } = await db.query('SELECT * FROM settlements WHERE order_id = $1', [orderId]);
  return rows[0] || null;
}

/** FR-50: Admin-only (enforced at route level via lib/roles.js ADMIN_ONLY_ACTIONS 'fee.configure'). */
async function adjustCommissionPercent(newPercent, adminId) {
  if (newPercent < 0 || newPercent > 100) throw new ValidationError('commission percent must be between 0 and 100');
  return setSetting('commission_percent', newPercent, adminId);
}

module.exports = {
  getSetting,
  getSettingsForTransaction,
  setSetting,
  calculateCommission,
  calculateReservationSettlement,
  recordReservationSettlement,
  calculateSettlement,
  initiateSellerPayout,
  getSettlementRecord,
  adjustCommissionPercent,
};
