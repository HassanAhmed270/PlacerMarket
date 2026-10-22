const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_OUTBOX_PATH = path.join(os.tmpdir(), 'poshaak-dev-email-outbox.jsonl');

function getOutboxPath(env = process.env) {
  const target = path.resolve(env.DEV_EMAIL_OUTBOX_PATH || DEFAULT_OUTBOX_PATH);
  const relative = path.relative(os.tmpdir(), target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Development email outbox must remain under the operating-system temporary directory.');
  }
  return target;
}

function createDevEmailOutboxSender({ env = process.env, now = () => new Date() } = {}) {
  if (env.NODE_ENV === 'production' || env.DEV_FAKES !== '1') {
    throw new Error('Development email outbox requires non-production DEV_FAKES=1.');
  }
  const outboxPath = getOutboxPath(env);
  return Object.freeze({
    kind: 'fake',
    async send(message) {
      if (!message || typeof message.to !== 'string' || typeof message.subject !== 'string' || typeof message.text !== 'string') {
        throw new TypeError('Email messages require to, subject, and text fields.');
      }
      const record = { receivedAt: now().toISOString(), to: message.to, subject: message.subject, text: message.text };
      await fs.appendFile(outboxPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
      return { accepted: true };
    },
  });
}

async function readDevEmailOutbox({ env = process.env, limit = 100 } = {}) {
  if (env.NODE_ENV === 'production' || env.DEV_FAKES !== '1') {
    throw new Error('Development email outbox is disabled.');
  }
  const raw = await fs.readFile(getOutboxPath(env), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return raw.split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => JSON.parse(line));
}

async function clearDevEmailOutbox({ env = process.env } = {}) {
  if (env.NODE_ENV === 'production' || env.DEV_FAKES !== '1') {
    throw new Error('Development email outbox is disabled.');
  }
  await fs.unlink(getOutboxPath(env)).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

module.exports = { DEFAULT_OUTBOX_PATH, getOutboxPath, createDevEmailOutboxSender, readDevEmailOutbox, clearDevEmailOutbox };
