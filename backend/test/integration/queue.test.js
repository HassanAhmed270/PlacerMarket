const { Pool } = require('pg');
const queueLib = require('../../src/lib/queue');

const databaseUrl = process.env.TEST_DATABASE_URL;

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

describe('FR-77, FR-77a: PostgreSQL queue durability and worker guarantees', () => {
  let producer;
  let effectPool;

  beforeAll(async () => {
    producer = queueLib.createQueueClient({ connectionString: databaseUrl });
    await producer.start();
    effectPool = new Pool({ connectionString: databaseUrl });
    await effectPool.query(`
      CREATE TABLE queue_effect_probe (
        idempotency_key text PRIMARY KEY,
        effect_count integer NOT NULL DEFAULT 0
      )
    `);
  });

  afterAll(async () => {
    if (effectPool) {
      await effectPool.query('DROP TABLE IF EXISTS queue_effect_probe');
      await effectPool.end();
    }
    if (producer) await producer.stop();
  });

  test('FR-77a: submitted jobs persist and dedupe by their deterministic business ID', async () => {
    const idempotencyKey = `durable:${Date.now()}`;
    const options = { idempotencyKey, orderingKey: `durable:${Date.now()}` };
    const id = await producer.enqueue(queueLib.QUEUES.NOTIFICATIONS, { kind: 'test' }, options);
    const duplicate = await producer.enqueue(queueLib.QUEUES.NOTIFICATIONS, { kind: 'test' }, options);
    const stored = await producer.boss.findJobs(queueLib.QUEUES.NOTIFICATIONS, { id });

    expect(duplicate).toBeNull(); // pg-boss reports the ON CONFLICT dedupe as no new job.
    expect(stored).toEqual(expect.arrayContaining([expect.objectContaining({ id, state: 'created', data: { kind: 'test' } })]));
    await producer.boss.deleteJob(queueLib.QUEUES.NOTIFICATIONS, id);
  });

  test('FR-77a: enqueue in the state-change transaction rolls back with that transaction', async () => {
    const db = require('../../src/db.service');
    const idempotencyKey = `rollback:${Date.now()}`;
    const id = queueLib.deterministicJobId(queueLib.QUEUES.NOTIFICATIONS, idempotencyKey);

    await expect(db.withTransaction(async (client) => {
      await producer.enqueue(queueLib.QUEUES.NOTIFICATIONS, { kind: 'rollback' }, {
        idempotencyKey,
        orderingKey: idempotencyKey,
        transaction: client,
      });
      throw new Error('force business transaction rollback');
    })).rejects.toThrow('force business transaction rollback');

    expect(await producer.boss.findJobs(queueLib.QUEUES.NOTIFICATIONS, { id })).toHaveLength(0);
  });

  test('FR-77a: concurrent workers preserve per-key FIFO and process each durable job once', async () => {
    const first = queueLib.createQueueClient({ connectionString: databaseUrl, worker: true });
    const second = queueLib.createQueueClient({ connectionString: databaseUrl, worker: true });
    await Promise.all([first.start(), second.start()]);
    const order = [];
    let active = 0;
    let maxActive = 0;
    let resolveFinished;
    const finished = new Promise((resolve) => { resolveFinished = resolve; });
    let processed = 0;
    const handler = async ([job]) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${job.data.sequence}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
      order.push(`end:${job.data.sequence}`);
      active -= 1;
      processed += 1;
      if (processed === 2) resolveFinished();
    };
    await Promise.all([
      first.boss.work(queueLib.QUEUES.NOTIFICATIONS, { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 0.5 }, handler),
      second.boss.work(queueLib.QUEUES.NOTIFICATIONS, { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 0.5 }, handler),
    ]);

    const orderingKey = `fifo:${Date.now()}`;
    await producer.enqueue(queueLib.QUEUES.NOTIFICATIONS, { sequence: 1 }, {
      idempotencyKey: `${orderingKey}:1`, orderingKey,
    });
    await producer.enqueue(queueLib.QUEUES.NOTIFICATIONS, { sequence: 2 }, {
      idempotencyKey: `${orderingKey}:2`, orderingKey,
    });
    try {
      await withTimeout(finished, 10000, 'Workers timed out');
      expect(maxActive).toBe(1);
      expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }
  });

  test('FR-77a: transactionally completed effects are rolled back on failure and applied once after retry', async () => {
    const worker = queueLib.createQueueClient({ connectionString: databaseUrl, worker: true });
    await worker.start();
    let attempts = 0;
    let resolveFinished;
    const finished = new Promise((resolve) => { resolveFinished = resolve; });
    await worker.boss.work(queueLib.QUEUES.NOTIFICATIONS, {
      localConcurrency: 1, batchSize: 1, transactional: true, pollingIntervalSeconds: 0.5,
    }, async ([job], tx) => {
      attempts += 1;
      await tx.executeSql(
        'INSERT INTO queue_effect_probe (idempotency_key, effect_count) VALUES ($1, 1)',
        [job.data.idempotencyKey]
      );
      if (attempts === 1) throw new Error('simulated worker crash after database effect');
      resolveFinished();
    });

    const key = `retry:${Date.now()}`;
    await producer.enqueue(queueLib.QUEUES.NOTIFICATIONS, { idempotencyKey: key }, {
      idempotencyKey: key,
      orderingKey: key,
      retryLimit: 1,
      retryDelay: 1,
      retryBackoff: false,
    });
    try {
      await withTimeout(finished, 10000, 'Retry timed out');
      const { rows } = await effectPool.query('SELECT count(*)::int AS count FROM queue_effect_probe WHERE idempotency_key = $1', [key]);
      expect(attempts).toBe(2);
      expect(rows[0].count).toBe(1);
    } finally {
      await worker.stop();
    }
  });
});
