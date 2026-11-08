const { EventEmitter } = require('events');

const mockQueue = {
  QUEUES: {
    NOTIFICATIONS: 'notifications',
    EMAIL: 'email',
    MONEY_MAINTENANCE: 'money-maintenance',
    LISTING_SEARCH: 'listing-search',
    PAGE_SNAPSHOTS: 'page-snapshots',
    PAYMENT_WEBHOOKS: 'payment-webhooks',
    REFUNDS: 'refunds',
  },
  WORKER_CONCURRENCY: {
    notifications: 4,
    email: 2,
    'money-maintenance': 1,
    'listing-search': 4,
    'page-snapshots': 1,
    'payment-webhooks': 2,
    refunds: 2,
  },
  createQueueClient: jest.fn(),
  startProducer: jest.fn().mockResolvedValue(undefined),
  stopProducer: jest.fn().mockResolvedValue(undefined),
};
const mockRedis = { createRedisClient: jest.fn() };
const mockNotifications = { processNotificationJob: jest.fn() };
const mockListingSearch = { processListingSearchJob: jest.fn() };
const mockListings = { expireDueReservations: jest.fn() };
const mockPageSnapshots = { processSnapshotJob: jest.fn(), enqueueFullSnapshotRebuild: jest.fn().mockResolvedValue('startup-job') };
const mockEscrowPayments = {
  processPaymentWebhookJob: jest.fn(),
  processRefundJob: jest.fn(),
  sweepUnhandedOverOrders: jest.fn(),
  reconcileMoneyState: jest.fn(),
};
const { encryptEmailPayload } = require('../../src/lib/emailQueuePayload');

jest.mock('../../src/lib/queue', () => mockQueue);
jest.mock('../../src/lib/redis', () => mockRedis);
jest.mock('../../src/modules/notifications.service', () => mockNotifications);
jest.mock('../../src/modules/listingSearch.service', () => mockListingSearch);
jest.mock('../../src/modules/listings.service', () => mockListings);
jest.mock('../../src/modules/pageSnapshots.service', () => mockPageSnapshots);
jest.mock('../../src/modules/escrowPayments.service', () => mockEscrowPayments);

const { startWorker } = require('../../worker');

