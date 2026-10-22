/** FR-77: the separate worker process consumes durable PostgreSQL jobs. */

const { createQueueClient, QUEUES, WORKER_CONCURRENCY } = require('./src/lib/queue');
const { createRedisClient } = require('./src/lib/redis');
const notifications = require('./src/modules/notifications.service');
const { createEmailSender } = require('./src/lib/adapters/emailSender');
const { decryptEmailPayload } = require('./src/lib/emailQueuePayload');
const { createDevEmailOutboxSender } = require('./src/lib/adapters/devEmailOutbox');

async function startWorker({ emailSender } = {}) {
  const selectedEmailSender = emailSender || (process.env.DEV_FAKES === '1' && process.env.NODE_ENV !== 'production'
    ? createDevEmailOutboxSender()
    : process.env.EMAIL_SENDER_ADAPTER
      ? createEmailSender({
      adapter: process.env.EMAIL_SENDER_ADAPTER,
      allowFake: process.env.ALLOW_FAKE_ADAPTERS === 'true' || process.env.DEV_FAKES === '1',
      production: process.env.NODE_ENV === 'production',
    })
      : null);
  const redis = createRedisClient();
  const databaseUrl = process.env.QUEUE_DATABASE_URL || process.env.DATABASE_URL;
  const queue = createQueueClient({ connectionString: databaseUrl, worker: true });
  try {
    await redis.start();
    await queue.start();
    await queue.boss.work(
      QUEUES.NOTIFICATIONS,
      { batchSize: 1, localConcurrency: WORKER_CONCURRENCY[QUEUES.NOTIFICATIONS], transactional: true },
      async ([job], transactionDb) => notifications.processNotificationJob(job.data, transactionDb)
    );
    await queue.boss.work(
      QUEUES.EMAIL,
      { batchSize: 1, localConcurrency: WORKER_CONCURRENCY[QUEUES.EMAIL], transactional: false },
      async ([job]) => {
        if (!selectedEmailSender) throw new Error('No email sender is configured for queued email delivery.');
        const message = decryptEmailPayload(job.data?.encryptedPayload);
        await selectedEmailSender.send(message);
      }
    );
    // eslint-disable-next-line no-console
    console.log('Poshaak worker started');

    let shuttingDown;
    async function shutdown(signal) {
      if (shuttingDown) return shuttingDown;
      shuttingDown = (async () => {
        // eslint-disable-next-line no-console
        console.log(`Poshaak worker shutting down (${signal})`);
        await queue.stop();
        await redis.stop();
      })();
      return shuttingDown;
    }
    process.once('SIGINT', () => shutdown('SIGINT').catch((error) => {
      console.error('Worker shutdown failed', { code: error?.code || 'unknown' });
      process.exitCode = 1;
    }));
    process.once('SIGTERM', () => shutdown('SIGTERM').catch((error) => {
      console.error('Worker shutdown failed', { code: error?.code || 'unknown' });
      process.exitCode = 1;
    }));
    return { queue, shutdown };
  } catch (error) {
    await queue.stop().catch(() => {});
    await redis.stop().catch(() => {});
    throw error;
  }
}

if (require.main === module) {
  startWorker().catch((error) => {
    console.error('Worker startup failed', { code: error?.code || 'unknown' });
    process.exitCode = 1;
  });
}

module.exports = { startWorker };
