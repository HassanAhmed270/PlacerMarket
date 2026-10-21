const { parentPort } = require('node:worker_threads');
const argon2 = require('argon2');

parentPort.on('message', async (message) => {
  try {
    const result = message.operation === 'hash'
      ? await argon2.hash(message.password, {
        type: argon2.argon2id,
        memoryCost: message.options.memoryCost,
        timeCost: message.options.timeCost,
        parallelism: message.options.parallelism,
      })
      : await argon2.verify(message.hash, message.password);
    parentPort.postMessage({ id: message.id, ok: true, result });
  } catch {
    parentPort.postMessage({ id: message.id, ok: false });
  }
});
