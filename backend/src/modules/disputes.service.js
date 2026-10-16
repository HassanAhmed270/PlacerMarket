/**
 * modules/disputes.service.js
 *
 * Owns: FR-43 to FR-45a (specs.md section "9. Disputes, Returns & Refunds")
 * Tables owned: disputes, dispute_evidence
 *
 * Cross-module dependency OUT: reads settlement.service.getSetting()
 * ('complaint_window_days') — a one-directional dependency only
 * (disputes -> settlement). This file does NOT require payout.service.js,
 * even though payout.service.js requires THIS file for hasOpenDispute()
 * (FR-45f) — keeping the dependency one-directional avoids a circular
 * require between disputes.service.js and payout.service.js.
 *
 * FR-44's "combined view with HELD orders" is NOT implemented here —
 * see payout.service.js's getHeldOrdersWithDisputeStatus(), which is the
 * one-directional consumer of getDisputeQueue() below plus payout_holds.
 *
 * FR-45a (OPEN): resolveDispute() below refuses (NotYetSpecifiedError) any
 * resolutionAmountToBuyer that is neither 0 nor the full order amount —
 * partial/split resolution is not yet decided.
 */

const db = require('../db.service');
const settlement = require('./settlement.service');
const eventBus = require('../lib/eventBus');
const events = require('../lib/events');
const { NotFoundError, ValidationError, NotYetSpecifiedError } = require('../lib/errors');

// ---- FR-43, FR-43a, FR-43b: filing ----

/**
 * FR-43: buyer reports a problem within the complaint window.
 * FR-43a: at least one evidence file is REQUIRED — text alone is rejected.
 * FR-43b: reason is free-text only, no fixed category list.
 */
