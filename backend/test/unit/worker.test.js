const { EventEmitter } = require('events');

const mockQueue = {
  QUEUES: { NOTIFICATIONS: 'notifications', EMAIL: 'email' },
  WORKER_CONCURRENCY: { notifications: 4, email: 2 },
  createQueueClient: jest.fn(),
};
const mockRedis = { createRedisClient: jest.fn() };
const mockNotifications = { processNotificationJob: jest.fn() };
const { encryptEmailPayload } = require('../../src/lib/emailQueuePayload');

jest.mock('../../src/lib/queue', () => mockQueue);
jest.mock('../../src/lib/redis', () => mockRedis);
jest.mock('../../src/modules/notifications.service', () => mockNotifications);

const { startWorker } = require('../../worker');

describe('FR-77, FR-77a, FR-77d: notification worker startup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('FR-77d: starts Redis and the durable notification consumer with configured transactional concurrency', async () => {
    const boss = new EventEmitter();
    boss.work = jest.fn().mockResolvedValue(undefined);
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
      const worker = await startWorker({ emailSender });
      expect(redis.start).toHaveBeenCalledTimes(1);
      expect(queue.start).toHaveBeenCalledTimes(1);
      expect(mockQueue.createQueueClient).toHaveBeenCalledWith({
        connectionString: 'postgres://worker/db', worker: true,
      });
      expect(boss.work).toHaveBeenCalledWith(
        'notifications',
        { batchSize: 1, localConcurrency: 4, transactional: true },
        expect.any(Function)
      );
      const emailHandler = boss.work.mock.calls.find(([name]) => name === 'email')[2];
      const encryptedPayload = encryptEmailPayload({ to: 'buyer@example.test', subject: 'Code', text: '123456' }, 'test-email-queue-key-material-over-32-bytes');
      await emailHandler([{ data: { encryptedPayload } }]);
      expect(emailSender.send).toHaveBeenCalledWith({ to: 'buyer@example.test', subject: 'Code', text: '123456' });
      expect(boss.work).toHaveBeenCalledWith(
        'email',
        { batchSize: 1, localConcurrency: 2, transactional: false },
        expect.any(Function)
      );
      await worker.shutdown('test');
      expect(queue.stop).toHaveBeenCalledTimes(1);
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
