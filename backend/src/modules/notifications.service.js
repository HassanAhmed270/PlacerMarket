/**
 * FR-51 and FR-77d: notifications persist in their owning service; event listeners
 * enqueue durable work and the worker creates notification rows.
 */

const db = require('../db.service');
const eventBus = require('../lib/eventBus');
const events = require('../lib/events');
const queue = require('../lib/queue');

const NOTIFICATION_EVENTS = Object.freeze([
  events.SELLER_APPLICATION_STATUS_CHANGED,
  events.LISTING_STATUS_CHANGED,
  events.OFFER_CREATED,
  events.ORDER_STATUS_CHANGED,
  events.DELIVERY_STATUS_CHANGED,
  events.DISPUTE_RESOLVED,
]);

function jobKeys(eventName, payload) {
  const entityByEvent = {
    [events.SELLER_APPLICATION_STATUS_CHANGED]: ['seller-application', payload.applicationId],
    [events.LISTING_STATUS_CHANGED]: ['listing', payload.listingId],
    [events.OFFER_CREATED]: ['offer', payload.offerId],
    [events.ORDER_STATUS_CHANGED]: ['order', payload.orderId],
    [events.DELIVERY_STATUS_CHANGED]: ['order', payload.orderId],
    [events.DISPUTE_RESOLVED]: ['order', payload.orderId],
  };
  const [kind, id] = entityByEvent[eventName] || [];
  if (id === undefined || id === null || String(id).length === 0) {
    throw new TypeError(`Notification event ${eventName} is missing its entity ID.`);
  }
  const state = payload.decision || payload.status || payload.resolutionStatus || '';
  return {
    idempotencyKey: `${eventName}:${kind}:${id}:${state}`,
    orderingKey: `${kind}:${id}`,
  };
}

/** FR-51: create an in-app notification row. */
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

/** FR-51 and FR-77d: resolve recipients and write rows in the worker's job transaction. */
async function processNotificationJob(job, transactionDb) {
  if (!job || !NOTIFICATION_EVENTS.includes(job.eventName) || !job.payload || typeof job.payload !== 'object') {
    throw new TypeError('Unsupported notification job payload.');
  }

  let recipients;
  let eventType;
  switch (job.eventName) {
    case events.SELLER_APPLICATION_STATUS_CHANGED: {
      // cross-module notification-recipient read: seller_applications (owned by users.service.js)
      const result = await transactionDb.executeSql(
        'SELECT user_id FROM seller_applications WHERE id = $1', [job.payload.applicationId]
      );
      recipients = result.rows.map((row) => row.user_id);
      eventType = 'seller_app_status';
      break;
    }
    case events.LISTING_STATUS_CHANGED: {
      // cross-module notification-recipient read: listings (owned by listings.service.js)
      const result = await transactionDb.executeSql(
        'SELECT seller_id FROM listings WHERE id = $1', [job.payload.listingId]
      );
      recipients = result.rows.map((row) => row.seller_id);
      eventType = 'listing_status';
      break;
    }
    case events.OFFER_CREATED: {
      // cross-module notification-recipient read: listings (owned by listings.service.js)
      const result = await transactionDb.executeSql(
        'SELECT seller_id FROM listings WHERE id = $1', [job.payload.listingId]
      );
      recipients = result.rows.map((row) => row.seller_id);
      eventType = 'new_offer';
      break;
    }
    case events.ORDER_STATUS_CHANGED:
    case events.DELIVERY_STATUS_CHANGED:
    case events.DISPUTE_RESOLVED: {
      // cross-module notification-recipient read: orders (owned by orders.service.js)
      const result = await transactionDb.executeSql(
        'SELECT buyer_id, seller_id FROM orders WHERE id = $1', [job.payload.orderId]
      );
      recipients = result.rows.flatMap((row) => [row.buyer_id, row.seller_id]);
      eventType = job.eventName === events.ORDER_STATUS_CHANGED
        ? 'order_status'
        : job.eventName === events.DELIVERY_STATUS_CHANGED ? 'delivery_update' : 'dispute_update';
      break;
    }
    default:
      throw new TypeError('Unsupported notification event.');
  }

  for (const recipientId of new Set(recipients)) {
    await transactionDb.executeSql(
      'INSERT INTO notifications (user_id, event_type, payload) VALUES ($1, $2, $3)',
      [recipientId, eventType, JSON.stringify(job.payload)]
    );
  }
}

/** FR-77d: enqueue notification events without doing database writes in the web process. */
function registerListeners() {
  for (const eventName of NOTIFICATION_EVENTS) {
    eventBus.on(eventName, async (payload, context = {}) => {
      try {
        const keys = jobKeys(eventName, payload);
        const options = { ...keys };
        if (context.transaction) options.transaction = context.transaction;
        await queue.enqueue(queue.QUEUES.NOTIFICATIONS, { eventName, payload }, options);
      } catch (error) {
        if (context.transaction) throw error;
        console.error('Notification job enqueue failed', { eventName, code: error?.code || 'unknown' });
      }
    });
  }
}

registerListeners();

module.exports = {
  createNotification,
  getUserNotifications,
  markRead,
  processNotificationJob,
};
