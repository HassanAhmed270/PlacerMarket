const {
  authHeader,
  cleanupHarness,
  createHarness,
  db,
  getApp,
  request,
  restoreHandoverTestEnvironment,
} = require('./delivery-handover.helpers');

let harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  restoreHandoverTestEnvironment();
});

describe('FR-79h: Admin metrics route permissions', () => {
  test('FR-79h: metrics endpoint requires Admin permission and denies Moderator, seller and buyer', async () => {
    const app = getApp();
    const admin = await request(app)
      .get('/api/admin/metrics')
      .set('Authorization', authHeader(harness.adminId));
    expect(admin.status).toBe(200);
    expect(admin.body.scope).toBe('this process since start');
    expect(admin.headers['cache-control']).toBe('private, no-store');

    const moderator = await request(app)
      .get('/api/admin/metrics')
      .set('Authorization', authHeader(harness.moderatorId));
    expect(moderator.status).toBe(403);

    await db.query("UPDATE users SET role = 'seller' WHERE id = $1", [harness.extraUserIds[0]]);
    const seller = await request(app)
      .get('/api/admin/metrics')
      .set('Authorization', authHeader(harness.extraUserIds[0]));
    expect(seller.status).toBe(403);

    const buyer = await request(app)
      .get('/api/admin/metrics')
      .set('Authorization', authHeader(harness.unrelatedBuyerId));
    expect(buyer.status).toBe(403);

    const anonymous = await request(app).get('/api/admin/metrics');
    expect(anonymous.status).toBe(401);
    await cleanupHarness(harness);
  });
});
