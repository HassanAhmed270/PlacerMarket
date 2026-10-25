/** FR-77, FR-77a: PostgreSQL-backed job queues shared by web and worker processes. */

const crypto = require('crypto');
const requestContext = require('./requestContext');
let defaultPgBossPromise;

async function loadPgBoss() {
  defaultPgBossPromise ||= import('pg-boss').then(({ PgBoss }) => PgBoss);
  return defaultPgBossPromise;
}

const QUEUES = Object.freeze({
  MONEY: 'money-offers',
  MEDIA: 'media',
  NOTIFICATIONS: 'notifications',
  EMAIL: 'email',
  LISTING_SEARCH: 'listing-search',
  PAGE_SNAPSHOTS: 'page-snapshots',
  DEAD_LETTER: 'dead-letter',
});

const QUEUE_NAMES = Object.freeze([
  QUEUES.MONEY, QUEUES.MEDIA, QUEUES.NOTIFICATIONS, QUEUES.EMAIL, QUEUES.LISTING_SEARCH, QUEUES.PAGE_SNAPSHOTS,
]);
const WORKER_CONCURRENCY = Object.freeze({
  [QUEUES.MONEY]: 1,
  [QUEUES.MEDIA]: 2,
  [QUEUES.NOTIFICATIONS]: 4,
  [QUEUES.EMAIL]: 2,
  [QUEUES.LISTING_SEARCH]: 4,
  [QUEUES.PAGE_SNAPSHOTS]: 1,
});

const RETRY_LIMIT = 5;
const RETRY_DELAY_SECONDS = 1;
const RETRY_DELAY_MAX_SECONDS = 300;
const JOB_EXPIRE_SECONDS = 300;
const DEAD_LETTER_RETENTION_SECONDS = 30 * 24 * 60 * 60;

