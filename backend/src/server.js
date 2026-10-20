const app = require('./app');
const { pool } = require('./db.service');
const queue = require('./lib/queue');
const { createRedisClient } = require('./lib/redis');
const { getJwtConfig } = require('./lib/jwt');

/** FR-77: start the web process without registering or executing queue jobs. */
async function startServer() {
  getJwtConfig();
  const redis = createRedisClient();
  try {
    await redis.start();
    await queue.startProducer();
    const port = process.env.PORT || 3000;
    const server = await new Promise((resolve, reject) => {
      const listener = app.listen(port, () => resolve(listener));
      listener.once('error', reject);
    });
    // eslint-disable-next-line no-console
    console.log(`Poshaak backend listening on port ${port}`);

    let shuttingDown;
    async function shutdown(signal) {
      if (shuttingDown) return shuttingDown;
      shuttingDown = (async () => {
        // eslint-disable-next-line no-console
        console.log(`Poshaak backend shutting down (${signal})`);
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await queue.stopProducer();
        await redis.stop();
        await pool.end();
      })();
      return shuttingDown;
    }
    process.once('SIGINT', () => shutdown('SIGINT').catch((error) => {
      console.error('Web shutdown failed', { code: error?.code || 'unknown' });
      process.exitCode = 1;
    }));
    process.once('SIGTERM', () => shutdown('SIGTERM').catch((error) => {
      console.error('Web shutdown failed', { code: error?.code || 'unknown' });
      process.exitCode = 1;
    }));
    return { server, shutdown };
  } catch (error) {
    await queue.stopProducer().catch(() => {});
    await redis.stop().catch(() => {});
    await pool.end().catch(() => {});
    throw error;
  }
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Web startup failed', { code: error?.code || 'unknown' });
    process.exitCode = 1;
  });
}

module.exports = { startServer };
