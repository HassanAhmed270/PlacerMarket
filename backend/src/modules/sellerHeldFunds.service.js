/**
 * FR-65: holds seller proceeds when identity verification is missing.
 * Owns: seller_held_funds
 */

const db = require('../db.service');
const orders = require('./orders.service');
const listings = require('./listings.service');
const users = require('./users.service');
const reservations = require('./reservations.service');
const escrowPayments = require('./escrowPayments.service');
const sellerPayouts = require('./sellerPayouts.service');
const moneyAudit = require('./moneyAudit.service');
const eventBus = require('../lib/eventBus');
const events = require('../lib/events');
const {
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
  ConfigurationError,
} = require('../lib/errors');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REMINDERS = [
  { days: 7, column: 'reminder_7_sent_at' },
  { days: 30, column: 'reminder_30_sent_at' },
  { days: 90, column: 'reminder_90_sent_at' },
];

function assertUuid(id, name) {
  if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
    throw new ValidationError(`${name} must be a valid UUID.`);
  }
}

async function lockHeldFundsOrderContext(client, heldFunds) {
  const context = await orders.getMoneyLockContext(client, heldFunds.order_id);
  if (!context) throw new NotFoundError('order', heldFunds.order_id);
  if (!context.reservation_id) throw new NotFoundError('reservation-backed order', heldFunds.order_id);

  if (!(await listings.lockListingForMoneyAction(client, context.listing_id))) {
    throw new ConflictError('The order listing is no longer available.');
  }
  if (!(await users.lockBuyerForMoneyAction(client, context.buyer_id))) {
    throw new ConflictError('The order buyer is no longer available.');
  }

  const order = await orders.lockReservationOrderForPayout(client, heldFunds.order_id);
  if (!order || order.seller_id !== heldFunds.seller_id ||
      order.listing_id !== context.listing_id || order.buyer_id !== context.buyer_id ||
      order.reservation_id !== context.reservation_id) {
    throw new ConflictError('The order changed before held-funds decision.');
  }

  const reservation = await reservations.lockReservationForPayout(client, order.reservation_id);
  if (!reservation || reservation.listing_id !== order.listing_id || reservation.status !== 'paid') {
    throw new ConflictError('The order does not have a paid reservation.');
  }

  const payments = await escrowPayments.lockPaymentsForOrder(client, heldFunds.order_id);
  const payment = payments.find((row) => row.status === 'succeeded');
  if (!payment) throw new ConflictError('Order must have a succeeded payment.');

  return { payment };
}

/** FR-65: record proceeds as held when the seller profile is not identity-verified. */
async function holdFundsForUnverifiedSeller(client, { orderId, sellerId, amount, currency, heldBy }) {
  const { rows } = await client.query(
    `INSERT INTO seller_held_funds (order_id, seller_id, amount, currency, held_by)
     VALUES ($1, $2, $3::numeric, $4, $5)
     RETURNING id, order_id, seller_id, amount::text, currency, held_by, held_at, state`,
    [orderId, sellerId, amount, currency, heldBy]
  );
  return rows[0];
}

