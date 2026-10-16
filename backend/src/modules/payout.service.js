/**
 * modules/payout.service.js
 *
 * Owns: FR-45b to FR-45h (specs.md section "9a. Payout Hold Window")
 * Tables owned: payout_holds
 *
 * Cross-module dependencies OUT (one-directional, no cycles):
 * - orders.service.getCodAmountDue() for agreed_item_price at release time.
 * - disputes.service.hasOpenDispute() — FR-45f, a REQUIRED SYNCHRONOUS call
 *   before any force-release. Do not replace this with an event listener;
 *   FR-45f gates a decision inside the same request and must not depend on
 *   whether an async event has been processed yet.
 * - disputes.service.getResolvedResolutionAmount() to feed FR-50a's guard
 *   in settlement.service.calculateSettlement().
 * - settlement.service.calculateSettlement() at release time (FR-47).
 *
 * FR-45g (auto-pause on dispute filed) is the one place this module reacts
 * to an EVENT rather than a direct call — see the eventBus.on() below. This
 * is intentionally different from FR-45f: pausing a hold when a dispute is
 * filed is a reactive side effect, not a gate on an in-flight decision, so
 * the async event bus is an appropriate fit here (see lib/eventBus.js).
 *
 * startHold() is called ONLY from payments.service.confirmCodCollection()
 * (FR-38's trigger). Do not call it from anywhere else.
 */

const db = require('../db.service');
const orders = require('./orders.service');
const disputes = require('./disputes.service');
const settlement = require('./settlement.service');
const eventBus = require('../lib/eventBus');
const events = require('../lib/events');
const { NotFoundError, ValidationError, ForbiddenError } = require('../lib/errors');

// ---- FR-45g: reactive pause on dispute filed ----

eventBus.on(events.DISPUTE_FILED, async ({ orderId, disputeId }) => {
  try {
    await db.query(
      `UPDATE payout_holds SET state = 'paused_for_dispute', dispute_id = $1
       WHERE order_id = $2 AND state = 'held'`,
      [disputeId, orderId]
    );
  } catch (err) {
    // Listener must never throw back into the emitter (see lib/eventBus.js) — log and move on.
    // eslint-disable-next-line no-console
    console.error('Failed to pause payout hold for dispute', { orderId, disputeId, err });
  }
});

// ---- FR-45b, FR-45c: start hold ----

/** FR-45b: called ONLY from payments.service.confirmCodCollection() — see file header. */
async function startHold(orderId) {
  const holdWindowDays = Number(await settlement.getSetting('payout_hold_days')); // FR-45c
  const complaintWindowDays = Number(await settlement.getSetting('complaint_window_days'));
  const { rows } = await db.query(
    `INSERT INTO payout_holds (order_id, hold_started_at, hold_window_days, complaint_window_days, state)
     VALUES ($1, now(), $2, $3, 'held')
     ON CONFLICT (order_id) DO NOTHING
     RETURNING *`,
    [orderId, holdWindowDays, complaintWindowDays]
  );
  if (rows[0]) eventBus.emit(events.PAYOUT_HELD, { orderId });
  return rows[0] || null;
}

// ---- FR-45d: default release at end of full window ----

async function releasePayout(orderId, { releasedVia = 'scheduled' } = {}) {
  const { agreed_item_price: agreedItemPrice } = await orders.getCodAmountDue(orderId);
  const resolutionAmountToBuyer = await disputes.getResolvedResolutionAmount(orderId); // may be null (no dispute)

  const settlementRecord = await settlement.calculateSettlement(orderId, {
    agreedItemPrice,
    resolutionAmountToBuyer,
  }); // FR-47; throws NotYetSpecifiedError('FR-50a', ...) if a partial-refund case slips through

  const { rows } = await db.query(
    `UPDATE payout_holds SET state = $1, released_at = now() WHERE order_id = $2 RETURNING *`,
    [releasedVia === 'force' ? 'force_released' : 'released', orderId]
  );
  await orders.setOrderStatus(orderId, 'completed');
  eventBus.emit(
    releasedVia === 'force' ? events.PAYOUT_FORCE_RELEASED : events.PAYOUT_RELEASED,
    { orderId }
  );
  return { hold: rows[0], settlement: settlementRecord };
}

/**
 * FR-45d: the scheduled job entry point — intended to run on a cron/worker,
 * not from an HTTP route. No release happens outside this function or
 * forceReleasePayoutEarly() below.
 */
async function checkAndReleaseDuePayouts() {
  const { rows: due } = await db.query(
    `SELECT order_id FROM payout_holds
     WHERE state = 'held' AND hold_started_at + (hold_window_days || ' days')::interval <= now()`
  );
  const results = [];
  for (const { order_id: orderId } of due) {
    if (await disputes.hasOpenDispute(orderId)) continue; // defensive; FR-45g should have already paused this
    results.push(await releasePayout(orderId, { releasedVia: 'scheduled' }));
  }
  return results;
}

// ---- FR-45e, FR-45f: force release ----

/** FR-45e: admin can force-release early but MUST supply a reason. FR-45f: blocked while a dispute is open. */
async function forceReleasePayoutEarly(orderId, { adminId, reasonNote }) {
  if (!reasonNote || !reasonNote.trim()) {
    throw new ValidationError('A reason/note is required to force-release a payout (FR-45e)');
  }
  if (await disputes.hasOpenDispute(orderId)) { // FR-45f — required synchronous check, see file header
    throw new ForbiddenError('Cannot force-release while there is an open unresolved dispute on this order (FR-45f)');
  }

  await db.query(
    `UPDATE payout_holds SET force_released_by = $1, force_release_reason = $2 WHERE order_id = $3`,
    [adminId, reasonNote, orderId]
  );
  return releasePayout(orderId, { releasedVia: 'force' });
}

// ---- FR-45h / FR-44: combined admin view ----

/** FR-45h, FR-44: HELD orders + open dispute status in ONE view, not two separate screens. */
async function getHeldOrdersWithDisputeStatus() {
  const { rows } = await db.query(
    `SELECT ph.*, d.id AS open_dispute_id, d.status AS dispute_status
     FROM payout_holds ph
     LEFT JOIN disputes d ON d.order_id = ph.order_id AND d.status IN ('open', 'seller_responded')
     WHERE ph.state IN ('held', 'paused_for_dispute')
     ORDER BY ph.hold_started_at ASC`
  );
  return rows;
}

module.exports = {
  startHold,
  checkAndReleaseDuePayouts,
  forceReleasePayoutEarly,
  getHeldOrdersWithDisputeStatus,
};