describe('FR-77, FR-77a, FR-77d: notification worker startup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('FR-79f: production worker refuses invalid payout keys before opening Redis', async () => {
    const previous = {
      nodeEnv: process.env.NODE_ENV,
      active: process.env.PAYOUT_ENCRYPTION_ACTIVE_KEY_ID,
      keys: process.env.PAYOUT_ENCRYPTION_KEYS_JSON,
    };
    process.env.NODE_ENV = 'production';
    process.env.PAYOUT_ENCRYPTION_ACTIVE_KEY_ID = 'missing';
    process.env.PAYOUT_ENCRYPTION_KEYS_JSON = JSON.stringify({ key: Buffer.alloc(32).toString('base64') });
    try {
      await expect(startWorker({ validatePaymentsGate: jest.fn().mockResolvedValue(undefined) }))
        .rejects.toThrow('PAYOUT_ENCRYPTION_ACTIVE_KEY_ID');
      expect(mockRedis.createRedisClient).not.toHaveBeenCalled();
      expect(mockQueue.createQueueClient).not.toHaveBeenCalled();
    } finally {
      if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous.nodeEnv;
      if (previous.active === undefined) delete process.env.PAYOUT_ENCRYPTION_ACTIVE_KEY_ID;
      else process.env.PAYOUT_ENCRYPTION_ACTIVE_KEY_ID = previous.active;
      if (previous.keys === undefined) delete process.env.PAYOUT_ENCRYPTION_KEYS_JSON;
      else process.env.PAYOUT_ENCRYPTION_KEYS_JSON = previous.keys;
    }
  });

  test('FR-69: refuses worker startup when the production payments Admin gate fails', async () => {
    const gateError = new Error('Configuration error: PAYMENTS_ENABLED=1 requires at least two distinct, enrolled, non-suspended Admins.');
    const validatePaymentsGate = jest.fn().mockRejectedValue(gateError);
    await expect(startWorker({ validatePaymentsGate })).rejects.toBe(gateError);
    expect(validatePaymentsGate).toHaveBeenCalledTimes(1);
    expect(mockRedis.createRedisClient).not.toHaveBeenCalled();
    expect(mockQueue.createQueueClient).not.toHaveBeenCalled();
  });

  test('FR-69, FR-77d: starts the worker and registers refund and notification consumers', async () => {
    const boss = new EventEmitter();
    boss.work = jest.fn().mockResolvedValue(undefined);
    boss.schedule = jest.fn().mockResolvedValue(undefined);
    const queue = { boss, start: jest.fn().mockResolvedValue(undefined), stop: jest.fn().mockResolvedValue(undefined) };
    const redis = { start: jest.fn().mockResolvedValue(undefined), stop: jest.fn().mockResolvedValue(undefined) };
    mockQueue.createQueueClient.mockReturnValue(queue);
    mockRedis.createRedisClient.mockReturnValue(redis);

    const previousQueueDatabaseUrl = process.env.QUEUE_DATABASE_URL;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousEmailKey = process.env.EMAIL_QUEUE_ENCRYPTION_SECRET;
    process.env.QUEUE_DATABASE_URL = 'postgres://worker/db';
    process.env.EMAIL_QUEUE_ENCRYPTION_SECRET = 'test-email-queue-key-material-over-32-bytes';
    delete process.env.DATABASE_URL;
    const sigintBefore = new Set(process.listeners('SIGINT'));
    const sigtermBefore = new Set(process.listeners('SIGTERM'));

    try {
      const emailSender = { send: jest.fn().mockResolvedValue({ accepted: true }) };
      const purger = { kind: 'live', purge: jest.fn().mockResolvedValue({ purged: 1 }) };
      mockPageSnapshots.processSnapshotJob.mockResolvedValue({ outcome: 'regenerated', paths: ['/'] });
      const worker = await startWorker({
        emailSender,
        cdnPurger: purger,
        validatePaymentsGate: jest.fn().mockResolvedValue(undefined),
      });
      expect(redis.start).toHaveBeenCalledTimes(1);
      expect(queue.start).toHaveBeenCalledTimes(1);
      expect(mockQueue.startProducer).toHaveBeenCalledTimes(1);
      expect(mockQueue.createQueueClient).toHaveBeenCalledWith({
        connectionString: 'postgres://worker/db', worker: true,
      });
      expect(boss.work).toHaveBeenCalledWith(
        'notifications',
        { batchSize: 1, localConcurrency: 4, transactional: true },
        expect.any(Function)
      );
      expect(mockPageSnapshots.enqueueFullSnapshotRebuild).toHaveBeenCalledTimes(1);
      const emailHandler = boss.work.mock.calls.find(([name]) => name === 'email')[2];
      const encryptedPayload = encryptEmailPayload({ to: 'buyer@example.test', subject: 'Code', text: '123456' }, 'test-email-queue-key-material-over-32-bytes');
      await emailHandler([{ data: { encryptedPayload } }]);
      expect(emailSender.send).toHaveBeenCalledWith({ to: 'buyer@example.test', subject: 'Code', text: '123456' });
      expect(boss.work).toHaveBeenCalledWith(
        'email',
        { batchSize: 1, localConcurrency: 2, transactional: false },
        expect.any(Function)
      );
      expect(boss.work).toHaveBeenCalledWith(
        'listing-search',
        { batchSize: 1, localConcurrency: 4, transactional: false },
        expect.any(Function)
      );
      expect(boss.work).toHaveBeenCalledWith(
        'page-snapshots',
        { batchSize: 1, localConcurrency: 1, transactional: false },
        expect.any(Function)
      );
      expect(boss.work).toHaveBeenCalledWith(
        'payment-webhooks',
        { batchSize: 1, localConcurrency: 2, transactional: false },
        expect.any(Function)
      );
      expect(boss.work).toHaveBeenCalledWith(
        'refunds',
        { batchSize: 1, localConcurrency: 2, transactional: false },
        expect.any(Function)
      );
      expect(boss.work).toHaveBeenCalledWith(
        'money-maintenance',
        { batchSize: 1, localConcurrency: 1, transactional: false },
        expect.any(Function)
      );
      expect(boss.schedule).toHaveBeenCalledWith(
        'money-maintenance',
        '* * * * *',
        { task: 'reservation-expiry' },
        { key: 'reservation-expiry', singletonKey: 'money-maintenance:reservation-expiry' }
      );
      expect(boss.schedule).toHaveBeenCalledWith(
        'money-maintenance',
        '*/5 * * * *',
        { task: 'handover-timeout' },
        { key: 'handover-timeout', singletonKey: 'money-maintenance:handover-timeout' }
      );
      expect(boss.schedule).toHaveBeenCalledWith(
        'money-maintenance',
        '*/10 * * * *',
        { task: 'reconciliation' },
        { key: 'reconciliation', singletonKey: 'money-maintenance:reconciliation' }
      );
      const maintenanceHandler = boss.work.mock.calls.find(([name]) => name === 'money-maintenance')[2];
      await maintenanceHandler([{ data: { task: 'reservation-expiry' } }]);
      expect(mockListings.expireDueReservations).toHaveBeenCalledTimes(1);
      await maintenanceHandler([{ data: { task: 'handover-timeout' } }]);
      expect(mockEscrowPayments.sweepUnhandedOverOrders).toHaveBeenCalledTimes(1);
      await maintenanceHandler([{ data: { task: 'reconciliation' } }]);
      expect(mockEscrowPayments.reconcileMoneyState).toHaveBeenCalledTimes(1);
      const paymentWebhookHandler = boss.work.mock.calls.find(([name]) => name === 'payment-webhooks')[2];
      await paymentWebhookHandler([{ data: { webhookInboxId: 'inbox-1' } }]);
      expect(mockEscrowPayments.processPaymentWebhookJob).toHaveBeenCalledWith({ webhookInboxId: 'inbox-1' });
      const refundHandler = boss.work.mock.calls.find(([name]) => name === 'refunds')[2];
      await refundHandler([{ data: { refundId: 'refund-1' } }]);
      expect(mockEscrowPayments.processRefundJob).toHaveBeenCalledWith({ refundId: 'refund-1' });
      const snapshotHandler = boss.work.mock.calls.find(([name]) => name === 'page-snapshots')[2];
      await snapshotHandler([{ data: { listingId: 'listing-1', searchVersion: '2' } }]);
      expect(mockPageSnapshots.processSnapshotJob).toHaveBeenCalledWith({ listingId: 'listing-1', searchVersion: '2' });
      expect(purger.purge).toHaveBeenCalledWith(['/']);
      await worker.shutdown('test');
      expect(queue.stop).toHaveBeenCalledTimes(1);
      expect(mockQueue.stopProducer).toHaveBeenCalledTimes(1);
      expect(redis.stop).toHaveBeenCalledTimes(1);
    } finally {
      for (const listener of process.listeners('SIGINT')) {
        if (!sigintBefore.has(listener)) process.off('SIGINT', listener);
      }
      for (const listener of process.listeners('SIGTERM')) {
        if (!sigtermBefore.has(listener)) process.off('SIGTERM', listener);
      }
      if (previousQueueDatabaseUrl === undefined) delete process.env.QUEUE_DATABASE_URL;
      else process.env.QUEUE_DATABASE_URL = previousQueueDatabaseUrl;
      if (previousEmailKey === undefined) delete process.env.EMAIL_QUEUE_ENCRYPTION_SECRET;
      else process.env.EMAIL_QUEUE_ENCRYPTION_SECRET = previousEmailKey;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });
});
