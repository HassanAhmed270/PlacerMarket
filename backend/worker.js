/** FR-77: the separate worker process consumes durable PostgreSQL jobs. */

const { createQueueClient, startProducer, stopProducer, QUEUES, WORKER_CONCURRENCY } = require('./src/lib/queue');
const { createRedisClient } = require('./src/lib/redis');
const notifications = require('./src/modules/notifications.service');
const { createEmailSender } = require('./src/lib/adapters/emailSender');
const { decryptEmailPayload } = require('./src/lib/emailQueuePayload');
const { createDevEmailOutboxSender } = require('./src/lib/adapters/devEmailOutbox');
const { keyProviderFromEnv } = require('./src/lib/keyProvider');
const media = require('./src/modules/media.service');
const listings = require('./src/modules/listings.service');
const listingSearch = require('./src/modules/listingSearch.service');
const pageSnapshots = require('./src/modules/pageSnapshots.service');
const escrowPayments = require('./src/modules/escrowPayments.service');
const { createCdnPurger } = require('./src/lib/adapters/cdnPurger');

async function registerMoneyMaintenanceSchedules(boss) {
  await boss.schedule(
    QUEUES.MONEY_MAINTENANCE,
    '* * * * *',
    { task: 'reservation-expiry' },
    { key: 'reservation-expiry', singletonKey: 'money-maintenance:reservation-expiry' }
  );
  await boss.schedule(
    QUEUES.MONEY_MAINTENANCE,
    '*/5 * * * *',
    { task: 'handover-timeout' },
    { key: 'handover-timeout', singletonKey: 'money-maintenance:handover-timeout' }
  );
  await boss.schedule(
    QUEUES.MONEY_MAINTENANCE,
    '*/10 * * * *',
    { task: 'reconciliation' },
    { key: 'reconciliation', singletonKey: 'money-maintenance:reconciliation' }
  );
}

async function processMoneyMaintenanceJob(job) {
  if (job.data?.task === 'reservation-expiry') {
    return listings.expireDueReservations();
  }
  if (job.data?.task === 'handover-timeout') {
    return escrowPayments.sweepUnhandedOverOrders();
  }
  if (job.data?.task === 'reconciliation') {
    return escrowPayments.reconcileMoneyState();
  }
  throw new Error('Unsupported money maintenance task.');
}

async function startWorker({ emailSender, cdnPurger, logger = console } = {}) {
  if (process.env.NODE_ENV === 'production') keyProviderFromEnv(process.env);
  const selectedCdnPurger = cdnPurger || createCdnPurger({
    adapter: process.env.CDN_PURGE_ADAPTER || (process.env.NODE_ENV === 'production' ? undefined : 'fake'),
    adapterModule: process.env.CDN_PURGE_ADAPTER_MODULE,
    allowFake: process.env.NODE_ENV !== 'production',
    production: process.env.NODE_ENV === 'production',
  });
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
    await startProducer();
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
    await pageSnapshots.enqueueFullSnapshotRebuild();
    await queue.boss.work(
      QUEUES.MEDIA,
      { batchSize: 1, localConcurrency: WORKER_CONCURRENCY[QUEUES.MEDIA], transactional: false },
      async ([job]) => media.processListingImage(job.data?.listingImageId)
    );
    await queue.boss.work(
      QUEUES.LISTING_SEARCH,
      { batchSize: 1, localConcurrency: WORKER_CONCURRENCY[QUEUES.LISTING_SEARCH], transactional: false },
      async ([job]) => listingSearch.processListingSearchJob(job.data)
    );
    await queue.boss.work(
      QUEUES.PAGE_SNAPSHOTS,
      { batchSize: 1, localConcurrency: WORKER_CONCURRENCY[QUEUES.PAGE_SNAPSHOTS], transactional: false },
      async ([job]) => {
        const result = await pageSnapshots.processSnapshotJob(job.data);
        if (result.outcome === 'regenerated' && result.paths.length) {
          await selectedCdnPurger.purge(result.paths);
        }
      }
    );
    await queue.boss.work(
      QUEUES.PAYMENT_WEBHOOKS,
      { batchSize: 1, localConcurrency: WORKER_CONCURRENCY[QUEUES.PAYMENT_WEBHOOKS], transactional: false },
      async ([job]) => escrowPayments.processPaymentWebhookJob({
        webhookInboxId: job.data?.webhookInboxId,
      })
    );
    await queue.boss.work(
      QUEUES.REFUNDS,
      { batchSize: 1, localConcurrency: WORKER_CONCURRENCY[QUEUES.REFUNDS], transactional: false },
      async ([job]) => escrowPayments.processRefundJob({ refundId: job.data?.refundId })
    );
    await queue.boss.work(
      QUEUES.MONEY_MAINTENANCE,
      { batchSize: 1, localConcurrency: WORKER_CONCURRENCY[QUEUES.MONEY_MAINTENANCE], transactional: false },
      async ([job]) => processMoneyMaintenanceJob(job)
    );
    await registerMoneyMaintenanceSchedules(queue.boss);
    // eslint-disable-next-line no-console
    console.log('Poshaak worker started');

    let shuttingDown;
    async function shutdown(signal) {
      if (shuttingDown) return shuttingDown;
      shuttingDown = (async () => {
        // eslint-disable-next-line no-console
        console.log(`Poshaak worker shutting down (${signal})`);
        await queue.stop();
        await stopProducer();
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
    await stopProducer().catch(() => {});
    await redis.stop().catch(() => {});
    throw error;
  }
}

if (require.main === module) {
  startWorker().catch((error) => {
    if (process.env.NODE_ENV === 'production' && /^PAYOUT_ENCRYPTION_(?:KEYS_JSON|ACTIVE_KEY_ID)/.test(error?.message || '')) {
      console.error(error.message);
    } else console.error('Worker startup failed', { code: error?.code || 'unknown' });
    process.exitCode = 1;
  });
}

module.exports = { startWorker, registerMoneyMaintenanceSchedules, processMoneyMaintenanceJob };
