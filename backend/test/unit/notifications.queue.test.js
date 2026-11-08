jest.mock('../../src/db.service', () => ({ query: jest.fn() }));
jest.mock('../../src/lib/queue', () => ({
  QUEUES: { NOTIFICATIONS: 'notifications', EMAIL: 'email' },
  enqueue: jest.fn().mockResolvedValue('job-id'),
}));

const db = require('../../src/db.service');
const queue = require('../../src/lib/queue');
const eventBus = require('../../src/lib/eventBus');
const events = require('../../src/lib/events');
const notifications = require('../../src/modules/notifications.service');
const { decryptEmailPayload } = require('../../src/lib/emailQueuePayload');

describe('FR-77d: notification event listeners enqueue durable jobs', () => {
  beforeEach(() => {
    queue.enqueue.mockClear();
    db.query.mockReset();
  });

  test('FR-77d: a listing status event enqueues instead of writing notification rows inline', async () => {
    const payload = { listingId: 'listing-42', status: 'published' };
    eventBus.emit(events.LISTING_STATUS_CHANGED, payload);
    await new Promise((resolve) => setImmediate(resolve));

    expect(queue.enqueue).toHaveBeenCalledWith('notifications', {
      eventName: events.LISTING_STATUS_CHANGED,
      payload,
    }, {
      idempotencyKey: `${events.LISTING_STATUS_CHANGED}:listing:listing-42:published`,
      orderingKey: 'listing:listing-42',
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('FR-77a: mapped business events enqueue using the caller transaction', async () => {
    const transaction = { query: jest.fn() };
    const payload = { listingId: 'listing-42', status: 'published' };

    await eventBus.emitAsync(events.LISTING_STATUS_CHANGED, payload, { transaction });

    expect(queue.enqueue).toHaveBeenCalledWith('notifications', {
      eventName: events.LISTING_STATUS_CHANGED,
      payload,
    }, expect.objectContaining({
      idempotencyKey: `${events.LISTING_STATUS_CHANGED}:listing:listing-42:published`,
      orderingKey: 'listing:listing-42',
      transaction,
    }));
  });

  test('FR-77a: transactional notification enqueue failures propagate to roll back the state change', async () => {
    const transaction = { query: jest.fn() };
    queue.enqueue.mockRejectedValueOnce(new Error('queue unavailable'));

    await expect(eventBus.emitAsync(
      events.LISTING_STATUS_CHANGED,
      { listingId: 'listing-42', status: 'published' },
      { transaction }
    )).rejects.toThrow('queue unavailable');
  });

  test('FR-51 and FR-77d: worker notification writes share the job transaction', async () => {
    const transactionDb = { executeSql: jest.fn()
      .mockResolvedValueOnce({ rows: [{ seller_id: 'seller-1' }] })
      .mockResolvedValueOnce({ rows: [] }) };
    const payload = { listingId: 'listing-42', status: 'rejected', reason: 'Missing photos' };

    await notifications.processNotificationJob({ eventName: events.LISTING_STATUS_CHANGED, payload }, transactionDb);

    expect(transactionDb.executeSql).toHaveBeenNthCalledWith(1,
      'SELECT seller_id FROM listings WHERE id = $1', ['listing-42']);
    expect(transactionDb.executeSql).toHaveBeenNthCalledWith(2,
      'INSERT INTO notifications (user_id, event_type, payload) VALUES ($1, $2, $3)',
      ['seller-1', 'listing_status', JSON.stringify(payload)]);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('FR-51 and FR-77d: unsupported notification job types fail for queue retry handling', async () => {
    await expect(notifications.processNotificationJob({ eventName: 'unknown', payload: {} }, { executeSql: jest.fn() }))
      .rejects.toThrow('Unsupported notification job payload');
  });

  test('SEC-12: message notifications are idempotent and schedule a separate 15-minute email check', async () => {
    const transactionDb = { executeSql: jest.fn()
      .mockResolvedValueOnce({ rows: [{ buyer_id: 'buyer', seller_id: 'seller' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'message-1', sender_id: 'buyer' }] })
      .mockResolvedValueOnce({ rows: [] }) };

    await notifications.processNotificationJob({
      eventName: events.MESSAGE_SENT,
      payload: { conversationId: 'conversation-1', messageId: 'message-1' },
    }, transactionDb);

    expect(transactionDb.executeSql).toHaveBeenNthCalledWith(3,
      expect.stringContaining('ON CONFLICT (user_id, dedupe_key)'),
      ['seller', JSON.stringify({ conversationId: 'conversation-1' }), 'message:message-1']);
    expect(queue.enqueue).toHaveBeenCalledWith('notifications', {
      eventName: 'conversation.message_email_check',
      payload: { conversationId: 'conversation-1', messageId: 'message-1' },
    }, {
      idempotencyKey: 'message-email-check:message-1',
      orderingKey: 'conversation-email:conversation-1',
      transaction: transactionDb,
      startAfter: '15 minutes',
    });
  });

  test('SEC-12: an unread message queues one generic email with no message text', async () => {
    const previousEmailKey = process.env.EMAIL_QUEUE_ENCRYPTION_SECRET;
    process.env.EMAIL_QUEUE_ENCRYPTION_SECRET = 'test-email-queue-key-material-over-32-bytes';
    const transactionDb = { executeSql: jest.fn()
      .mockResolvedValueOnce({ rows: [{
        conversation_id: 'conversation-1', message_id: 'message-1', email: 'buyer@example.test',
      }] })
      .mockResolvedValueOnce({ rows: [{ conversation_id: 'conversation-1' }] }) };

    try {
      await notifications.processNotificationJob({
        eventName: 'conversation.message_email_check',
        payload: { conversationId: 'conversation-1', messageId: 'message-1' },
      }, transactionDb);

      const [queueName, job, options] = queue.enqueue.mock.calls[0];
      expect(queueName).toBe('email');
      const email = decryptEmailPayload(job.encryptedPayload, process.env.EMAIL_QUEUE_ENCRYPTION_SECRET);
      expect(email).toEqual({
        to: 'buyer@example.test',
        subject: 'You have an unread Poshaak message',
        text: 'You have an unread message on Poshaak. Sign in to view your conversation.',
      });
      expect(JSON.stringify(email)).not.toContain('message-1');
      expect(options).toEqual(expect.objectContaining({
        idempotencyKey: 'conversation-unread:conversation-1:message-1',
        orderingKey: 'conversation-email-delivery:conversation-1',
        transaction: transactionDb,
      }));
    } finally {
      if (previousEmailKey === undefined) delete process.env.EMAIL_QUEUE_ENCRYPTION_SECRET;
      else process.env.EMAIL_QUEUE_ENCRYPTION_SECRET = previousEmailKey;
    }
  });

  test('SEC-12: the per-conversation throttle suppresses another email job', async () => {
    const transactionDb = { executeSql: jest.fn()
      .mockResolvedValueOnce({ rows: [{
        conversation_id: 'conversation-1', message_id: 'message-2', email: 'buyer@example.test',
      }] })
      .mockResolvedValueOnce({ rows: [] }) };
    await notifications.processNotificationJob({
      eventName: 'conversation.message_email_check',
      payload: { conversationId: 'conversation-1', messageId: 'message-2' },
    }, transactionDb);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  test('SEC-12: marking read is constrained by notification owner', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(notifications.markRead('notification-1', 'user-1')).resolves.toBe(false);
    expect(db.query).toHaveBeenCalledWith(
      'UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2',
      ['notification-1', 'user-1']);
  });
});