function deterministicJobId(queue, idempotencyKey) {
  if (typeof queue !== 'string' || !queue || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
    throw new TypeError('A queue name and non-empty idempotency key are required.');
  }
  const bytes = crypto.createHash('sha256').update(`${queue}\0${idempotencyKey}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function asQueueDatabase(transaction) {
  if (!transaction) return undefined;
  if (typeof transaction.executeSql === 'function') return transaction;
  const client = typeof transaction.query === 'function' ? transaction : transaction.client;
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('Queue transactions require a pg client or transaction client.');
  }
  return { executeSql: (text, values = []) => client.query(text, values) };
}

function validatePayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('Queue payload must be a JSON object.');
  }
  let serialized;
  try {
    serialized = JSON.stringify(data);
  } catch {
    throw new TypeError('Queue payload must be JSON serializable.');
  }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 65536) {
    throw new TypeError('Queue payload must not exceed 64 KiB.');
  }
}

function createQueueClient({
  connectionString = process.env.DATABASE_URL,
  worker = false,
  PgBossClass,
  logger = console,
} = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required to connect the PostgreSQL queue.');

  let boss = PgBossClass ? new PgBossClass({
    connectionString,
    schema: 'pgboss',
    migrate: false,
    createSchema: false,
    useListenNotify: worker,
    supervise: worker,
    schedule: worker,
    persistQueueStats: true,
    monitorStateIntervalSeconds: worker ? 60 : 0,
    monitorVacuum: worker,
    reindex: false,
    max: worker ? 10 : 3,
    connectionTimeoutMillis: 1000,
  }) : null;

  function attachLogging() {
    boss.on('error', (error) => {
      logger.error('Queue database error', { code: error?.code || 'unknown' });
    });
    boss.on('warning', (warning) => {
      logger.warn('Queue warning', { type: warning?.type || 'unknown' });
    });
  }
  if (boss) attachLogging();

  let started = false;

  async function start() {
    if (started) return;
    if (!boss) {
      const PgBoss = await loadPgBoss();
      boss = new PgBoss({
        connectionString,
        schema: 'pgboss',
        migrate: false,
        createSchema: false,
        useListenNotify: worker,
        supervise: worker,
        schedule: worker,
        persistQueueStats: true,
        monitorStateIntervalSeconds: worker ? 60 : 0,
        monitorVacuum: worker,
        reindex: false,
        max: worker ? 10 : 3,
        connectionTimeoutMillis: 1000,
      });
      attachLogging();
    }
    await boss.start();
    try {
      await boss.createQueue(QUEUES.DEAD_LETTER, {
        retryLimit: 0,
        retentionSeconds: DEAD_LETTER_RETENTION_SECONDS,
        deleteAfterSeconds: 0,
      });
      for (const name of QUEUE_NAMES) {
        await boss.createQueue(name, {
          policy: 'key_strict_fifo',
          retryLimit: RETRY_LIMIT,
          retryDelay: RETRY_DELAY_SECONDS,
          retryBackoff: true,
          retryDelayMax: RETRY_DELAY_MAX_SECONDS,
          expireInSeconds: JOB_EXPIRE_SECONDS,
          heartbeatSeconds: 60,
          retentionSeconds: 14 * 24 * 60 * 60,
          deleteAfterSeconds: 7 * 24 * 60 * 60,
          deadLetter: QUEUES.DEAD_LETTER,
          notify: true,
        });
      }
      started = true;
    } catch (error) {
      await boss.stop({ graceful: false }).catch(() => {});
      throw error;
    }
  }

  async function stop() {
    if (!started) return;
    await boss.stop({ graceful: true, timeout: 30000 });
    started = false;
  }

  /** FR-77a: persist a job, optionally in the caller's business transaction. */
  async function enqueue(queue, data, { idempotencyKey, orderingKey, transaction, startAfter } = {}) {
    if (!QUEUE_NAMES.includes(queue)) throw new TypeError(`Unsupported queue: ${queue}`);
    validatePayload(data);
    const traceId = requestContext.getRequestId();
    const jobData = traceId ? { ...data, traceId } : data;
    if (traceId) validatePayload(jobData);
    if (typeof orderingKey !== 'string' || !orderingKey.trim() || orderingKey.length > 256) {
      throw new TypeError('A non-empty ordering key of at most 256 characters is required.');
    }
    if (!started) throw new Error('The PostgreSQL queue has not been started.');

    const options = {
      id: deterministicJobId(queue, idempotencyKey),
      singletonKey: orderingKey,
      db: asQueueDatabase(transaction),
    };
    if (startAfter !== undefined) options.startAfter = startAfter;
    return boss.send(queue, jobData, options);
  }

  /** FR-77a: expose a bounded, non-claiming dead-letter listing to admin routes. */
  async function listDeadLetters({ limit = 50, after } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('Dead-letter limit must be an integer from 1 to 100.');
    }
    if (!started) throw new Error('The PostgreSQL queue has not been started.');
    const jobs = await boss.findJobs(QUEUES.DEAD_LETTER, { limit, after });
    return jobs.map((job) => ({
      id: job.id,
      sourceName: job.sourceName,
      sourceId: job.sourceId,
      sourceRetryCount: job.sourceRetryCount,
      createdOn: job.createdOn,
      state: job.state,
    }));
  }

  /** FR-77c: report queue depth, age, throughput, failure deltas and dead-letter count. */
  async function getQueueHealth() {
    if (!started) throw new Error('The PostgreSQL queue has not been started.');
    const queues = await boss.getQueues();
    const deadLetterCount = queues.find(({ name }) => name === QUEUES.DEAD_LETTER)?.totalCount ?? 0;
    return {
      queues: queues.map(({
        name,
        readyCount,
        activeCount,
        failedCount,
        totalCount,
        readyOldestSeconds,
        createdDelta,
        completedDelta,
        failedDelta,
        deltaSeconds,
      }) => ({
        name,
        readyCount,
        activeCount,
        failedCount,
        totalCount,
        oldestReadySeconds: readyOldestSeconds,
        createdDelta,
        completedDelta,
        terminalFailureDelta: failedDelta,
        deltaSeconds,
      })),
      deadLetterCount,
    };
  }

  return { get boss() { return boss; }, start, stop, enqueue, listDeadLetters, getQueueHealth };
}

let producer;
function producerQueue() {
  if (!producer) producer = createQueueClient({ worker: false });
  return producer;
}

async function startProducer() { return producerQueue().start(); }
async function stopProducer() {
  if (producer) await producer.stop();
}
async function enqueue(queue, data, options) { return producerQueue().enqueue(queue, data, options); }
async function listDeadLetters(options) { return producerQueue().listDeadLetters(options); }
async function getQueueHealth() { return producerQueue().getQueueHealth(); }

module.exports = {
  QUEUES,
  WORKER_CONCURRENCY,
  createQueueClient,
  deterministicJobId,
  asQueueDatabase,
  startProducer,
  stopProducer,
  enqueue,
  listDeadLetters,
  getQueueHealth,
};
