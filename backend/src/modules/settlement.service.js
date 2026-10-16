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

/** FR-48: manual/admin-triggered payout — no payment-gateway automation in MVP. */
async function initiateSellerPayout(orderId, adminId) {
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
  setSetting,
  calculateCommission,
  calculateSettlement,
  initiateSellerPayout,
  getSettlementRecord,
  adjustCommissionPercent,
};
