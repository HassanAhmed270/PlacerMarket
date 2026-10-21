const { EventEmitter } = require('node:events');
const { PasswordHashPool } = require('../../src/lib/passwordHashPool');
const { ServiceUnavailableError } = require('../../src/lib/errors');

class ControlledWorker extends EventEmitter {
  postMessage(message) { this.pending = message; }
  finish(result) { this.emit('message', { id: this.pending.id, ok: true, result }); }
  terminate() { return Promise.resolve(0); }
}

describe('FR-84b: password hashing uses a bounded worker pool', () => {
  test('returns 503 when every configured worker is busy', async () => {
    const workers = [];
    const pool = new PasswordHashPool({ maxConcurrency: 1, workerFactory: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    } });
    const first = pool.hash('first-password', {});
    expect(() => pool.hash('second-password', {})).toThrow(ServiceUnavailableError);
    expect(pool.activeCount).toBe(1);
    workers[0].finish('hash-result');
    await expect(first).resolves.toBe('hash-result');
    await pool.close();
  });

  test('real Argon2id worker hashes and verifies without returning the password', async () => {
    const pool = new PasswordHashPool({ maxConcurrency: 1 });
    const password = 'worker-thread-password-test';
    try {
      const hash = await pool.hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
      expect(hash).toMatch(/^\$argon2id\$/);
      expect(hash).not.toContain(password);
      await expect(pool.verify(hash, password, {})).resolves.toBe(true);
      await expect(pool.verify(hash, 'incorrect-test-password', {})).resolves.toBe(false);
    } finally {
      await pool.close();
    }
  });
});
