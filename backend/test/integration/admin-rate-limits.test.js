const crypto = require('node:crypto');
const { createClient } = require('redis');
const request = require('supertest');

const ENV_KEYS = [
  'NODE_ENV',
  'JWT_ACCESS_SECRET',
  'PAYMENTS_ENABLED',
  'PAYMENT_GATEWAY_PROVIDER',
  'RATE_LIMIT_ADMIN_OPS_IP_MAX',
  'RATE_LIMIT_ADMIN_OPS_ACCOUNT_MAX',
  'RATE_LIMIT_WINDOW_SECONDS',
];
const originalEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const JWT_SECRET = 'admin-rate-limits-integration-secret-material';
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = JWT_SECRET;
process.env.PAYMENTS_ENABLED = '1';
process.env.PAYMENT_GATEWAY_PROVIDER = 'fake';
process.env.RATE_LIMIT_ADMIN_OPS_IP_MAX = '100';
process.env.RATE_LIMIT_ADMIN_OPS_ACCOUNT_MAX = '1';
process.env.RATE_LIMIT_WINDOW_SECONDS = '60';

const { getSharedRedisClient, setSharedRedisClient } = require('../../src/lib/redis');
const originalRedisClient = getSharedRedisClient();
const db = require('../../src/db.service');
const app = require('../../src/app');
const { signAccessToken } = require('../../src/lib/jwt');
const { createFixture } = require('./fixtures');

const redisUrl = process.env.TEST_REDIS_URL;
let redisClient;
let fixture;
let admin;
let moderator;
let integrationIps = [];

function digest(value) {
  return crypto.createHmac('sha256', JWT_SECRET).update(value).digest('hex');
}

function accountKey(userId) {
  return `pm:rl:{adminOps}:account:${digest(`user:${userId}`)}`;
}

function ipKey(ip) {
  return `pm:rl:{adminOps}:ip:${digest(ip)}`;
}

function authorization(user) {
  const token = signAccessToken(user.id, { secret: JWT_SECRET, sessionId: user.sessionId });
  return `Bearer ${token}`;
}

async function createSession(userId) {
  const sessionId = crypto.randomUUID();
  await db.query(
    `INSERT INTO auth_sessions
       (id, family_id, user_id, refresh_token_hash, expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, now() + INTERVAL '1 hour', now() + INTERVAL '1 day')`,
    [
      sessionId,
      crypto.randomUUID(),
      userId,
      crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
    ]
  );
  return { id: userId, sessionId };
}

async function resetLimiterCounters(ip) {
  const keys = [accountKey(admin.id), accountKey(moderator.id)];
  if (ip) {
    keys.push(ipKey(ip));
    integrationIps.push(ip);
  }
  await redisClient.del(keys);
}

function getAdmin(ip, method, path) {
  const call = request(app)[method](path)
    .set('Authorization', authorization(admin))
    .set('x-forwarded-for', ip);
  return call;
}

async function primeAdminAccount(ip) {
  await getAdmin(ip, 'get', '/api/admin/order-exceptions').expect(200);
}

async function createStepUpGrantForRequest() {
  const rawGrant = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(rawGrant).digest('hex');
  await db.query(
    `INSERT INTO step_up_grants (token_hash, user_id, session_id, action, expires_at)
     VALUES ($1, $2, $3, 'refund.request', now() + INTERVAL '5 minutes')`,
    [tokenHash, admin.id, admin.sessionId]
  );
  return { rawGrant, tokenHash };
}

describe('SEC-24: real Admin routes enforce adminOps rate limits', () => {
  beforeAll(async () => {
    if (!redisUrl) throw new Error('TEST_REDIS_URL is required for real Admin rate-limit integration tests.');
    const parsed = new URL(redisUrl);
    if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error('TEST_REDIS_URL must be a valid Redis URL.');
    }
    if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) &&
        process.env.TEST_REDIS_ALLOW_REMOTE !== '1') {
      throw new Error('TEST_REDIS_URL must target localhost unless TEST_REDIS_ALLOW_REMOTE=1 is explicit.');
    }

    redisClient = createClient({ url: redisUrl });
    await redisClient.connect();
    setSharedRedisClient(redisClient);

    app.set('trust proxy', 1);
    fixture = await createFixture();
    await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [fixture.otherUserId]);
    await db.query("UPDATE users SET role = 'moderator' WHERE id = $1", [fixture.userId]);
    admin = await createSession(fixture.otherUserId);
    moderator = await createSession(fixture.userId);
  });

  beforeEach(() => {
    integrationIps = [];
  });

  afterEach(async () => {
    const keys = [accountKey(admin.id), accountKey(moderator.id)];
    for (const ip of integrationIps) keys.push(ipKey(ip));
    if (redisClient?.isOpen) await redisClient.del(keys);
  });

  afterAll(async () => {
    if (redisClient?.isOpen) {
      const keys = [accountKey(admin.id), accountKey(moderator.id)];
      for (const ip of integrationIps) keys.push(ipKey(ip));
      await redisClient.del(keys);
      await redisClient.quit();
    }
    setSharedRedisClient(originalRedisClient);
    if (fixture) await fixture.cleanup();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('SEC-24: GET refunds, manual refund request, payout release, and delivery update return 429', async () => {
    const refundsIp = '198.51.100.31';
    await resetLimiterCounters(refundsIp);
    await primeAdminAccount(refundsIp);
    await getAdmin(refundsIp, 'get', '/api/admin/refunds').expect(429);

    const refundIp = '198.51.100.32';
    await resetLimiterCounters(refundIp);
    await primeAdminAccount(refundIp);
    const { rawGrant, tokenHash } = await createStepUpGrantForRequest();
    await getAdmin(
      refundIp,
      'post',
      `/api/admin/orders/${crypto.randomUUID()}/refunds`
    ).send({
      reason: 'Customer service reviewed the delivery issue.',
      stepUpGrant: rawGrant,
    }).expect(429);
    const { rows: grantRows } = await db.query(
      'SELECT consumed_at FROM step_up_grants WHERE token_hash = $1',
      [tokenHash]
    );
    expect(grantRows).toEqual([{ consumed_at: null }]);

    const payoutIp = '198.51.100.33';
    await resetLimiterCounters(payoutIp);
    await primeAdminAccount(payoutIp);
    await getAdmin(
      payoutIp,
      'post',
      `/api/admin/orders/${crypto.randomUUID()}/payout/release`
    ).send({ payoutReference: 'rate-limit-reference', note: 'Rate limit release test.' }).expect(429);

    const deliveryIp = '198.51.100.34';
    await resetLimiterCounters(deliveryIp);
    await primeAdminAccount(deliveryIp);
    await getAdmin(
      deliveryIp,
      'patch',
      `/api/admin/orders/${crypto.randomUUID()}/delivery`
    ).send({ status: 'handed_to_delivery' }).expect(429);
  });

  test('SEC-24: a Moderator receives 403 without consuming the Admin account quota', async () => {
    const ip = '198.51.100.35';
    await resetLimiterCounters(ip);
    await request(app)
      .get('/api/admin/refunds')
      .set('Authorization', authorization(moderator))
      .set('x-forwarded-for', ip)
      .expect(403);

    expect(await redisClient.get(accountKey(admin.id))).toBeNull();
    await getAdmin(ip, 'get', '/api/admin/refunds').expect(200);
    expect(await redisClient.get(accountKey(admin.id))).toBe('1');
  });
});
