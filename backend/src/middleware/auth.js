/**
 * middleware/auth.js
 *
 * Protected routes accept a short-lived HS256 bearer token only. The token
 * identifies the user; current role and suspension state are read from the
 * database on every request (SEC-07). Cookies are never authentication here.
 *
 * FR-22a/FR-22b: pure browsing routes should NOT use requireAuth — only the
 * specific gated actions (favorite, message, offer) need it.
 */

const { hasPermission } = require('../lib/roles');
const users = require('../modules/users.service');
const { getJwtConfig, verifyAccessToken } = require('../lib/jwt');
const { ForbiddenError } = require('../lib/errors');

async function authenticateRequest(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) return res.status(401).json({ error: 'Login required', requestId: req.requestId });
  let claims;
  try {
    claims = verifyAccessToken(match[1], getJwtConfig());
  } catch (error) {
    if (error instanceof TypeError) {
      return res.status(401).json({ error: 'Login required', requestId: req.requestId });
    }
    return next(error);
  }
  try {
    const principal = claims.sid
      ? await users.getAuthenticationPrincipal(claims.sub, claims.sid)
      : await users.getAuthenticationPrincipal(claims.sub);
    if (!principal || principal.is_suspended) {
      return res.status(401).json({ error: 'Login required', requestId: req.requestId });
    }
    req.user = { id: principal.id, role: principal.role };
    if (claims.sid) req.authSessionId = claims.sid;
    if (principal.enrollment_only) {
      const path = req.originalUrl.split('?')[0];
      const allowed = (req.method === 'POST' && [
        '/api/users/me/authenticator/enroll',
        '/api/users/me/authenticator/confirm',
        '/api/users/logout',
      ].includes(path));
      if (!allowed) return res.status(403).json({ error: 'Authenticator enrollment is required before using this session.' });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

const requireAuth = authenticateRequest;

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

module.exports = { requireAuth, requirePermission, authenticateRequest };
