const express = require('express');
const request = require('supertest');
const routes = require('../../src/routes');
const { cachePolicy, getCachePolicyRule } = require('../../src/middleware/cachePolicy');
const devRoutes = require('../../src/routes/dev.routes');

const SAMPLE_UUID = '123e4567-e89b-42d3-a456-426614174000';
const ROUTE_MOUNTS = [...routes.routeMounts, ['/dev', devRoutes]];

function routeUrl(path) {
  return path.replace(/:([A-Za-z0-9_]+)(\.[^/]+)?/g, (_match, name, suffix = '') => {
    const value = name === 'hash' ? 'a'.repeat(64) : name === 'variant' ? 'medium' : SAMPLE_UUID;
    return `${value}${suffix}`;
  });
}

function createRouteWalkerApp() {
  const app = express();
  app.use('/api', cachePolicy);
  for (const [mountPath, sourceRouter] of ROUTE_MOUNTS) {
    const probeRouter = express.Router();
    for (const layer of sourceRouter.stack) {
      if (!layer.route) continue;
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const path of paths) {
        for (const method of Object.keys(layer.route.methods)) {
          probeRouter[method](path, (_req, res) => res.status(204).end());
        }
      }
    }
    app.use(`/api${mountPath}`, probeRouter);
  }
  return app;
}

describe('HTTP route cache-policy walker', () => {
  test('every registered API route is private/no-store unless explicitly allow-listed; public routes set no cookies', async () => {
    const app = createRouteWalkerApp();
    const walkedRoutes = [];
    for (const [mountPath, sourceRouter] of ROUTE_MOUNTS) {
      for (const layer of sourceRouter.stack) {
        if (!layer.route) continue;
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const path of paths) {
          for (const method of Object.keys(layer.route.methods)) {
            walkedRoutes.push({
              method: method.toUpperCase(),
              path: `/api${mountPath}${path === '/' ? '' : path}`,
              requestPath: routeUrl(`/api${mountPath}${path}`),
            });
          }
        }
      }
    }
    expect(walkedRoutes.length).toBeGreaterThan(50);

    for (const route of walkedRoutes) {
      const response = await request(app)[route.method.toLowerCase()](route.requestPath).expect(204);
      const publicRule = getCachePolicyRule(route.method, route.path);
      expect(response.headers['cache-control']).toBe(
        publicRule ? publicRule.cacheControl || `public, max-age=${publicRule.maxAge}` : 'private, no-store'
      );
      if (publicRule) expect(response.headers['set-cookie']).toBeUndefined();
    }
  });
});
