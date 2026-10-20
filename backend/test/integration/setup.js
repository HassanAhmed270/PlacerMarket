const getTestDatabaseUrl = require('./database-url');
const testDatabaseUrl = getTestDatabaseUrl();
const eventBus = require('../../src/lib/eventBus');

// Track async integration listeners without changing application behavior.
const pendingListenerTasks = new Set();
const listenerErrors = [];
const originalOn = eventBus.on;
eventBus.on = function trackAsyncListener(event, listener) {
  return originalOn.call(this, event, (...args) => {
    const result = listener(...args);
    if (result && typeof result.then === 'function') {
      const task = Promise.resolve(result);
      pendingListenerTasks.add(task);
      task.catch((error) => listenerErrors.push(error)).finally(() => pendingListenerTasks.delete(task));
    }
    return result;
  });
};

global.drainIntegrationListeners = async (timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (pendingListenerTasks.size && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await Promise.race([
      Promise.allSettled([...pendingListenerTasks]),
      new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 25))),
    ]);
  }
  if (pendingListenerTasks.size) throw new Error('Timed out waiting for pending asynchronous integration listener writes.');
  if (listenerErrors.length) {
    const error = listenerErrors.shift();
    listenerErrors.length = 0;
    throw new Error(`Asynchronous integration listener failed: ${error.message}`);
  }
};

// db.service.js creates its Pool as soon as it is required by an integration test.
process.env.DATABASE_URL = testDatabaseUrl;

afterAll(async () => {
  // Require only after DATABASE_URL is set above; tests may already have loaded it.
  const servicePool = require('../../src/db.service').pool;
  await servicePool.end();
});
