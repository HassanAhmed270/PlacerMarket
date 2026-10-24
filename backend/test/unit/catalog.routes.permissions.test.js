jest.mock('../../src/modules/catalog.service', () => ({
  listMainCategories: jest.fn(async () => []),
  listSubCategories: jest.fn(async () => []),
  createMainCategory: jest.fn(async () => ({})),
  listConditionTypes: jest.fn(() => []),
  getMeasurementFieldDefs: jest.fn(async () => []),
  setMeasurementFieldDefs: jest.fn(async () => []),
  getManagedAttributeApprovalQueue: jest.fn(async () => []),
  approveManagedAttributeValue: jest.fn(async () => ({})),
  rejectManagedAttributeValue: jest.fn(async () => ({})),
}));
jest.mock('../../src/modules/listings.service', () => ({
  getReferencedMeasurementDefinitionIds: jest.fn(async () => []),
}));
jest.mock('../../src/middleware/auth', () => ({
  requireAuth: (_req, _res, next) => next(),
  requirePermission: jest.requireActual('../../src/middleware/auth').requirePermission,
}));

const express = require('express');
const request = require('supertest');
const catalogRoutes = require('../../src/routes/catalog.routes');
const errorHandler = require('../../src/middleware/errorHandler');

function appAs(role) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'u1', role }; next(); });
  app.use('/api/catalog', catalogRoutes);
  app.use(errorHandler);
  return app;
}

describe('catalog management route permissions', () => {
  test.each(['buyer', 'seller', 'moderator'])('%s cannot read retired measurement definitions', async (role) => {
    const response = await request(appAs(role)).get('/api/catalog/sub-categories/x/measurement-fields/admin');
    expect(response.status).toBe(403);
  });

  test.each(['buyer', 'seller', 'moderator'])('%s cannot access custom attribute approvals', async (role) => {
    const response = await request(appAs(role)).get('/api/catalog/attribute-approval-queue');
    expect(response.status).toBe(403);
  });

  test('FR-15a: Admin can read retired definitions and save an updated measurement field set', async () => {
    const app = appAs('admin');
    expect((await request(app).get('/api/catalog/sub-categories/x/measurement-fields/admin')).status).toBe(200);
    expect((await request(app).put('/api/catalog/sub-categories/x/measurement-fields').send({
      fieldDefs: [{ fieldName: 'chest', required: true }],
    })).status).toBe(200);
    expect((await request(app).get('/api/catalog/attribute-approval-queue')).status).toBe(200);
  });
});
