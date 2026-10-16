/**
 * Enforces rules.md Section 5 for the admin router. Permission checks live
 * at the route layer only, so a route added without requirePermission() is
 * an open door — this test walks EVERY route on admin.routes.js and fails
 * if a buyer can get past the gate.
 */
jest.mock('../../src/db.service'); // handlers that slip past a gate must fail fast, not hit a real DB

const express = require('express');
const request = require('supertest');
const adminRouter = require('../../src/routes/admin.routes');
const errorHandler = require('../../src/middleware/errorHandler');

function appAs(role) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'u1', role }; next(); });
  app.use('/api/admin', adminRouter);
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
  '/api/admin/operations-overview',
  '/api/admin/delivery-partners',
  '/api/admin/fees/commission',
  '/api/admin/advertising-overview',
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

  test('moderator is NOT blocked by the gate on a moderator-allowed route', async () => {
    const res = await request(appAs('moderator')).post('/api/admin/listings/x/approve').send({});
    expect(res.status).not.toBe(403); // gets past the gate (then fails on the mocked DB — irrelevant here)
  });

  test('seller-application review needs approve vs reject permission by body.decision', async () => {
    const res = await request(appAs('buyer')).post('/api/admin/seller-applications/x/review').send({ decision: 'approved' });
    expect(res.status).toBe(403);
  });
});
