const { recordRequestStatus } = require('../lib/metrics');

function metricsMiddleware(_req, res, next) {
  res.on('finish', () => recordRequestStatus(res.statusCode));
  next();
}

module.exports = metricsMiddleware;
