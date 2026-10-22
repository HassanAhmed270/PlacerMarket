const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createDevEmailOutboxSender, readDevEmailOutbox, clearDevEmailOutbox,
} = require('../../src/lib/adapters/devEmailOutbox');

describe('Stage 8 development email outbox', () => {
  let directory;
  let outboxPath;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'poshaak-outbox-test-'));
    outboxPath = path.join(directory, 'outbox.jsonl');
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  test('dev fake refuses unless explicitly enabled outside production and leaves no outbox file', async () => {
    const env = { DEV_EMAIL_OUTBOX_PATH: outboxPath };
    expect(() => createDevEmailOutboxSender({ env })).toThrow('DEV_FAKES=1');
    expect(() => createDevEmailOutboxSender({ env: { ...env, DEV_FAKES: '1', NODE_ENV: 'production' } }))
      .toThrow('non-production');
    await expect(fs.access(outboxPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('dev outbox refuses paths outside the operating-system temporary directory', () => {
    expect(() => createDevEmailOutboxSender({ env: {
      DEV_FAKES: '1', NODE_ENV: 'development', DEV_EMAIL_OUTBOX_PATH: path.join(process.cwd(), 'unsafe-outbox.jsonl'),
    } })).toThrow('temporary directory');
  });

  test('explicit dev fake writes messages readable through the dev outbox and can clear it', async () => {
    const env = { DEV_FAKES: '1', NODE_ENV: 'development', DEV_EMAIL_OUTBOX_PATH: outboxPath };
    const sender = createDevEmailOutboxSender({ env, now: () => new Date('2026-10-22T00:00:00.000Z') });
    await sender.send({ to: 'demo@example.test', subject: 'Verification', text: 'Demo code 123456' });
    await expect(readDevEmailOutbox({ env })).resolves.toEqual([{
      receivedAt: '2026-10-22T00:00:00.000Z', to: 'demo@example.test', subject: 'Verification', text: 'Demo code 123456',
    }]);
    await clearDevEmailOutbox({ env });
    await expect(readDevEmailOutbox({ env })).resolves.toEqual([]);
  });
});
