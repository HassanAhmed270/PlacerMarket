/**
 * middleware/errorHandler.js
 *
 * Mount LAST in app.js, after all routers. Every custom error type in
 * lib/errors.js carries a statusCode; unknown failures become a generic 500.
 * Unknown server errors are logged with a request ID, never returned raw.
 */

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const parserStatus = err.type === 'entity.too.large'
    ? 413
    : err instanceof SyntaxError && 'body' in err ? 400 : null;
  const statusCode = parserStatus || err.statusCode || 500;
  const knownError = !parserStatus && (statusCode < 500 || statusCode === 501);
  const message = knownError
    ? err.message
    : statusCode === 413 ? 'Request body too large'
      : statusCode === 400 ? 'Invalid request body' : 'Internal server error';
  const body = { error: message };
  if (statusCode >= 500) body.requestId = req.requestId;
  if (err.frCode) body.frCode = err.frCode; // NotYetSpecifiedError
  if (statusCode >= 500) {
    // eslint-disable-next-line no-console
    console.error('Request failed', {
      requestId: req.requestId,
      errorName: err.name || 'Error',
      code: err.code || 'unknown',
    });
  }
  res.status(statusCode).json(body);
}

module.exports = errorHandler;