async function fileDispute(orderId, buyerId, { reasonText, evidenceUrls }) {
  if (!reasonText || !reasonText.trim()) {
    throw new ValidationError('A dispute reason is required (FR-43b, free-text)');
  }
  if (!evidenceUrls || evidenceUrls.length === 0) {
    throw new ValidationError('At least one evidence photo/file is required to file a dispute (FR-43a)');
  }

  const { rows: orderRows } = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  const order = orderRows[0];
  if (!order) throw new NotFoundError('order', orderId);
  if (!order.delivered_at) {
    throw new ValidationError('Dispute can only be filed after delivery (FR-43)');
  }

  const complaintWindowDays = Number(await settlement.getSetting('complaint_window_days'));
  const windowCloses = new Date(order.delivered_at);
  windowCloses.setDate(windowCloses.getDate() + complaintWindowDays);
  if (new Date() > windowCloses) {
    throw new ValidationError(`Complaint window (${complaintWindowDays} days post-delivery) has closed (FR-43)`);
  }

  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO disputes (order_id, raised_by, reason_text, status)
       VALUES ($1, $2, $3, 'open') RETURNING *`,
      [orderId, buyerId, reasonText]
    );
    const dispute = rows[0];
    for (const url of evidenceUrls) {
      await client.query(
        `INSERT INTO dispute_evidence (dispute_id, uploaded_by, file_url) VALUES ($1, $2, $3)`,
        [dispute.id, buyerId, url]
      );
    }
    eventBus.emit(events.DISPUTE_FILED, { disputeId: dispute.id, orderId });
    return dispute;
  });
}

/**
 * FR-43c: seller CAN respond/submit counter-evidence before admin decides.
 * Marked in specs.md as a working default, not stakeholder-confirmed —
 * kept simple here so it's easy to remove/change without touching anything
 * else if that changes.
 */
async function submitCounterEvidence(disputeId, sellerId, { responseText, evidenceUrls = [] }) {
  const { rows } = await db.query(
    `UPDATE disputes SET seller_response_text = $1, seller_responded_at = now(), status = 'seller_responded'
     WHERE id = $2 AND status = 'open' RETURNING *`,
    [responseText || null, disputeId]
  );
  if (!rows[0]) throw new NotFoundError('open dispute', disputeId);

  for (const url of evidenceUrls) {
    await db.query(
      `INSERT INTO dispute_evidence (dispute_id, uploaded_by, file_url) VALUES ($1, $2, $3)`,
      [disputeId, sellerId, url]
    );
  }
  return rows[0];
}

// ---- FR-44: queue (dispute-only side; combined-with-HELD view lives in payout.service.js) ----

/** FR-44: dispute-only queue (combined held-orders view is in payout.service). */
async function getDisputeQueue({ status } = {}) {
  const { rows } = status
    ? await db.query('SELECT * FROM disputes WHERE status = $1 ORDER BY created_at ASC', [status])
    : await db.query('SELECT * FROM disputes ORDER BY created_at ASC');
  return rows;
}

/** FR-43a, FR-44: evidence files attached to a dispute, for admin review. */
async function getDisputeEvidence(disputeId) {
  const { rows } = await db.query('SELECT * FROM dispute_evidence WHERE dispute_id = $1 ORDER BY created_at ASC', [disputeId]);
  return rows;
}

// ---- FR-45, FR-45a: resolution ----

/**
 * FR-45: Return Required -> Returned -> Refund/Resolution states, simplified
 * here to a direct resolve call (full refund vs full release).
 * FR-45a (OPEN): any resolutionAmountToBuyer other than 0 or the full
 * agreed_item_price is refused — partial/split resolution undecided.
 */
async function resolveDispute(disputeId, { resolutionAmountToBuyer, resolvedBy, resolutionNote }) {
  const { rows: disputeRows } = await db.query(
    `SELECT d.*, o.agreed_item_price FROM disputes d JOIN orders o ON o.id = d.order_id WHERE d.id = $1`,
    [disputeId]
  );
  const dispute = disputeRows[0];
  if (!dispute) throw new NotFoundError('dispute', disputeId);

  const amount = Number(resolutionAmountToBuyer);
  const full = Number(dispute.agreed_item_price);
  if (amount !== 0 && amount !== full) {
    throw new NotYetSpecifiedError(
      'FR-45a',
      'partial/split dispute resolution is not yet decided — only full-refund-to-buyer (amount = order total) or full-release-to-seller (amount = 0) are supported'
    );
  }

  const resolutionStatus = amount === full ? 'resolved_refund' : 'resolved_release';
  const { rows } = await db.query(
    `UPDATE disputes
     SET status = $1, resolution_amount_to_buyer = $2, resolved_by = $3, resolution_note = $4, resolved_at = now()
     WHERE id = $5 RETURNING *`,
    [resolutionStatus, amount, resolvedBy, resolutionNote || null, disputeId]
  );
  eventBus.emit(events.DISPUTE_RESOLVED, { disputeId, orderId: dispute.order_id, resolutionStatus, resolutionAmountToBuyer: amount });
  return rows[0];
}

/** FR-45f: the synchronous check payout.service.js's force-release MUST call before overriding a hold. */
async function hasOpenDispute(orderId) {
  const { rows } = await db.query(
    `SELECT 1 FROM disputes WHERE order_id = $1 AND status IN ('open', 'seller_responded') LIMIT 1`,
    [orderId]
  );
  return rows.length > 0;
}

/** FR-45, FR-50a: Exposed for payout.service.js's settlement calc — the resolved amount (if any) for the most recent dispute on this order. */
async function getResolvedResolutionAmount(orderId) {
  const { rows } = await db.query(
    `SELECT resolution_amount_to_buyer FROM disputes
     WHERE order_id = $1 AND status IN ('resolved_refund', 'resolved_release')
     ORDER BY resolved_at DESC LIMIT 1`,
    [orderId]
  );
  return rows[0] ? rows[0].resolution_amount_to_buyer : null;
}

module.exports = {
  fileDispute,
  submitCounterEvidence,
  getDisputeQueue,
  getDisputeEvidence,
  resolveDispute,
  hasOpenDispute,
  getResolvedResolutionAmount,
};
