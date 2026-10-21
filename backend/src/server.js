const { pool } = require('./db.service');
const queue = require('./lib/queue');
const { createRedisClient } = require('./lib/redis');
const { getJwtConfig } = require('./lib/jwt');

function safeConfigurationMessage(error) {
  const message = error?.message;
  if (typeof message === 'string' && /^(JWT_ACCESS_SECRET|JWT_ACCESS_TTL_SECONDS|REDIS_URL|CORS_ORIGINS)\b/.test(message)) {
    return message;
  }
  return null;
}

/** FR-77: start the web process without registering or executing queue jobs. */
async function startServer({
  loadApp = () => require('./app'),
  dbPool = pool,
  queueClient = queue,
  redisFactory = createRedisClient,
  validateJwt = getJwtConfig,
  logger = console,
} = {}) {
  let redis;
  let queueStartAttempted = false;
  let stage = 'configuration';
  try {
    validateJwt();
    redis = redisFactory();
    const app = loadApp(); // CORS configuration is validated while app is loaded.

    stage = 'redis';
    await redis.start();
    stage = 'queue';
    queueStartAttempted = true;
    await queueClient.startProducer();
    const port = process.env.PORT || 3000;
    stage = 'listen';
    const server = await new Promise((resolve, reject) => {
      const listener = app.listen(port, () => resolve(listener));
      listener.once('error', reject);
    });
    logger.log(`Poshaak backend listening on port ${port}`);

    let shuttingDown;
    async function shutdown(signal) {
      if (shuttingDown) return shuttingDown;
      shuttingDown = (async () => {
        logger.log(`Poshaak backend shutting down (${signal})`);
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await queueClient.stopProducer();
        await redis.stop();
        await dbPool.end();
      })();
      return shuttingDown;
    }
    process.once('SIGINT', () => shutdown('SIGINT').catch((error) => {
      logger.error('Web shutdown failed', { code: error?.code || 'unknown' });
      process.exitCode = 1;
    }));
    process.once('SIGTERM', () => shutdown('SIGTERM').catch((error) => {
      logger.error('Web shutdown failed', { code: error?.code || 'unknown' });
      process.exitCode = 1;
    }));
    return { server, shutdown };
  } catch (error) {
    if (queueStartAttempted) await queueClient.stopProducer().catch(() => {});
    if (redis) await redis.stop().catch(() => {});
    await dbPool.end().catch(() => {});
    const configurationMessage = stage === 'configuration' ? safeConfigurationMessage(error) : null;
    if (configurationMessage) logger.error(configurationMessage);
    else if (stage === 'redis') logger.error(`Redis unavailable (${error?.code || 'unknown'})`);
    else logger.error('Web startup failed', { code: error?.code || 'unknown' });
    throw error;
  }
}

if (require.main === module) {
  startServer().catch(() => { process.exitCode = 1; });
}

module.exports = { startServer };
