/**
 * middleware/errorHandler.js
 *
 * Mount LAST in app.js, after all routers. Every custom error type in
 * lib/errors.js carries a statusCode; anything else falls back to 500.
 * NotYetSpecifiedError (501) surfaces its FR code in the response body so
 * the frontend/agent can tell "not built" apart from "actual server bug".
 */

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || 500;
  const body = { error: err.message || 'Internal server error' };
  if (err.frCode) body.frCode = err.frCode; // NotYetSpecifiedError
  if (statusCode >= 500) {
    // eslint-disable-next-line no-console
    console.error(err);
  }
  res.status(statusCode).json(body);
}

module.exports = errorHandler;
