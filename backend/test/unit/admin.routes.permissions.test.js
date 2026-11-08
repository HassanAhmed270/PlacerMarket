/**
 * Enforces rules.md Section 5 for the admin router. Permission checks live
 * at the route layer only, so a route added without requirePermission() is
 * an open door — this test walks EVERY route on admin.routes.js and fails
 * if a buyer can get past the gate.
 */
jest.mock('../../src/db.service'); // handlers that slip past a gate must fail fast, not hit a real DB
jest.mock('../../src/middleware/auth', () => ({
  requireAuth: (_req, _res, next) => next(),
  requirePermission: jest.requireActual('../../src/middleware/auth').requirePermission,
}));
jest.mock('../../src/modules/disputes.service', () => ({
  resolveDispute: jest.fn().mockResolvedValue({ id: 'dispute-1', status: 'resolved_release' }),
}));

const express = require('express');
const request = require('supertest');
const adminRouter = require('../../src/routes/admin.routes');
const disputesRouter = require('../../src/routes/disputes.routes');
const errorHandler = require('../../src/middleware/errorHandler');

function appAs(role) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'u1', role }; next(); });
  app.use('/api/admin', adminRouter);
  app.use('/api/disputes', disputesRouter);
  app.use(errorHandler);
  return app;
}

const routes = adminRouter.stack
  .filter((layer) => layer.route)
  .flatMap((layer) =>
    Object.keys(layer.route.methods).map((method) => ({
      method,
      path: `/api/admin${layer.route.path.replace(/:\w+/g, 'x')}`,
    }))
  );

// FR-05a: admin-only actions a Moderator/Ops account must NOT reach.
const ADMIN_ONLY_PATHS = [
  '/api/admin/users/x/suspend',
  '/api/admin/sellers/x/identity-verification',
  '/api/admin/payouts',
  '/api/admin/payouts/x/hold',
  '/api/admin/payouts/x/hold/clear',
  '/api/admin/operations-overview',
  '/api/admin/delivery-partners',
  '/api/admin/delivery-cities',
  '/api/admin/delivery-cities/x',
  '/api/admin/fees/commission',
  '/api/admin/advertising-overview',
  '/api/admin/listing-search/synonyms',
  '/api/admin/listing-search/synonyms/x',
];
const DELIVERY_ADMIN_ONLY_PATHS = [
  { method: 'patch', path: '/api/admin/orders/x/delivery' },
  { method: 'post', path: '/api/admin/orders/x/delivered' },
  { method: 'get', path: '/api/admin/orders' },
  { method: 'get', path: '/api/admin/orders/x' },
  { method: 'get', path: '/api/admin/order-exceptions' },
];

beforeAll(() => jest.spyOn(console, 'error').mockImplementation(() => {})); // errorHandler logs 5xx
afterAll(() => console.error.mockRestore());

describe('admin routes: permission gates at the route layer', () => {
  test('the router actually has routes (guards against the walk silently finding none)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(10);
  });

  test.each(routes)('buyer is blocked (403) on $method $path', async ({ method, path }) => {
    const res = await request(appAs('buyer'))[method](path).send({});
    expect(res.status).toBe(403);
  });

  test.each(ADMIN_ONLY_PATHS)('moderator is blocked (403) on admin-only %s', async (path) => {
    const route = routes.find((r) => r.path === path);
    expect(route).toBeDefined();
    const res = await request(appAs('moderator'))[route.method](path).send({});
    expect(res.status).toBe(403);
  });

  test.each(DELIVERY_ADMIN_ONLY_PATHS)('buyer, seller, and moderator are blocked on delivery admin $method $path', async ({ method, path }) => {
    for (const role of ['buyer', 'seller', 'moderator']) {
      const res = await request(appAs(role))[method](path).send({});
      expect(res.status).toBe(403);
    }
  });

  test('moderator is NOT blocked by the gate on a moderator-allowed route', async () => {
    const res = await request(appAs('moderator')).post('/api/admin/listings/x/approve').send({});
    expect(res.status).not.toBe(403); // gets past the gate (then fails on the mocked DB — irrelevant here)
  });

  test('FR-05a: only Admin can resolve a dispute; Moderator keeps dispute review access', async () => {
    const moderatorResolve = await request(appAs('moderator'))
      .post('/api/disputes/dispute-1/resolve').send({ resolutionAmountToBuyer: 0 });
    const moderatorList = await request(appAs('moderator')).get('/api/disputes');
    const adminResolve = await request(appAs('admin'))
      .post('/api/disputes/dispute-1/resolve').send({ resolutionAmountToBuyer: 0 });

    expect(moderatorResolve.status).toBe(403);
    expect(moderatorList.status).not.toBe(403);
    expect(adminResolve.status).toBe(200);
  });

  test('seller-application review needs approve vs reject permission by body.decision', async () => {
    const res = await request(appAs('buyer')).post('/api/admin/seller-applications/x/review').send({ decision: 'approved' });
    expect(res.status).toBe(403);
  });

  test('FR-66: manual verification rejects identity document or number fields without persisting them', async () => {
    const res = await request(appAs('admin')).post('/api/admin/sellers/x/identity-verification')
      .send({ note: 'Identity checked', cnic: 'must-not-be-accepted' });
    expect(res.status).toBe(400);
    expect(res.body).not.toHaveProperty('cnic');
  });
});
