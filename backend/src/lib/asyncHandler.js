/**
 * lib/asyncHandler.js
 * Wrap an async route handler so a thrown/rejected error reaches
 * middleware/errorHandler.js instead of crashing the process.
 */
module.exports = function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
};
