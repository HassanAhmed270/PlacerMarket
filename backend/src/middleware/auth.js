/**
 * middleware/auth.js
 *
 * These assume `req.user = { id, role }` has already been populated by
 * whatever session/auth strategy gets chosen (see the TODO in
 * users.service.js's authenticate() — cookie session vs JWT is not decided
 * yet). Wire the real session lookup in BEFORE these run; they only gate
 * on req.user once it exists.
 *
 * FR-22a/FR-22b: pure browsing routes should NOT use requireAuth — only the
 * specific gated actions (favorite, message, offer) need it.
 */

const { hasPermission } = require('../lib/roles');
const { ForbiddenError } = require('../lib/errors');

function requireAuth(req, res, next) {
  if (!req.user) {
    // FR-22b: frontend is responsible for the redirect-and-return-to-login
    // pattern; this middleware just returns 401 for the API to react to.
    return res.status(401).json({ error: 'Login required' });
  }
  next();
}

/**
 * @param {string | ((req) => string)} actionOrFn - a permission name from
 * lib/roles.js, or a function of the request returning one (for routes
 * where the needed permission depends on the body, e.g. approve vs reject).
 */
function requirePermission(actionOrFn) {
  return (req, res, next) => {
    const action = typeof actionOrFn === 'function' ? actionOrFn(req) : actionOrFn;
    if (!req.user || !hasPermission(req.user.role, action)) {
      return next(new ForbiddenError(`Not permitted: ${action}`));
    }
    next();
  };
}

module.exports = { requireAuth, requirePermission };
