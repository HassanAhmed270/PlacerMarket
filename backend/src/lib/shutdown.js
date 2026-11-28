function shutdownTimeout(env = process.env) {
  const raw = env.SHUTDOWN_TIMEOUT_MS;
  const value = raw === undefined || raw === '' ? 25000 : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Configuration error: SHUTDOWN_TIMEOUT_MS must be a positive integer.');
  }
  return value;
}

async function withDeadline(task, timeoutMs, logger, processRef = process) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Shutdown deadline exceeded')), timeoutMs);
  });
  try {
    await Promise.race([Promise.resolve().then(task), deadline]);
  } catch (error) {
    logger.error('Shutdown deadline exceeded', { code: 'SHUTDOWN_TIMEOUT' });
    processRef.exitCode = 1;
    if (typeof processRef.exit === 'function') processRef.exit(1);
  } finally {
    clearTimeout(timer);
  }
}

async function closeWebWithDeadline({
  server,
  queueClient,
  redis,
  hashPool,
  dbPool,
  searchPool,
  timeoutMs,
  logger,
  processRef = process,
  setReadinessUnavailable = () => {},
}) {
  setReadinessUnavailable();
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Shutdown deadline exceeded')), timeoutMs);
  });
  try {
    await Promise.race([
      (async () => {
        await new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
        });
        await queueClient.stopProducer();
        await redis.stop();
        await hashPool.close();
        await dbPool.end();
        await searchPool.end();
      })(),
      deadline,
    ]);
  } catch (error) {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    logger.error('Shutdown deadline exceeded', { code: 'SHUTDOWN_TIMEOUT' });
    if (typeof processRef.exit === 'function') processRef.exit(1);
    else processRef.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}

async function closeWorkerWithDeadline({
  queue,
  stopProducer,
  redis,
  db,
  timeoutMs,
  logger,
  processRef = process,
}) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Shutdown deadline exceeded')), timeoutMs);
  });
  try {
    await Promise.race([
      (async () => {
        await queue.stop();
        await stopProducer();
        await redis.stop();
        await db.pool.end();
        await db.searchPool.end();
      })(),
      deadline,
    ]);
  } catch {
    logger.error('Shutdown deadline exceeded', { code: 'SHUTDOWN_TIMEOUT' });
    if (typeof processRef.exit === 'function') processRef.exit(1);
    else processRef.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { shutdownTimeout, withDeadline, closeWebWithDeadline, closeWorkerWithDeadline };
