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
  events.LISTING_REVISION_BLOCKED_BY_RESERVATION,
  events.OFFER_CREATED,
  events.ORDER_STATUS_CHANGED,
  events.ORDER_FUNDED,
  events.ORDER_CANCELLED,
  events.ORDER_AUTO_CANCELLED,
  events.ORDER_HANDED_OVER,
  events.ORDER_DELIVERED,
  events.DELIVERY_STATUS_CHANGED,
  events.DISPUTE_RESOLVED,
  events.DISPUTE_FILED,
  events.DISPUTE_RESOLUTION_COMMITTED,
  events.PAYOUT_RELEASED,
  events.PAYOUT_FORCE_RELEASED,
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
  if ([events.DISPUTE_FILED, events.DISPUTE_RESOLUTION_COMMITTED].includes(eventName)) {
    if (!payload.disputeId || !payload.orderId) {
      throw new TypeError('Dispute notification event is missing its dispute or order ID.');
    }
    return {
      idempotencyKey: `${eventName}:${payload.disputeId}`,
      orderingKey: `order:${payload.orderId}`,
    };
  }
  const entityByEvent = {
    [events.SELLER_APPLICATION_STATUS_CHANGED]: ['seller-application', payload.applicationId],
    [events.LISTING_STATUS_CHANGED]: ['listing', payload.listingId],
    [events.LISTING_REVISION_DECIDED]: ['listing-revision', payload.revisionId],
    [events.LISTING_REVISION_BLOCKED_BY_RESERVATION]: ['listing-revision-blocked', payload.revisionId],
    [events.OFFER_CREATED]: ['offer', payload.offerId],
    [events.ORDER_STATUS_CHANGED]: ['order', payload.orderId],
    [events.ORDER_FUNDED]: ['order-funded', payload.orderId],
    [events.ORDER_CANCELLED]: ['order-cancelled', payload.orderId],
    [events.ORDER_AUTO_CANCELLED]: ['order-auto-cancelled', payload.orderId],
    [events.ORDER_HANDED_OVER]: ['order-handed-over', payload.orderId],
    [events.ORDER_DELIVERED]: ['order-delivered', payload.orderId],
    [events.DELIVERY_STATUS_CHANGED]: ['order', payload.orderId],
    [events.DISPUTE_RESOLVED]: ['order', payload.orderId],
    [events.PAYOUT_RELEASED]: ['payout-released', payload.orderId],
    [events.PAYOUT_FORCE_RELEASED]: ['payout-released', payload.orderId],
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
  let notificationContent;
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
    case events.LISTING_REVISION_BLOCKED_BY_RESERVATION: {
      // cross-module notification-recipient read: listing_revisions (owned by listingRevisions.service.js)
      const result = await transactionDb.executeSql(
        'SELECT seller_id FROM listing_revisions WHERE id = $1', [job.payload.revisionId]
      );
      recipients = result.rows.map((row) => row.seller_id);
      eventType = 'listing_revision_blocked';
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
      if (job.eventName === events.ORDER_STATUS_CHANGED && job.payload.status === 'completed') return;
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
    case events.ORDER_FUNDED:
    case events.ORDER_CANCELLED:
    case events.ORDER_AUTO_CANCELLED:
    case events.ORDER_HANDED_OVER:
    case events.ORDER_DELIVERED:
    case events.DISPUTE_FILED:
    case events.DISPUTE_RESOLUTION_COMMITTED:
    case events.PAYOUT_RELEASED:
    case events.PAYOUT_FORCE_RELEASED: {
      // cross-module notification-recipient read: orders (owned by orders.service.js)
      const { rows } = await transactionDb.executeSql(
        'SELECT buyer_id, seller_id FROM orders WHERE id = $1',
        [job.payload.orderId]
      );
      const order = rows[0];
      if (!order) return;

      const sellerOnly = [
        events.DISPUTE_FILED,
        events.PAYOUT_RELEASED,
        events.PAYOUT_FORCE_RELEASED,
      ].includes(job.eventName);
      recipients = sellerOnly
        ? [{ userId: order.seller_id, role: 'seller' }]
        : [
            { userId: order.buyer_id, role: 'buyer' },
            { userId: order.seller_id, role: 'seller' },
          ];

      let buyerRefundRequested = false;
      if (job.eventName === events.ORDER_CANCELLED) {
        // cross-module read: refunds (owned by escrowPayments.service.js)
        const { rows: refundRows } = await transactionDb.executeSql(
          `SELECT EXISTS (
             SELECT 1 FROM refunds
             WHERE order_id = $1 AND trigger = 'system_cancel'
           ) AS requested`,
          [job.payload.orderId]
        );
        buyerRefundRequested = refundRows[0]?.requested === true;
      }

      notificationContent = (role) => {
        const isSeller = role === 'seller';
        const href = `${isSeller ? '/seller/orders' : '/orders'}/${encodeURIComponent(job.payload.orderId)}`;
        let message;
        if (job.eventName === events.ORDER_FUNDED) {
          message = isSeller
            ? 'You have a new sale; handover is recorded by our team after courier pickup.'
            : 'Payment confirmed for your order.';
        } else if (job.eventName === events.ORDER_CANCELLED) {
          message = isSeller
            ? 'An order was cancelled.'
            : buyerRefundRequested
              ? 'Your order was cancelled; a refund was requested.'
              : 'Your order was cancelled.';
        } else if (job.eventName === events.ORDER_AUTO_CANCELLED) {
          message = isSeller
            ? 'A sale was cancelled after the handover deadline.'
            : 'Your order was automatically cancelled and a refund was requested.';
        } else if (job.eventName === events.ORDER_HANDED_OVER) {
          message = isSeller
            ? 'Your sale has been handed to delivery.'
            : 'Your order has been handed to delivery.';
        } else if (job.eventName === events.ORDER_DELIVERED) {
          message = isSeller ? 'Your sale was delivered.' : 'Your order was delivered.';
        } else if (job.eventName === events.DISPUTE_FILED) {
          message = 'A dispute was filed for your sale.';
        } else if (job.eventName === events.DISPUTE_RESOLUTION_COMMITTED) {
          message = isSeller
            ? 'A dispute on your sale was resolved.'
            : 'A dispute on your order was resolved.';
        } else {
          message = 'Your payout was released.';
        }
        return { orderId: job.payload.orderId, message, href };
      };

      if (job.eventName === events.ORDER_FUNDED) eventType = 'payment_confirmed';
      else if (job.eventName === events.ORDER_CANCELLED) eventType = 'order_cancelled';
      else if (job.eventName === events.ORDER_AUTO_CANCELLED) eventType = 'order_auto_cancelled';
      else if (job.eventName === events.ORDER_HANDED_OVER) eventType = 'order_handed_over';
      else if (job.eventName === events.ORDER_DELIVERED) eventType = 'order_delivered';
      else if (job.eventName === events.DISPUTE_FILED) eventType = 'dispute_filed';
      else if (job.eventName === events.DISPUTE_RESOLUTION_COMMITTED) eventType = 'dispute_resolved';
      else eventType = 'payout_released';

      if (job.eventName === events.ORDER_FUNDED) {
        recipients = recipients.map((recipient) => ({
          ...recipient,
          eventType: recipient.role === 'seller' ? 'new_sale' : 'payment_confirmed',
        }));
      }
      break;
    }
    default:
      throw new TypeError('Unsupported notification event.');
  }

  const uniqueRecipients = new Map(recipients.map((recipient) => {
    const userId = typeof recipient === 'object' ? recipient.userId : recipient;
    return [userId, typeof recipient === 'object' ? recipient : { userId, role: null }];
  }));
  for (const [recipientId, recipient] of uniqueRecipients) {
    if (job.eventName === events.LISTING_REVISION_BLOCKED_BY_RESERVATION) {
      await transactionDb.executeSql(
        `INSERT INTO notifications (user_id, event_type, payload, dedupe_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
        [
          recipientId,
          eventType,
          JSON.stringify(job.payload),
          `revision-blocked:${job.payload.revisionId}`,
        ]
      );
    } else if (notificationContent) {
      const recipientEventType = recipient.eventType || eventType;
      const dedupeId = job.payload.disputeId || job.payload.orderId;
      const dedupeKey = `${recipientEventType}:${dedupeId}`;
      await transactionDb.executeSql(
        `INSERT INTO notifications (user_id, event_type, payload, dedupe_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
        [
          recipientId,
          recipientEventType,
          JSON.stringify(notificationContent(recipient.role)),
          dedupeKey,
        ]
      );
    } else {
      await transactionDb.executeSql(
        'INSERT INTO notifications (user_id, event_type, payload) VALUES ($1, $2, $3)',
        [recipientId, eventType, JSON.stringify(job.payload)]
      );
    }
  }
}

/** FR-77d: enqueue notification events without doing database writes in the web process. */
function registerListeners() {
  for (const eventName of NOTIFICATION_EVENTS) {
    eventBus.on(eventName, async (payload, context = {}) => {
      if (eventName === events.DISPUTE_RESOLVED && context.transaction) return;
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
