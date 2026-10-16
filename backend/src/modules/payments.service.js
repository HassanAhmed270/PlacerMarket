/**
 * modules/payments.service.js
 *
 * Owns: FR-36 to FR-38 (specs.md section "7. Payments & COD")
 * Tables owned: cod_collections
 *
 * FR-36, FR-36b: there is deliberately no online payment processing here.
 * "Payment method preference" itself is stored on `orders` (checkout step,
 * FR-32a/FR-36a) and owned by orders.service.js — this file only records
 * what actually happened at the door once the courier confirms it.
 *
 * Cross-module dependency OUT: confirmCodCollection() is the FR-38 trigger
 * point — "no commission/payout release until COD collection is confirmed"
 * — so this function calls payout.service.startHold() (FR-45b) and
 * orders.service.setOrderStatus(orderId, 'held'). Do not start a payout
 * hold anywhere else in the codebase.
 */

const db = require('../db.service');
const orders = require('./orders.service');
const payout = require('./payout.service');
const { NotFoundError, ValidationError } = require('../lib/errors');

/** FR-37: read the already-agreed COD total (owned by orders.service.js) for display at the door. */
async function getExpectedCollectionAmount(orderId) {
  return orders.getCodAmountDue(orderId);
}

/**
 * FR-38: courier confirms actual collection (cash or digital transfer at the
 * door — note this is the ACTUAL method, which may differ from the
 * `payment_method_preference` chosen at checkout, e.g. buyer said "cash" but
 * pays digitally instead). This is the sole trigger for starting the payout
 * hold — nothing else in the codebase should call payout.service.startHold().
 */
async function confirmCodCollection(orderId, { collectedAmount, collectionMethod, collectedBy }) {
  if (!['cash', 'digital_transfer'].includes(collectionMethod)) {
    throw new ValidationError('collectionMethod must be "cash" or "digital_transfer" (FR-36a)');
  }
  const { rows } = await db.query(
    `INSERT INTO cod_collections (order_id, collected_amount, collection_method, collected_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (order_id) DO UPDATE
       SET collected_amount = EXCLUDED.collected_amount,
           collection_method = EXCLUDED.collection_method,
           collected_at = now()
     RETURNING *`,
    [orderId, collectedAmount, collectionMethod]
  );

  await orders.setOrderStatus(orderId, 'held'); // funds confirmed → enters payout-hold window
  await payout.startHold(orderId); // FR-45b

  return rows[0];
}

/** FR-41a: manual reconciliation of courier's remitted cash against platform records. */
async function reconcileCashRemittance(orderId, { reconciledBy, note }) {
  const { rows } = await db.query(
    `UPDATE cod_collections
     SET remitted_to_platform = true, remitted_at = now(), reconciled_by = $1, reconciliation_note = $2
     WHERE order_id = $3 RETURNING *`,
    [reconciledBy, note || null, orderId]
  );
  if (!rows[0]) throw new NotFoundError('cod_collection', orderId);
  return rows[0];
}

module.exports = { getExpectedCollectionAmount, confirmCodCollection, reconcileCashRemittance };
