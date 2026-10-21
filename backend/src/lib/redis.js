/** FR-77: manage the Redis connection shared by the web and worker processes. */

const { createClient } = require('redis');

let sharedClient = null;

function setSharedRedisClient(client) {
  sharedClient = client || null;
}

function getSharedRedisClient() {
  return sharedClient;
}

function createRedisClient({ url = process.env.REDIS_URL, clientFactory = createClient, logger = console } = {}) {
  if (!url) throw new Error('REDIS_URL is required to start the Redis client.');
  const parsed = new URL(url);
  if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('REDIS_URL must use redis:// or rediss:// and include a host.');
  }

  const client = clientFactory({ url });
  setSharedRedisClient(client);
  client.on('error', (error) => {
    logger.error('Redis connection error', { code: error?.code || 'unknown' });
  });

  return {
    client,
    async start() {
      if (!client.isOpen) await client.connect();
      await client.ping();
    },
    async stop() {
      if (client.isOpen) await client.quit();
    },
  };
}

module.exports = { createRedisClient, getSharedRedisClient, setSharedRedisClient };
