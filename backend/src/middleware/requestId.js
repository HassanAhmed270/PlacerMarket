const { randomUUID } = require('crypto');
const { withRequestId } = require('../lib/requestContext');

function requestId(req, res, next) {
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  return withRequestId(req.requestId, next);
}

module.exports = requestId;
