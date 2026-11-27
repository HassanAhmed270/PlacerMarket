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
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { shutdownTimeout, withDeadline };
