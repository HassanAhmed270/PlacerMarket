/**
 * FR-51 and FR-77d: notifications persist in their owning service; event listeners
 * enqueue durable work and the worker creates notification rows.
 */

const db = require('../db.service');
const eventBus = require('../lib/eventBus');
const events = require('../lib/events');
const queue = require('../lib/queue');
const { encryptEmailPayload } = require('../lib/emailQueuePayload');

const NOTIFICATION_EVENTS = Object.freeze([
  events.SELLER_APPLICATION_STATUS_CHANGED,
  events.LISTING_STATUS_CHANGED,
  events.LISTING_REVISION_DECIDED,
  events.OFFER_CREATED,
  events.ORDER_STATUS_CHANGED,
  events.DELIVERY_STATUS_CHANGED,
  events.DISPUTE_RESOLVED,
  events.MESSAGE_SENT,
]);

function jobKeys(eventName, payload) {
  if (eventName === events.MESSAGE_SENT) {
    if (!payload.messageId || !payload.conversationId) {
      throw new TypeError('Message notification event is missing its message or conversation ID.');
    }
    return {
      idempotencyKey: `message:${payload.messageId}`,
      orderingKey: `conversation:${payload.conversationId}`,
    };
  }
  const entityByEvent = {
    [events.SELLER_APPLICATION_STATUS_CHANGED]: ['seller-application', payload.applicationId],
    [events.LISTING_STATUS_CHANGED]: ['listing', payload.listingId],
    [events.LISTING_REVISION_DECIDED]: ['listing-revision', payload.revisionId],
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
async function createNotification(userId, eventType, payload, dedupeKey = null) {
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, event_type, payload, dedupe_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [userId, eventType, JSON.stringify(payload), dedupeKey]
  );
  return rows[0] || null;
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
async function markRead(notificationId, userId) {
  const { rowCount } = await db.query(
    'UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2',
    [notificationId, userId]
  );
  return rowCount > 0;
}

/** FR-51 and FR-77d: resolve recipients and write rows in the worker's job transaction. */
async function processNotificationJob(job, transactionDb) {
  const messageEmailCheck = job?.eventName === 'conversation.message_email_check';
  if (!job || (!NOTIFICATION_EVENTS.includes(job.eventName) && !messageEmailCheck) ||
      !job.payload || typeof job.payload !== 'object') {
    throw new TypeError('Unsupported notification job payload.');
  }

  if (job.eventName === events.MESSAGE_SENT) {
    const { rows: conversations } = await transactionDb.executeSql(
      `SELECT buyer_id, seller_id FROM conversations WHERE id = $1`,
      [job.payload.conversationId]
    );
    const conversation = conversations[0];
    if (!conversation) return;
    const { rows: messages } = await transactionDb.executeSql(
      `SELECT id, sender_id FROM messages
       WHERE id = $1 AND conversation_id = $2`,
      [job.payload.messageId, job.payload.conversationId]
    );
    const message = messages[0];
    if (!message) return;
    if (message.sender_id !== conversation.buyer_id && message.sender_id !== conversation.seller_id) {
      throw new TypeError('Message sender is not a conversation participant.');
    }
    const recipientId = message.sender_id === conversation.buyer_id
      ? conversation.seller_id
      : conversation.buyer_id;
    await transactionDb.executeSql(
      `INSERT INTO notifications (user_id, event_type, payload, dedupe_key)
       VALUES ($1, 'new_message', $2, $3)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [
        recipientId,
        JSON.stringify({ conversationId: job.payload.conversationId }),
        `message:${message.id}`,
      ]
    );
    await queue.enqueue(queue.QUEUES.NOTIFICATIONS, {
      eventName: 'conversation.message_email_check',
      payload: { conversationId: job.payload.conversationId, messageId: message.id },
    }, {
      idempotencyKey: `message-email-check:${message.id}`,
      orderingKey: `conversation-email:${job.payload.conversationId}`,
      transaction: transactionDb,
      startAfter: '15 minutes',
    });
    return;
  }

  if (messageEmailCheck) {
    const { rows: eligibleMessages } = await transactionDb.executeSql(
      `SELECT m.id AS message_id, c.id AS conversation_id,
              CASE WHEN m.sender_id = c.buyer_id THEN c.seller_id ELSE c.buyer_id END AS recipient_id,
              u.email
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN users u ON u.id = CASE WHEN m.sender_id = c.buyer_id THEN c.seller_id ELSE c.buyer_id END
       WHERE c.id = $1 AND m.id = $2 AND m.read_at IS NULL
         AND m.sender_id IN (c.buyer_id, c.seller_id)
         AND m.created_at <= now() - interval '15 minutes'`,
      [job.payload.conversationId, job.payload.messageId]
    );
    const eligible = eligibleMessages[0];
    if (!eligible?.email) return;
    const { rows: throttleRows } = await transactionDb.executeSql(
      `INSERT INTO conversation_email_throttles (conversation_id, last_queued_at, last_message_id)
       VALUES ($1, now(), $2)
       ON CONFLICT (conversation_id) DO UPDATE
       SET last_queued_at = EXCLUDED.last_queued_at,
           last_message_id = EXCLUDED.last_message_id
       WHERE conversation_email_throttles.last_queued_at <= now() - interval '1 hour'
       RETURNING conversation_id`,
      [eligible.conversation_id, eligible.message_id]
    );
    if (!throttleRows[0]) return;
    const encryptedPayload = encryptEmailPayload({
      to: eligible.email,
      subject: 'You have an unread Poshaak message',
      text: 'You have an unread message on Poshaak. Sign in to view your conversation.',
    });
    await queue.enqueue(queue.QUEUES.EMAIL, { encryptedPayload }, {
      idempotencyKey: `conversation-unread:${eligible.conversation_id}:${eligible.message_id}`,
      orderingKey: `conversation-email-delivery:${eligible.conversation_id}`,
      transaction: transactionDb,
    });
    return;
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
    case events.LISTING_REVISION_DECIDED: {
      // cross-module notification-recipient read: listing_revisions (owned by listingRevisions.service.js)
      const result = await transactionDb.executeSql(
        'SELECT seller_id FROM listing_revisions WHERE id = $1', [job.payload.revisionId]
      );
      recipients = result.rows.map((row) => row.seller_id);
      eventType = 'listing_revision_status';
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
