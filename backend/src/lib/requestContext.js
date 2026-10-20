const { AsyncLocalStorage } = require('async_hooks');

const requestContext = new AsyncLocalStorage();

function withRequestId(requestId, callback) {
  return requestContext.run({ requestId }, callback);
}

function getRequestId() {
  return requestContext.getStore()?.requestId ?? null;
}

module.exports = { withRequestId, getRequestId };
