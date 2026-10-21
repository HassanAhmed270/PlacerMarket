const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { ServiceUnavailableError } = require('./errors');
const { getSecurityLimits } = require('../config');

class PasswordHashPool {
  constructor({
    maxConcurrency,
    workerPath = path.join(__dirname, 'passwordHashWorker.js'),
    workerFactory = (filename) => new Worker(filename),
  }) {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new TypeError('Password worker concurrency must be a positive integer.');
    }
    this.maxConcurrency = maxConcurrency;
    this.workerPath = workerPath;
    this.workerFactory = workerFactory;
    this.workers = [];
    this.nextTaskId = 1;
    this.closed = false;
  }

  get activeCount() { return this.workers.filter((slot) => slot.busy).length; }

  _createWorker() {
    const worker = this.workerFactory(this.workerPath);
    const slot = { worker, busy: false, task: null };
    worker.on('message', (message) => {
      if (!slot.task || message?.id !== slot.task.id) return;
      const task = slot.task;
      slot.task = null;
      slot.busy = false;
      if (message.ok) task.resolve(message.result);
      else task.reject(new Error('Password processing failed.'));
    });
    worker.on('error', () => this._failWorker(slot));
    worker.on('exit', (code) => {
      if (code !== 0 || slot.task) this._failWorker(slot);
      else this._removeWorker(slot);
    });
    this.workers.push(slot);
    return slot;
  }

  _removeWorker(slot) {
    const index = this.workers.indexOf(slot);
    if (index >= 0) this.workers.splice(index, 1);
  }

  _failWorker(slot) {
    const task = slot.task;
    slot.task = null;
    slot.busy = false;
    this._removeWorker(slot);
    if (task) task.reject(new Error('Password processing failed.'));
    slot.worker.terminate().catch(() => {});
  }

  _run(operation, data) {
    if (this.closed) throw new ServiceUnavailableError('Password processing is temporarily unavailable.');
    let slot = this.workers.find((candidate) => !candidate.busy);
    if (!slot && this.workers.length < this.maxConcurrency) slot = this._createWorker();
    if (!slot) throw new ServiceUnavailableError('Password processing capacity is temporarily full.');

    const id = this.nextTaskId++;
    slot.busy = true;
    return new Promise((resolve, reject) => {
      slot.task = { id, resolve, reject };
      slot.worker.postMessage({ id, operation, ...data });
    });
  }

  hash(password, options) {
    if (typeof password !== 'string') throw new TypeError('A password string is required.');
    return this._run('hash', { password, options });
  }

  verify(hash, password, options) {
    if (typeof hash !== 'string' || typeof password !== 'string') {
      throw new TypeError('A password hash and password string are required.');
    }
    return this._run('verify', { hash, password, options });
  }

  async close() {
    this.closed = true;
    const workers = this.workers.splice(0);
    for (const slot of workers) {
      if (slot.task) {
        slot.task.reject(new ServiceUnavailableError('Password processing stopped.'));
        slot.task = null;
      }
      slot.busy = false;
    }
    await Promise.all(workers.map((slot) => slot.worker.terminate().catch(() => {})));
  }
}

const limits = getSecurityLimits();
const passwordHashPool = new PasswordHashPool({ maxConcurrency: limits.PASSWORD_HASH_MAX_CONCURRENCY });
const hashOptions = Object.freeze({
  memoryCost: limits.ARGON2_MEMORY_KIB,
  timeCost: limits.ARGON2_TIME_COST,
  parallelism: limits.ARGON2_PARALLELISM,
});

function hashPassword(password) { return passwordHashPool.hash(password, hashOptions); }
function verifyPassword(hash, password) { return passwordHashPool.verify(hash, password, hashOptions); }

module.exports = { PasswordHashPool, passwordHashPool, hashPassword, verifyPassword };
