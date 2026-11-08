const adminRouter = require('../../src/routes/admin.routes');
const catalogRouter = require('../../src/routes/catalog.routes');
const deliveryRouter = require('../../src/routes/delivery.routes');
const disputesRouter = require('../../src/routes/disputes.routes');
const listingsRouter = require('../../src/routes/listings.routes');
const payoutRouter = require('../../src/routes/payout.routes');
const settlementRouter = require('../../src/routes/settlement.routes');
const { hasPermission } = require('../../src/lib/roles');

const ROUTERS = [
  ['/api/admin', adminRouter],
  ['/api/catalog', catalogRouter],
  ['/api/delivery', deliveryRouter],
  ['/api/disputes', disputesRouter],
  ['/api/listings', listingsRouter],
  ['/api/payout', payoutRouter],
  ['/api/settlement', settlementRouter],
];
const MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete']);

// These payout controls intentionally retain their existing security limiter.
const LIMITER_EXCEPTIONS = new Map([
  ['post /api/admin/payouts/:sellerId/hold', 'Existing security limiter is retained.'],
  ['post /api/admin/payouts/:sellerId/hold/clear', 'Existing security limiter is retained.'],
]);

function collectRoutes(router, prefix, routes = []) {
  for (const layer of router.stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({
          method,
          path: `${prefix}${layer.route.path}`,
          handlers: layer.route.stack.map((item) => item.handle),
        });
      }
    } else if (Array.isArray(layer.handle?.stack)) {
      collectRoutes(layer.handle, prefix, routes);
    }
  }
  return routes;
}

function permissionActions(permission) {
  if (typeof permission !== 'function') return [permission];
  return ['approved', 'rejected'].map((decision) =>
    permission({ body: { decision } })
  );
}

const staffMutations = ROUTERS.flatMap(([prefix, router]) => collectRoutes(router, prefix))
  .filter(({ method, handlers }) =>
    MUTATING_METHODS.has(method) &&
    handlers.some((handler) => {
      const actions = permissionActions(handler.requiredPermission);
      return actions.some((action) =>
        typeof action === 'string' &&
        hasPermission('admin', action) &&
        !hasPermission('buyer', action)
      );
    })
  );

describe('SEC-24: staff mutations have an Admin operations or deliberate security limiter', () => {
  test('every staff-only mutating route has its limiter after requirePermission', () => {
    expect(staffMutations.length).toBeGreaterThan(0);
    const foundExceptions = new Set();

    for (const route of staffMutations) {
      const key = `${route.method} ${route.path}`;
      const permissionIndex = route.handlers.findIndex(
        (handler) => handler.requiredPermission !== undefined
      );
      const limiterIndex = route.handlers.findIndex(
        (handler) => handler.rateLimitCategory === 'adminOps' ||
          handler.rateLimitCategory === 'security'
      );

      expect(permissionIndex).toBeGreaterThanOrEqual(0);
      expect(limiterIndex).toBeGreaterThan(permissionIndex);
      if (LIMITER_EXCEPTIONS.has(key)) {
        foundExceptions.add(key);
        expect(route.handlers[limiterIndex].rateLimitCategory).toBe('security');
      } else {
        expect(route.handlers[limiterIndex].rateLimitCategory).toBe('adminOps');
      }
    }

    expect(foundExceptions).toEqual(new Set(LIMITER_EXCEPTIONS.keys()));
  });
});
