const crypto = require('node:crypto');
const { createClient } = require('redis');
const request = require('supertest');

const ENV_KEYS = [
  'NODE_ENV',
  'JWT_ACCESS_SECRET',
  'PAYMENT_GATEWAY_PROVIDER',
  'RATE_LIMIT_ADMIN_OPS_IP_MAX',
  'RATE_LIMIT_ADMIN_OPS_ACCOUNT_MAX',
];
const originalEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const JWT_SECRET = 'admin-ops-rate-limits-integration-secret-material';
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = JWT_SECRET;
process.env.PAYMENT_GATEWAY_PROVIDER = 'fake';
process.env.RATE_LIMIT_ADMIN_OPS_IP_MAX = '100';
process.env.RATE_LIMIT_ADMIN_OPS_ACCOUNT_MAX = '1';

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
let trackedKeys = new Set();

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

function sendAdminRequest(ip, { method, path, body }) {
  trackedKeys.add(accountKey(admin.id));
  trackedKeys.add(ipKey(ip));
  const call = request(app)[method](path)
    .set('Authorization', authorization(admin))
    .set('x-forwarded-for', ip);
  return body === undefined ? call : call.send(body);
}

async function expect429OnMaxPlusOne(ip, route) {
  await redisClient.del([accountKey(admin.id), ipKey(ip)]);
  const first = await sendAdminRequest(ip, route);
  expect(first.status).not.toBe(429);
  await sendAdminRequest(ip, route).expect(429);
}

describe('SEC-24: adminOps protects staff mutating route families and fails closed', () => {
  beforeAll(async () => {
    if (!redisUrl) throw new Error('TEST_REDIS_URL is required for real Admin operations rate-limit tests.');
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
    await db.query(
      "UPDATE users SET role = 'admin', is_suspended = false WHERE id = $1",
      [fixture.otherUserId]
    );
    admin = await createSession(fixture.otherUserId);
  });

  afterEach(async () => {
    if (redisClient?.isOpen && trackedKeys.size) {
      await redisClient.del([...trackedKeys]);
    }
    trackedKeys = new Set();
  });

  afterAll(async () => {
    if (redisClient?.isOpen) {
      if (trackedKeys.size) await redisClient.del([...trackedKeys]);
      await redisClient.quit();
    }
    setSharedRedisClient(originalRedisClient);
    if (fixture) await fixture.cleanup();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('admin.routes.js group returns 429 on the account quota request', async () => {
    await expect429OnMaxPlusOne('198.51.100.41', {
      method: 'post',
      path: '/api/admin/listing-search/synonyms',
      body: {},
    });
  });

  test('listing approval returns 429 on the account quota request', async () => {
    await expect429OnMaxPlusOne('198.51.100.42', {
      method: 'post',
      path: `/api/listings/${crypto.randomUUID()}/approve`,
      body: {},
    });
  });

  test('dispute resolution returns 429 on the account quota request', async () => {
    await expect429OnMaxPlusOne('198.51.100.43', {
      method: 'post',
      path: `/api/disputes/${crypto.randomUUID()}/resolve`,
      body: {},
    });
  });

  test('settlement and payout mutations return 429 on the account quota request', async () => {
    await expect429OnMaxPlusOne('198.51.100.44', {
      method: 'post',
      path: `/api/settlement/orders/${crypto.randomUUID()}/initiate-payout`,
      body: {},
    });
    await expect429OnMaxPlusOne('198.51.100.45', {
      method: 'post',
      path: `/api/payout/orders/${crypto.randomUUID()}/force-release`,
      body: {},
    });
  });

  test('an unavailable Redis client returns 503 instead of allowing a staff mutation', async () => {
    const ip = '198.51.100.46';
    const route = {
      method: 'post',
      path: '/api/admin/listing-search/synonyms',
      body: {},
    };
    setSharedRedisClient({ isOpen: false });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await sendAdminRequest(ip, route).expect(503);
    } finally {
      consoleError.mockRestore();
      setSharedRedisClient(redisClient);
    }
  });
});
