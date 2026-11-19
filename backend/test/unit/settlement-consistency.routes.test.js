jest.mock('../../src/db.service');
jest.mock('../../src/modules/settlementConsistency.service', () => ({
  listSettlementConsistencyFindings: jest.fn().mockResolvedValue({
    findings: [{ id: 'finding-1' }],
    nextCursor: null,
  }),
}));
jest.mock('../../src/middleware/auth', () => ({
  requireAuth: (_req, _res, next) => next(),
  requirePermission: jest.requireActual('../../src/middleware/auth').requirePermission,
}));

const express = require('express');
const request = require('supertest');
const { setSharedRedisClient } = require('../../src/lib/redis');
const settlementConsistency = require('../../src/modules/settlementConsistency.service');
const adminRouter = require('../../src/routes/admin.routes');
const errorHandler = require('../../src/middleware/errorHandler');

setSharedRedisClient({ isOpen: true, eval: async () => [1, 1] });

function appAs(role) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', role };
    next();
  });
  app.use('/api/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

describe('FR-70: Admin consistency findings endpoint', () => {
  beforeEach(() => jest.clearAllMocks());

  test('FR-70: only Admin can read uncached consistency findings', async () => {
    const response = await request(appAs('admin'))
      .get('/api/admin/consistency-findings?limit=20&cursor=cursor-value')
      .expect(200);

    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toEqual({ findings: [{ id: 'finding-1' }], nextCursor: null });
    expect(settlementConsistency.listSettlementConsistencyFindings).toHaveBeenCalledWith({
      limit: '20',
      cursor: 'cursor-value',
    });

    await request(appAs('moderator')).get('/api/admin/consistency-findings').expect(403);
    await request(appAs('buyer')).get('/api/admin/consistency-findings').expect(403);
    expect(settlementConsistency.listSettlementConsistencyFindings).toHaveBeenCalledTimes(1);
  });
});
