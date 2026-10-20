jest.mock('../../src/db.service', () => ({ query: jest.fn() }));
jest.mock('../../src/lib/queue', () => ({
  QUEUES: { NOTIFICATIONS: 'notifications' },
  enqueue: jest.fn().mockResolvedValue('job-id'),
}));

const db = require('../../src/db.service');
const queue = require('../../src/lib/queue');
const eventBus = require('../../src/lib/eventBus');
const events = require('../../src/lib/events');
const notifications = require('../../src/modules/notifications.service');

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
});
