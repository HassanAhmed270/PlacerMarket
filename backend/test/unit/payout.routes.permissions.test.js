jest.mock('../../src/modules/payout.service', () => ({ forceReleasePayoutEarly: jest.fn().mockResolvedValue({ released: true }) }));
jest.mock('../../src/modules/users.service', () => ({ consumeStepUpGrant: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.authSessionId = 'session-1'; next(); },
  requirePermission: jest.requireActual('../../src/middleware/auth').requirePermission,
}));

const express = require('express');
const request = require('supertest');
const payout = require('../../src/modules/payout.service');
const users = require('../../src/modules/users.service');
const router = require('../../src/routes/payout.routes');

function appAs(role) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'admin-1', role }; next(); });
  app.use('/api/payout', router);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message }));
  return app;
}

describe('FR-83f: force release requires the dedicated permission and a session-bound step-up grant', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('moderators are denied and an Admin request without a grant is rejected', async () => {
    const denied = await request(appAs('moderator')).post('/api/payout/orders/order-1/force-release')
      .send({ reasonNote: 'Approved exception' });
    expect(denied.status).toBe(403);
    const missing = await request(appAs('admin')).post('/api/payout/orders/order-1/force-release')
      .send({ reasonNote: 'Approved exception' });
    expect(missing.status).toBe(400);
    expect(users.consumeStepUpGrant).not.toHaveBeenCalled();
  });

  test('Admin consumes a grant for the force-release action before invoking payout release', async () => {
    const response = await request(appAs('admin')).post('/api/payout/orders/order-1/force-release')
      .set('X-Step-Up-Grant', 'g'.repeat(43)).send({ reasonNote: 'Approved exception' });
    expect(response.status).toBe(200);
    expect(users.consumeStepUpGrant).toHaveBeenCalledWith('admin-1', 'session-1', 'payout.force_release', 'g'.repeat(43));
    expect(payout.forceReleasePayoutEarly).toHaveBeenCalledWith('order-1', {
      adminId: 'admin-1', reasonNote: 'Approved exception',
    });
  });
});
