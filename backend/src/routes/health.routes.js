const express = require('express');
const { pool } = require('../db.service');
const { getSharedRedisClient } = require('../lib/redis');

const router = express.Router();
let shuttingDown = false;
function setShuttingDown(value) { shuttingDown = Boolean(value); }

function withTimeout(promise, milliseconds = 1000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('health timeout')), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

router.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store').status(200).json({ status: 'ok' });
});

router.get('/readyz', async (_req, res) => {
  if (shuttingDown) {
    res.set('Cache-Control', 'no-store').status(503).json({ status: 'unavailable' });
    return;
  }
  try {
    const redis = getSharedRedisClient();
    if (!redis || typeof redis.ping !== 'function') throw new Error('Redis unavailable');
    await Promise.all([
      withTimeout(pool.query('SELECT 1')),
      withTimeout(redis.ping()),
    ]);
    res.set('Cache-Control', 'no-store').status(200).json({ status: 'ready' });
  } catch {
    res.set('Cache-Control', 'no-store').status(503).json({ status: 'unavailable' });
  }
});

module.exports = router;
module.exports.setShuttingDown = setShuttingDown;
