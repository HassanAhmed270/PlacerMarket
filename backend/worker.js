/** FR-77: the separate worker process consumes durable PostgreSQL jobs. */

const { createQueueClient, QUEUES } = require('./src/lib/queue');
const { createRedisClient } = require('./src/lib/redis');
const notifications = require('./src/modules/notifications.service');

async function startWorker() {
  const redis = createRedisClient();
  const databaseUrl = process.env.QUEUE_DATABASE_URL || process.env.DATABASE_URL;
  const queue = createQueueClient({ connectionString: databaseUrl, worker: true });
  try {
    await redis.start();
    await queue.start();
    await queue.boss.work(
      QUEUES.NOTIFICATIONS,
      { batchSize: 1, localConcurrency: queueLib.WORKER_CONCURRENCY[QUEUES.NOTIFICATIONS], transactional: true },
      async ([job], transactionDb) => notifications.processNotificationJob(job.data, transactionDb)
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