/** FR-65: list held-funds records for Admin review with bounded, validated filters. */
async function listHeldFunds(query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new ValidationError('Query filters must be an object.');
  }

  let stateFilter = null;
  if (query.state !== undefined && query.state !== null && query.state !== '') {
    if (!['held', 'released'].includes(query.state)) {
      throw new ValidationError('state must be held or released.');
    }
    stateFilter = query.state;
  }

  let needsDecision = false;
  if (query.needsDecision !== undefined && query.needsDecision !== null && query.needsDecision !== '') {
    if (![true, false, 'true', 'false'].includes(query.needsDecision)) {
      throw new ValidationError('needsDecision must be true or false.');
    }
    needsDecision = query.needsDecision === true || query.needsDecision === 'true';
  }

  let limit = 20;
  if (query.limit !== undefined && query.limit !== null && query.limit !== '') {
    const parsedLimit = Number(query.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw new ValidationError('limit must be an integer from 1 to 100.');
    }
    limit = parsedLimit;
  }

  const values = [];
  const conditions = [];
  if (stateFilter) {
    values.push(stateFilter);
    conditions.push(`state = $${values.length}`);
  }
  if (needsDecision) conditions.push('needs_decision_at IS NOT NULL');
  values.push(limit);

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT id, order_id, seller_id, amount::text, currency, held_by, held_at,
            reminder_7_sent_at, reminder_30_sent_at, reminder_90_sent_at,
            needs_decision_at, state, released_payout_id, released_by, released_at,
            last_decision_note, last_decision_by, last_decision_at
     FROM seller_held_funds
     ${whereClause}
     ORDER BY held_at DESC, id DESC
     LIMIT $${values.length}`,
    values
  );
  return { heldFunds: rows };
}

/** FR-65: release verified held funds or record an Admin decision to keep them held. */
async function decideHeldFunds(id, adminId, sessionId, input) {
  assertUuid(id, 'id');
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Request body must be an object.');
  }
  const { decision, note, stepUpGrant } = input;
  if (!['release', 'keep_held'].includes(decision)) {
    throw new ValidationError('decision must be release or keep_held.');
  }
  let trimmedNote = null;
  if (decision === 'keep_held') {
    if (typeof note !== 'string') throw new ValidationError('A note is required to keep funds held.');
    trimmedNote = note.trim();
    if (trimmedNote.length < 3 || trimmedNote.length > 300) {
      throw new ValidationError('note must be 3 to 300 characters.');
    }
  }
  if (!stepUpGrant || typeof stepUpGrant !== 'string') {
    throw new ForbiddenError('A valid step-up grant is required.');
  }

  return db.withTransaction(async (client) => {
    const { rows: heldRows } = await client.query(
      `SELECT id, order_id, seller_id, amount::text, currency, state
       FROM seller_held_funds
       WHERE id = $1
       FOR UPDATE`,
      [id]
    );
    const heldFunds = heldRows[0];
    if (!heldFunds) throw new NotFoundError('seller_held_funds', id);
    if (heldFunds.state !== 'held') throw new ConflictError('Held funds have already been released.');

    const { payment } = await lockHeldFundsOrderContext(client, heldFunds);
    if (decision === 'release' &&
        !(await users.isSellerIdVerifiedWithClient(client, heldFunds.seller_id))) {
      throw new ConflictError('Seller identity verification is required to release held funds.');
    }

    await users.consumeStepUpGrantWithClient(client, adminId, sessionId, 'payout.record', stepUpGrant);

    if (decision === 'release') {
      const payout = await sellerPayouts.createInitiatedPayout(client, {
        orderId: heldFunds.order_id,
        sellerId: heldFunds.seller_id,
        amount: heldFunds.amount,
        currency: heldFunds.currency,
        initiatedBy: adminId,
      });
      if (!payout) throw new ConflictError('Held funds could not create a payout.');

      const { rows: updatedRows } = await client.query(
        `UPDATE seller_held_funds
         SET state = 'released', released_payout_id = $2,
             released_by = $3, released_at = now()
         WHERE id = $1 AND state = 'held'
         RETURNING id, order_id, seller_id, amount::text, currency, held_by, held_at,
                   reminder_7_sent_at, reminder_30_sent_at, reminder_90_sent_at,
                   needs_decision_at, state, released_payout_id, released_by, released_at,
                   last_decision_note, last_decision_by, last_decision_at`,
        [id, payout.id, adminId]
      );
      if (!updatedRows[0]) throw new ConflictError('Held-funds state changed before release.');

      await moneyAudit.recordMoneyAuditEvent(client, {
        actorId: adminId,
        action: 'seller_funds_released',
        orderId: heldFunds.order_id,
        paymentId: payment.id,
        metadata: {
          heldFundsId: id,
          payoutId: payout.id,
          attempt: payout.attempt,
          amount: heldFunds.amount,
          currency: heldFunds.currency,
        },
      });
      return {
        heldFunds: updatedRows[0],
        payout: {
          id: payout.id,
          attempt: payout.attempt,
          status: payout.status,
          amount: payout.amount,
          currency: payout.currency,
        },
      };
    }

    const { rows: updatedRows } = await client.query(
      `UPDATE seller_held_funds
       SET last_decision_note = $2, last_decision_by = $3, last_decision_at = now()
       WHERE id = $1 AND state = 'held'
       RETURNING id, order_id, seller_id, amount::text, currency, held_by, held_at,
                 reminder_7_sent_at, reminder_30_sent_at, reminder_90_sent_at,
                 needs_decision_at, state, released_payout_id, released_by, released_at,
                 last_decision_note, last_decision_by, last_decision_at`,
      [id, trimmedNote, adminId]
    );
    if (!updatedRows[0]) throw new ConflictError('Held-funds state changed before decision.');

    await moneyAudit.recordMoneyAuditEvent(client, {
      actorId: adminId,
      action: 'seller_funds_keep_held',
      orderId: heldFunds.order_id,
      paymentId: payment.id,
      reason: trimmedNote,
      metadata: {
        heldFundsId: id,
        amount: heldFunds.amount,
        currency: heldFunds.currency,
      },
    });
    return { heldFunds: updatedRows[0], payout: null };
  });
}

/** FR-65, FR-51: enqueue due seller reminders and flag funds needing an Admin decision. */
async function processReminders() {
  let processedRecords = 0;
  while (true) {
    const processed = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT id, order_id, seller_id
         FROM seller_held_funds
         WHERE state = 'held'
           AND (
             (held_at <= now() - INTERVAL '7 days' AND reminder_7_sent_at IS NULL) OR
             (held_at <= now() - INTERVAL '30 days' AND reminder_30_sent_at IS NULL) OR
             (held_at <= now() - INTERVAL '90 days' AND reminder_90_sent_at IS NULL) OR
             (held_at <= now() - INTERVAL '180 days' AND needs_decision_at IS NULL)
           )
         ORDER BY held_at, id
         LIMIT 1
         FOR UPDATE SKIP LOCKED`
      );
      const heldFunds = rows[0];
      if (!heldFunds) return false;

      let updated = false;
      for (const reminder of REMINDERS) {
        const { rows: reminderRows } = await client.query(
          `UPDATE seller_held_funds
           SET ${reminder.column} = now()
           WHERE id = $1 AND ${reminder.column} IS NULL
             AND held_at <= now() - ($2::text || ' days')::interval
           RETURNING id`,
          [heldFunds.id, reminder.days]
        );
        if (!reminderRows[0]) continue;
        updated = true;
        const registered = await eventBus.emitAsync(
          events.HELD_FUNDS_REMINDER,
          {
            heldFundsId: heldFunds.id,
            orderId: heldFunds.order_id,
            sellerId: heldFunds.seller_id,
            milestone: reminder.days,
          },
          { transaction: client }
        );
        if (!registered) {
          throw new ConfigurationError('Held-funds reminder notification listener is not registered.');
        }
      }

      const { rows: decisionRows } = await client.query(
        `UPDATE seller_held_funds
         SET needs_decision_at = now()
         WHERE id = $1 AND needs_decision_at IS NULL
           AND held_at <= now() - INTERVAL '180 days'
         RETURNING id`,
        [heldFunds.id]
      );
      if (decisionRows[0]) updated = true;
      if (!updated) throw new ConflictError('Due held-funds reminder state did not advance.');
      return true;
    });
    if (!processed) break;
    processedRecords += 1;
  }
  return processedRecords;
}

module.exports = {
  holdFundsForUnverifiedSeller,
  listHeldFunds,
  decideHeldFunds,
  processReminders,
};
