const { randomUUID } = require('node:crypto');
const { logger } = require('../lib/logger');

function accessLog(req, res, next) {
  req.requestId ||= randomUUID();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const route = req.route
      ? `${req.baseUrl || ''}${req.route.path}`
      : (req.baseUrl || 'unknown');
    logger.info('request completed', {
      requestId: req.requestId,
      route,
      method: req.method,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
    });
  });
  next();
}

module.exports = accessLog;
