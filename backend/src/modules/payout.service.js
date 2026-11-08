/**
 * modules/payout.service.js
 *
 * Owns: FR-45b to FR-45h (specs.md section "9a. Payout Hold Window") and FR-65 reservation payout release.
 * Tables owned: payout_holds
 *
 * Cross-module dependencies OUT (one-directional, no cycles):
 * - orders.service.getCodAmountDue() for legacy agreed_item_price at release time.
 * - listings, users, orders, reservations and escrowPayments owner functions
 *   for canonical locking and the reservation-backed manual release.
 * - settlement.service.calculateReservationSettlement() and
 *   recordReservationSettlement() for decimal-string math and its record.
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
const listings = require('./listings.service');
const reservations = require('./reservations.service');
const users = require('./users.service');
const escrowPayments = require('./escrowPayments.service');
const eventBus = require('../lib/eventBus');
const events = require('../lib/events');
const { NotFoundError, ValidationError, ForbiddenError, ConflictError } = require('../lib/errors');

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

/** FR-45: resume or block a reservation payout atomically with dispute resolution. */
async function handleDisputeResolved({
  disputeId, orderId, resolutionStatus,
}, context = {}) {
  const { transaction: client, resolvedBy } = context;
  if (!client) {
    throw new TypeError('Dispute resolution payout effects require the resolution transaction.');
  }

  const order = await orders.getMoneyLockContext(client, orderId);
  if (!order || !order.reservation_id) return;

  const { rows: holdRows } = await client.query(
    `SELECT state
     FROM payout_holds
     WHERE order_id = $1
     FOR UPDATE`,
    [orderId]
  );
  const hold = holdRows[0];

  if (resolutionStatus === 'resolved_release') {
    if (!hold || hold.state !== 'paused_for_dispute') return;
    const { rows: resumedRows } = await client.query(
      `UPDATE payout_holds
       SET state = 'held'
       WHERE order_id = $1 AND state = 'paused_for_dispute'
       RETURNING order_id`,
      [orderId]
    );
    if (!resumedRows[0]) return;
    await escrowPayments.recordDisputeResolutionAuditEvent(client, {
      orderId, adminId: resolvedBy, disputeId, resolutionStatus,
    });
    return;
  }

  if (resolutionStatus !== 'resolved_refund') return;

  if (hold && hold.state === 'held') {
    await client.query(
      `UPDATE payout_holds
       SET state = 'paused_for_dispute', dispute_id = $1
       WHERE order_id = $2 AND state = 'held'`,
      [disputeId, orderId]
    );
  }

  const auditRecorded = await escrowPayments.recordDisputeResolutionAuditEvent(client, {
    orderId, adminId: resolvedBy, disputeId, resolutionStatus,
  });
  if (!auditRecorded) return;

  const exceptionListenerRegistered = await eventBus.emitAsync(
    events.DISPUTE_REFUND_EXCEPTION_REQUIRED,
    { orderId, disputeId, resolvedBy },
    { transaction: client }
  );
  if (!exceptionListenerRegistered) {
    throw new TypeError('The delivery exception owner is not listening for dispute refund exceptions.');
  }
}

eventBus.on(events.DISPUTE_RESOLVED, handleDisputeResolved);

// ---- FR-45b, FR-45c: start hold ----

