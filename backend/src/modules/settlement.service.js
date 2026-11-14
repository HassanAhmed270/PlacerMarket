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

function parseDecimalInput(value, fieldName) {
  const str = typeof value === 'number' ? value.toFixed(2) : String(value ?? '');
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(str)) {
    throw new ValidationError(`${fieldName} must be a non-negative decimal with at most two decimal places.`);
  }
  return str;
}

function decimalToMinorUnits(value, fieldName) {
  const str = parseDecimalInput(value, fieldName);
  const [whole, fraction = ''] = str.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function minorUnitsToDecimal(value) {
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

/** FR-46, FR-47, FR-50a: calculate reservation settlement amounts exactly from decimal strings and snapshots. */
function calculateReservationSettlement(itemPrice, commissionPercent, refundedItemAmount = '0.00') {
  if (typeof itemPrice === 'object' && itemPrice !== null) {
    const reservation = itemPrice;
    itemPrice = reservation.item_price_snapshot ?? reservation.itemPrice;
    commissionPercent = commissionPercent ?? reservation.commission_percent_snapshot ?? reservation.commissionPercent;
    refundedItemAmount = refundedItemAmount !== '0.00' ? refundedItemAmount : (reservation.refunded_item_amount ?? reservation.refundedItemAmount ?? '0.00');
  }

  const itemPriceMinor = decimalToMinorUnits(itemPrice, 'itemPrice');

  const percentStr = typeof commissionPercent === 'number' ? String(commissionPercent) : commissionPercent;
  if (typeof percentStr !== 'string' ||
      !/^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/.test(percentStr)) {
    throw new ValidationError('commissionPercent must be a decimal string from 0 to 100.');
  }
  const percentParts = percentStr.split('.');
  const percentMinor = BigInt(percentParts[0]) * 100n + BigInt((percentParts[1] || '').padEnd(2, '0'));
  if (percentMinor > 10000n) {
    throw new ValidationError('commissionPercent must be a decimal string from 0 to 100.');
  }

  const refundedMinor = decimalToMinorUnits(refundedItemAmount, 'refundedItemAmount');
  if (refundedMinor > itemPriceMinor) {
    throw new ValidationError('Refunds above the item price are rejected.');
  }
  if (refundedMinor === itemPriceMinor) {
    return null;
  }

  const receivedByPlatformBaseMinor = itemPriceMinor - refundedMinor;
  const commissionMinor = (receivedByPlatformBaseMinor * percentMinor + 5000n) / 10000n;
  const sellerNetAmountMinor = receivedByPlatformBaseMinor - commissionMinor;

  return {
    commissionPercent: percentStr,
    commissionAmount: minorUnitsToDecimal(commissionMinor),
    sellerNetAmount: minorUnitsToDecimal(sellerNetAmountMinor),
    refundedItemAmount: minorUnitsToDecimal(refundedMinor),
  };
}

/** FR-47, FR-49, FR-50a: insert an idempotent reservation settlement and ledger entries in the payout transaction. */
async function recordReservationSettlement(client, orderId, adminId, amounts) {
  let finalAmounts = amounts;
  let currency = 'PKR';

  if (!finalAmounts) {
    const { rows: resRows } = await client.query(
      `SELECT r.item_price_snapshot, r.commission_percent_snapshot, r.currency
       FROM reservations r
       JOIN orders o ON o.reservation_id = r.id
       WHERE o.id = $1`,
      [orderId]
    );
    if (!resRows[0]) throw new NotFoundError('reservation for order', orderId);

    const { rows: refundRows } = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::text AS refunded_item_amount
       FROM refunds
       WHERE order_id = $1 AND status = 'succeeded'`,
      [orderId]
    );
    currency = resRows[0].currency || 'PKR';
    finalAmounts = calculateReservationSettlement(
      resRows[0].item_price_snapshot,
      resRows[0].commission_percent_snapshot,
      refundRows[0]?.refunded_item_amount || '0.00'
    );
  } else {
    currency = amounts.currency || 'PKR';
  }

  if (!finalAmounts) {
    return null;
  }

  const { rows } = await client.query(
    `INSERT INTO settlements
       (order_id, commission_percent, commission_amount, seller_net_payout,
        refunded_item_amount, payout_initiated_by, payout_initiated_at)
     VALUES ($1, $2::numeric, $3::numeric, $4::numeric, $5::numeric, $6, now())
     ON CONFLICT (order_id) DO UPDATE
       SET order_id = settlements.order_id
     RETURNING order_id, commission_percent, commission_amount, seller_net_payout,
               refunded_item_amount, payout_initiated_by, payout_initiated_at`,
    [
      orderId,
      finalAmounts.commissionPercent,
      finalAmounts.commissionAmount,
      finalAmounts.sellerNetAmount,
      finalAmounts.refundedItemAmount || '0.00',
      adminId,
    ]
  );
  const settlementRow = rows[0];

  if (finalAmounts.commissionAmount !== '0.00' && Number(finalAmounts.commissionAmount) > 0) {
    await client.query(
      `INSERT INTO ledger_entries
         (order_id, currency, amount, entry_type, idempotency_key)
       VALUES ($1, $2, $3::numeric, 'commission', $4)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [orderId, currency, finalAmounts.commissionAmount, `commission:${orderId}`]
    );
  }

  if (finalAmounts.sellerNetAmount !== '0.00' && Number(finalAmounts.sellerNetAmount) > 0) {
    await client.query(
      `INSERT INTO ledger_entries
         (order_id, currency, amount, entry_type, idempotency_key)
       VALUES ($1, $2, -($3::numeric), 'seller_payable', $4)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [orderId, currency, finalAmounts.sellerNetAmount, `seller_payable:${orderId}`]
    );
  }

  return settlementRow;
}

// ---- FR-47, FR-49: settlement record ----

/**
 * FR-47, FR-50a: called by payout.service.js once cash is confirmed remitted AND
 * the hold window has passed (or admin force-released) with no unresolved dispute.
 */
async function calculateSettlement(orderId, { agreedItemPrice, resolutionAmountToBuyer } = {}) {
  const itemPrice = Number(agreedItemPrice);
  const refundedItemAmount = resolutionAmountToBuyer !== undefined && resolutionAmountToBuyer !== null
    ? Number(resolutionAmountToBuyer)
    : 0;

  if (refundedItemAmount > itemPrice) {
    throw new ValidationError('refunds above the item price are rejected');
  }

  if (refundedItemAmount === itemPrice && itemPrice > 0) {
    return null;
  }

  const { percent } = await calculateCommission(agreedItemPrice);
  const receivedByPlatformBase = itemPrice - refundedItemAmount;
  const commissionAmount = Math.round(receivedByPlatformBase * percent) / 100;
  const sellerNetPayout = receivedByPlatformBase - commissionAmount;

  const { rows } = await db.query(
    `INSERT INTO settlements (order_id, commission_percent, commission_amount, seller_net_payout, refunded_item_amount)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (order_id) DO UPDATE
       SET commission_percent = EXCLUDED.commission_percent,
           commission_amount = EXCLUDED.commission_amount,
           seller_net_payout = EXCLUDED.seller_net_payout,
           refunded_item_amount = EXCLUDED.refunded_item_amount
     RETURNING *`,
    [orderId, percent, commissionAmount, sellerNetPayout, refundedItemAmount]
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
  if (typeof newPercent === 'boolean' || newPercent === null || newPercent === undefined) {
    throw new ValidationError('commission percent must be between 0 and 100');
  }
  const numeric = Number(newPercent);
  if (Number.isNaN(numeric) || numeric < 0 || numeric > 100) {
    throw new ValidationError('commission percent must be between 0 and 100');
  }
  return setSetting('commission_percent', String(newPercent), adminId);
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
