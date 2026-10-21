const { EventEmitter } = require('events');

const queue = require('../../src/lib/queue');
const requestContext = require('../../src/lib/requestContext');

function fakeBossFactory() {
  const instance = new EventEmitter();
  instance.options = null;
  instance.queues = [];
  instance.sent = [];
  instance.started = false;
  instance.constructorOptions = null;
  return class FakeBoss extends EventEmitter {
    constructor(options) {
      super();
      instance.constructorOptions = options;
      Object.assign(this, instance);
    }

    async start() { this.started = true; }
    async stop() { this.started = false; }
    async createQueue(name, options) { this.queues.push({ name, options }); }
    async send(name, data, options) { this.sent.push({ name, data, options }); return options.id; }
    async findJobs(_name, options) {
      this.findJobsOptions = options;
      return [{ id: 'job', sourceName: 'media', sourceId: 'source', sourceRetryCount: 5, createdOn: 'date', state: 'created', data: { secret: 'omit' }, output: { message: 'omit' } }];
    }
    async getQueues() {
      return [
        {
          name: 'notifications', readyCount: 2, activeCount: 1, failedCount: 0, totalCount: 7,
          readyOldestSeconds: 12, createdDelta: 5, completedDelta: 3, failedDelta: 1, deltaSeconds: 60,
        },
        {
          name: 'dead-letter', readyCount: 2, activeCount: 0, failedCount: 0, totalCount: 2,
          readyOldestSeconds: 18, createdDelta: 0, completedDelta: 0, failedDelta: 0, deltaSeconds: 60,
        },
      ];
    }
  };
}

describe('FR-77, FR-77a: PostgreSQL queue configuration and durable enqueue API', () => {
  test('FR-77a: queue setup disables runtime migrations and configures retry, FIFO, and dead-letter behavior', async () => {
    const fakeBoss = fakeBossFactory();
    const client = queue.createQueueClient({ connectionString: 'postgres://local/db', PgBossClass: fakeBoss });
    await client.start();

    expect(client.boss.constructorOptions).toEqual(expect.objectContaining({
      schema: 'pgboss', migrate: false, createSchema: false, useListenNotify: false, schedule: false,
    }));
    expect(client.boss.queues).toHaveLength(5);
    expect(client.boss.queues.find(({ name }) => name === queue.QUEUES.EMAIL).options.retryLimit).toBe(5);
    expect(client.boss.queues.find(({ name }) => name === queue.QUEUES.NOTIFICATIONS).options)
      .toEqual(expect.objectContaining({ policy: 'key_strict_fifo', retryLimit: 5, retryBackoff: true, heartbeatSeconds: 60, deadLetter: queue.QUEUES.DEAD_LETTER, notify: true }));
    await client.stop();
  });

  test('FR-77a: transactional enqueue uses a deterministic ID and the caller transaction adapter', async () => {
    const client = queue.createQueueClient({ connectionString: 'postgres://local/db', PgBossClass: fakeBossFactory() });
    await client.start();
    const transaction = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const firstId = await client.enqueue(queue.QUEUES.NOTIFICATIONS, { eventName: 'listing.status_changed' }, {
      idempotencyKey: 'listing:42:published', orderingKey: 'listing:42', transaction,
    });
    const again = await client.enqueue(queue.QUEUES.NOTIFICATIONS, { eventName: 'listing.status_changed' }, {
      idempotencyKey: 'listing:42:published', orderingKey: 'listing:42', transaction,
    });

    expect(firstId).toBe(again);
    expect(client.boss.sent[0].options).toEqual(expect.objectContaining({
      id: firstId,
      singletonKey: 'listing:42',
      db: expect.objectContaining({ executeSql: expect.any(Function) }),
    }));
    await client.boss.sent[0].options.db.executeSql('select 1', []);
    expect(transaction.query).toHaveBeenCalledWith('select 1', []);
    await client.stop();
  });

  test('FR-77c: queue jobs carry the originating HTTP request ID for correlation', async () => {
    const client = queue.createQueueClient({ connectionString: 'postgres://local/db', PgBossClass: fakeBossFactory() });
    await client.start();

    await requestContext.withRequestId('request-correlation-123', () => client.enqueue(
      queue.QUEUES.NOTIFICATIONS,
      { eventName: 'listing.status_changed' },
      { idempotencyKey: 'listing:42:published', orderingKey: 'listing:42' }
    ));

    expect(client.boss.sent[0].data).toEqual({
      eventName: 'listing.status_changed',
      traceId: 'request-correlation-123',
    });
    await client.stop();
  });

  test('FR-77c: queue health exposes backlog age, persisted deltas, and dead-letter count', async () => {
    const client = queue.createQueueClient({ connectionString: 'postgres://local/db', PgBossClass: fakeBossFactory() });
    await client.start();

    const health = await client.getQueueHealth();

    expect(health).toEqual({
      queues: [
        expect.objectContaining({
          name: 'notifications', readyCount: 2, activeCount: 1, oldestReadySeconds: 12,
          createdDelta: 5, completedDelta: 3, terminalFailureDelta: 1, deltaSeconds: 60,
        }),
        expect.objectContaining({ name: 'dead-letter', totalCount: 2 }),
      ],
      deadLetterCount: 2,
    });
    await client.stop();
  });

  test('FR-77a: enqueue rejects unregistered queues, invalid keys, and oversized payloads', async () => {
    const client = queue.createQueueClient({ connectionString: 'postgres://local/db', PgBossClass: fakeBossFactory() });
    await client.start();
    await expect(client.enqueue('unregistered', {}, { idempotencyKey: 'x', orderingKey: 'x' })).rejects.toThrow('Unsupported queue');
    await expect(client.enqueue(queue.QUEUES.NOTIFICATIONS, {}, { idempotencyKey: 'x', orderingKey: '' })).rejects.toThrow('ordering key');
    await expect(client.enqueue(queue.QUEUES.NOTIFICATIONS, { body: 'x'.repeat(65536) }, { idempotencyKey: 'x', orderingKey: 'x' })).rejects.toThrow('64 KiB');
    await client.stop();
  });

  test('FR-77a: dead-letter listing is bounded and omits payload and error contents', async () => {
    const client = queue.createQueueClient({ connectionString: 'postgres://local/db', PgBossClass: fakeBossFactory() });
    await client.start();
    const result = await client.listDeadLetters({ limit: 20, after: 'cursor' });
    expect(result).toEqual([{
      id: 'job', sourceName: 'media', sourceId: 'source', sourceRetryCount: 5, createdOn: 'date', state: 'created',
    }]);
    expect(client.boss.findJobsOptions).toEqual({ limit: 20, after: 'cursor' });
    await expect(client.listDeadLetters({ limit: 101 })).rejects.toThrow('from 1 to 100');
    await client.stop();
  });

  test('FR-77a: worker queue configuration enables the notification listener with polling retained', () => {
    const client = queue.createQueueClient({ connectionString: 'postgres://local/db', worker: true, PgBossClass: fakeBossFactory() });
    expect(client.boss.constructorOptions).toEqual(expect.objectContaining({ useListenNotify: true, schedule: true }));
  });

  test('FR-77a: stable business keys map to UUID-form deterministic job IDs', () => {
    const id = queue.deterministicJobId(queue.QUEUES.NOTIFICATIONS, 'event:order:42:paid');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(queue.deterministicJobId(queue.QUEUES.NOTIFICATIONS, 'event:order:42:paid')).toBe(id);
    expect(queue.deterministicJobId(queue.QUEUES.MEDIA, 'event:order:42:paid')).not.toBe(id);
  });
});