/** FR-45b: called ONLY from payments.service.confirmCodCollection() — see file header. */
async function startHold(orderId) {
  await orders.assertLegacyOrder(orderId);
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

/** FR-45b, FR-45c, FR-68: start a reservation-order hold inside its delivery transaction. */
async function startHoldForReservationOrder(client, orderId) {
  const settings = await settlement.getSettingsForTransaction(client, [
    'payout_hold_days',
    'complaint_window_days',
  ]);
  const holdWindowDays = Number(settings.payout_hold_days);
  const complaintWindowDays = Number(settings.complaint_window_days);
  if (!Number.isSafeInteger(holdWindowDays) || holdWindowDays <= 0 ||
      !Number.isSafeInteger(complaintWindowDays) || complaintWindowDays <= 0) {
    throw new ValidationError('Payout hold and complaint windows must be positive whole days.');
  }
  const { rows } = await client.query(
    `INSERT INTO payout_holds (order_id, hold_started_at, hold_window_days, complaint_window_days, state)
     VALUES ($1, now(), $2, $3, 'held')
     ON CONFLICT (order_id) DO NOTHING
     RETURNING order_id`,
    [orderId, holdWindowDays, complaintWindowDays]
  );
  return rows.length > 0;
}

/** FR-45b, FR-45c, FR-68: read a reservation-order hold inside its delivery transaction. */
async function getReservationOrderHold(client, orderId) {
  const { rows } = await client.query(
    `SELECT state, hold_started_at, hold_window_days, complaint_window_days
     FROM payout_holds
     WHERE order_id = $1`,
    [orderId]
  );
  if (!rows[0]) throw new NotFoundError('payout_hold', orderId);
  return rows[0];
}

/** FR-34: return payout hold states for a batch of seller order reads. */
async function getSellerOrderHoldStates(orderIds) {
  if (!orderIds.length) return [];
  const { rows } = await db.read(
    `SELECT order_id, state
     FROM payout_holds
     WHERE order_id = ANY($1::uuid[])`,
    [orderIds]
  );
  return rows.map((row) => ({ orderId: row.order_id, state: row.state }));
}

/** FR-68: read a payout hold and compute release eligibility time using PostgreSQL timestamp arithmetic. */
async function getAdminOrderHoldSnapshot(orderId, deliveredAt) {
  const { rows } = await db.read(
    `SELECT state, hold_started_at, hold_window_days, complaint_window_days,
            released_at,
            CASE WHEN $2::timestamptz IS NULL THEN NULL
                 ELSE GREATEST(
                   hold_started_at + (hold_window_days::text || ' days')::interval,
                   $2::timestamptz + (complaint_window_days::text || ' days')::interval
                 )
            END AS earliest_release_at
     FROM payout_holds
     WHERE order_id = $1`,
    [orderId, deliveredAt]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    state: row.state,
    holdStartedAt: row.hold_started_at,
    holdWindowDays: row.hold_window_days,
    complaintWindowDays: row.complaint_window_days,
    earliestReleaseAt: row.earliest_release_at,
    releasedAt: row.released_at,
  };
}

// ---- FR-45d: default release at end of full window ----

async function releasePayout(orderId, { releasedVia = 'scheduled' } = {}) {
  await orders.assertLegacyOrder(orderId);
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
 * FR-45d: the legacy scheduled job entry point — intended to run on a
 * cron/worker, not from an HTTP route.
 */
async function checkAndReleaseDuePayouts() {
  const { rows: due } = await db.query(
    `SELECT ph.order_id
     FROM payout_holds ph
     JOIN orders o ON o.id = ph.order_id
     WHERE ph.state = 'held'
       AND ph.hold_started_at + (ph.hold_window_days || ' days')::interval <= now()
       AND o.reservation_id IS NULL`
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
  await orders.assertLegacyOrder(orderId);
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

function validateManualPayoutRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['payoutReference', 'note'].includes(key))) {
    throw new ValidationError('Only payoutReference and note are accepted.');
  }
  const { payoutReference, note } = input;
  if (typeof payoutReference !== 'string' || typeof note !== 'string') {
    throw new ValidationError('payoutReference and note are required.');
  }
  const trimmedReference = payoutReference.trim();
  const trimmedNote = note.trim();
  if (trimmedReference.length < 3 || trimmedReference.length > 100) {
    throw new ValidationError('payoutReference must be 3 to 100 characters.');
  }
  if (trimmedNote.length < 3 || trimmedNote.length > 500) {
    throw new ValidationError('note must be 3 to 500 characters.');
  }
  return { payoutReference: trimmedReference, note: trimmedNote };
}

/** FR-65: manually record the Admin's reservation-backed seller payout. */
async function releaseReservationPayout(orderId, adminId, input) {
  const { payoutReference, note } = validateManualPayoutRequest(input);
  const result = await db.withTransaction(async (client) => {
    const context = await orders.getMoneyLockContext(client, orderId);
    if (!context) throw new NotFoundError('order', orderId);
    if (!context.reservation_id) throw new NotFoundError('reservation-backed order', orderId);

    if (!(await listings.lockListingForMoneyAction(client, context.listing_id))) {
      throw new ConflictError('The order listing is no longer available.');
    }
    if (!(await users.lockBuyerForMoneyAction(client, context.buyer_id))) {
      throw new ConflictError('The order buyer is no longer available.');
    }

    const order = await orders.lockReservationOrderForPayout(client, orderId);
    if (!order || order.listing_id !== context.listing_id ||
        order.buyer_id !== context.buyer_id || order.reservation_id !== context.reservation_id) {
      throw new ConflictError('The order changed before payout release.');
    }
    if (order.status !== 'held' || !order.delivered_at) {
      throw new ConflictError('Only a delivered held order can be released.');
    }

    const reservation = await reservations.lockReservationForPayout(client, order.reservation_id);
    if (!reservation || reservation.listing_id !== order.listing_id || reservation.status !== 'paid') {
      throw new ConflictError('The order does not have a paid reservation.');
    }

    const paymentRows = await escrowPayments.lockPaymentsForOrder(client, orderId);
    const succeededPayments = paymentRows.filter((payment) => payment.status === 'succeeded');
    if (succeededPayments.length !== 1) {
      throw new ConflictError('The order must have exactly one succeeded payment.');
    }
    const payment = succeededPayments[0];
    const expiredRefunds = await escrowPayments.assertNoOpenManualRefund(client, orderId, adminId);

    const { rows: holdRows } = await client.query(
      `SELECT order_id, state, hold_started_at, hold_window_days,
              complaint_window_days, released_at
       FROM payout_holds
       WHERE order_id = $1
       FOR UPDATE`,
      [orderId]
    );
    if (holdRows.length !== 1) throw new ConflictError('The order must have exactly one payout hold.');
    const hold = holdRows[0];
    if (hold.state === 'paused_for_dispute') {
      throw new ConflictError('A dispute is open for this order; payout release is blocked.');
    }
    if (hold.state !== 'held') {
      throw new ConflictError('The payout hold is not in the held state.');
    }
    if (await disputes.hasOpenDisputeInTransaction(client, orderId)) {
      throw new ConflictError('A dispute is open for this order; payout release is blocked.');
    }

    const { rows: timingRows } = await client.query(
      `SELECT GREATEST(
                $1::timestamptz + ($2::text || ' days')::interval,
                $3::timestamptz + ($4::text || ' days')::interval
              ) AS earliest_release_at,
              now() >= GREATEST(
                $1::timestamptz + ($2::text || ' days')::interval,
                $3::timestamptz + ($4::text || ' days')::interval
              ) AS windows_elapsed`,
      [hold.hold_started_at, hold.hold_window_days, order.delivered_at, hold.complaint_window_days]
    );
    const timing = timingRows[0];
    if (!timing.windows_elapsed) {
      throw new ConflictError(
        `Payout windows have not elapsed; earliest release time is ${new Date(timing.earliest_release_at).toISOString()}.`
      );
    }

    const settings = await settlement.getSettingsForTransaction(client, ['commission_percent']);
    const amounts = settlement.calculateReservationSettlement(
      reservation.item_price_snapshot,
      settings.commission_percent
    );
    await settlement.recordReservationSettlement(client, orderId, adminId, amounts);
    const completedOrder = await orders.completeReservationPayoutOrder(client, orderId);
    if (!completedOrder) throw new ConflictError('The order state changed before payout release.');

    const { rows: releasedRows } = await client.query(
      `UPDATE payout_holds
       SET state = 'released', released_at = now()
       WHERE order_id = $1 AND state = 'held'
       RETURNING released_at`,
      [orderId]
    );
    if (!releasedRows[0]) throw new ConflictError('The payout hold changed before release.');

    await escrowPayments.recordManualSellerPayout(client, {
      orderId,
      paymentId: payment.id,
      adminId,
      payoutReference,
      note,
      itemPrice: reservation.item_price_snapshot,
      deliveryFee: reservation.delivery_fee_snapshot,
      sellerNetAmount: amounts.sellerNetAmount,
      commissionAmount: amounts.commissionAmount,
      currency: reservation.currency,
    });

    return {
      orderId,
      status: 'completed',
      payout: {
        sellerNetAmount: amounts.sellerNetAmount,
        commissionAmount: amounts.commissionAmount,
        currency: reservation.currency,
      },
      releasedAt: releasedRows[0].released_at,
      payoutReference,
      expiredRefunds,
    };
  });
  escrowPayments.notifyRefundStatusChanges(result.expiredRefunds);
  const { expiredRefunds, ...response } = result;
  eventBus.emit(events.PAYOUT_RELEASED, { orderId });
  return response;
}

/** FR-65: read payout release state through the payout-holds owner in a caller transaction. */
async function isOrderPayoutReleased(client, orderId) {
  const { rows } = await client.query(
    `SELECT state, released_at
     FROM payout_holds
     WHERE order_id = $1`,
    [orderId]
  );
  return Boolean(rows[0] && (
    rows[0].released_at || ['released', 'force_released'].includes(rows[0].state)
  ));
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
  startHoldForReservationOrder,
  getReservationOrderHold,
  getSellerOrderHoldStates,
  getAdminOrderHoldSnapshot,
  checkAndReleaseDuePayouts,
  forceReleasePayoutEarly,
  releaseReservationPayout,
  isOrderPayoutReleased,
  handleDisputeResolved,
  getHeldOrdersWithDisputeStatus,
};
