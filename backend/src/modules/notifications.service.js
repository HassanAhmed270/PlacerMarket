/**
 * modules/notifications.service.js
 *
 * Owns: FR-51 (specs.md section "11. Notifications")
 * Tables owned: notifications
 *
 * This is the ONLY file that listens on lib/eventBus.js for the purpose of
 * turning platform events into user-facing notifications. Every other
 * service emits events (see lib/events.js) but does not need to know that
 * notifications.service.js exists — that's the whole point of the event
 * bus per the user's chosen pattern (see lib/eventBus.js header).
 *
 * sendNotification() is a stub for the actual delivery channel (push, SMS,
 * email, in-app badge) — not specified anywhere in specs.md yet, so this
 * only writes the row and marks it available for the frontend to poll/read;
 * wire up a real channel here once that's decided.
 */

const db = require('../db.service');
const eventBus = require('../lib/eventBus');
const events = require('../lib/events');

/** FR-51: create the notification row. */
async function createNotification(userId, eventType, payload) {
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, event_type, payload) VALUES ($1, $2, $3) RETURNING *`,
    [userId, eventType, JSON.stringify(payload)]
  );
  return rows[0];
}

/** FR-51: a user's notifications, optionally unread only. */
async function getUserNotifications(userId, { unreadOnly = false } = {}) {
  const { rows } = await db.query(
    unreadOnly
      ? 'SELECT * FROM notifications WHERE user_id = $1 AND is_read = false ORDER BY created_at DESC'
      : 'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return rows;
}

/** FR-51: mark a notification read. */
async function markRead(notificationId) {
  await db.query('UPDATE notifications SET is_read = true WHERE id = $1', [notificationId]);
}

/**
 * Map of eventBus event name -> event_type string stored on the
 * notifications row (kept short/stable per schema.sql's example values —
 * do not just dump the raw eventBus name here, it's more verbose than the
 * FR-51 categories: seller application status, listing approval/rejection,
 * new message/offer, order status changes, delivery updates, dispute updates).
 *
 * NOTE: each handler below needs the recipient user id, which isn't always
 * on the raw event payload (e.g. ORDER_STATUS_CHANGED only carries orderId).
 * TODO: resolve recipient(s) per event type (e.g. look up order.buyer_id +
 * order.seller_id) once the exact "who gets notified for what" list is
 * confirmed — stubbed as a direct db read here to keep this file working
 * without importing orders.service.js back (would risk a circular require
 * once orders-side events grow).
 */
function registerListeners() {
  eventBus.on(events.SELLER_APPLICATION_STATUS_CHANGED, async (payload) => {
    // applicationId only on payload — resolve the applicant's user_id here.
    const { rows } = await db.query('SELECT user_id FROM seller_applications WHERE id = $1', [payload.applicationId]);
    if (rows[0]) await createNotification(rows[0].user_id, 'seller_app_status', payload);
  });

  eventBus.on(events.LISTING_STATUS_CHANGED, async (payload) => {
    const { rows } = await db.query('SELECT seller_id FROM listings WHERE id = $1', [payload.listingId]);
    if (rows[0]) await createNotification(rows[0].seller_id, 'listing_status', payload);
  });

  eventBus.on(events.OFFER_CREATED, async (payload) => {
    const { rows } = await db.query('SELECT seller_id FROM listings WHERE id = $1', [payload.listingId]);
    if (rows[0]) await createNotification(rows[0].seller_id, 'new_offer', payload);
  });

  eventBus.on(events.ORDER_STATUS_CHANGED, async (payload) => {
    const { rows } = await db.query('SELECT buyer_id, seller_id FROM orders WHERE id = $1', [payload.orderId]);
    if (rows[0]) {
      await createNotification(rows[0].buyer_id, 'order_status', payload);
      await createNotification(rows[0].seller_id, 'order_status', payload);
    }
  });

  eventBus.on(events.DELIVERY_STATUS_CHANGED, async (payload) => {
    const { rows } = await db.query('SELECT buyer_id, seller_id FROM orders WHERE id = $1', [payload.orderId]);
    if (rows[0]) {
      await createNotification(rows[0].buyer_id, 'delivery_update', payload);
      await createNotification(rows[0].seller_id, 'delivery_update', payload);
    }
  });

  eventBus.on(events.DISPUTE_RESOLVED, async (payload) => {
    const { rows } = await db.query('SELECT buyer_id, seller_id FROM orders WHERE id = $1', [payload.orderId]);
    if (rows[0]) {
      await createNotification(rows[0].buyer_id, 'dispute_update', payload);
      await createNotification(rows[0].seller_id, 'dispute_update', payload);
    }
  });
}

registerListeners();

module.exports = { createNotification, getUserNotifications, markRead };
