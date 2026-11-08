const { randomUUID } = require('node:crypto');
const db = require('../../src/db.service');
const { assertPaymentsAdminGate } = require('../../src/lib/paymentsAdminGate');
const { generateTotpSecret, encryptStaffTotpSecret } = require('../../src/lib/totp');

const enabledProduction = { NODE_ENV: 'production', PAYMENTS_ENABLED: '1' };
const previousTotpEncryptionSecret = process.env.STAFF_TOTP_ENCRYPTION_SECRET;

beforeAll(() => {
  process.env.STAFF_TOTP_ENCRYPTION_SECRET = 'integration-staff-totp-key-material-over-32-bytes';
});

afterAll(() => {
  if (previousTotpEncryptionSecret === undefined) delete process.env.STAFF_TOTP_ENCRYPTION_SECRET;
  else process.env.STAFF_TOTP_ENCRYPTION_SECRET = previousTotpEncryptionSecret;
});

async function withIsolatedAdminState(run) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE users SET is_suspended = true WHERE role = 'admin'");
    await run(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function createAdmin(client, { suspended = false, credential = 'enabled' } = {}) {
  const suffix = randomUUID();
  const phone = `+1${Date.now().toString().slice(-8)}${randomUUID().replace(/\D/g, '').slice(0, 5)}`;
  const { rows } = await client.query(
    `INSERT INTO users (full_name, phone, email, password_hash, role, is_suspended)
     VALUES ($1, $2, $3, 'gate-test-hash', 'admin', $4) RETURNING id`,
    [`Gate Admin ${suffix}`, phone, `gate-${suffix}@example.test`, suspended]
  );
  const userId = rows[0].id;
  if (credential !== 'missing') {
    const encrypted = encryptStaffTotpSecret(generateTotpSecret());
    await client.query(
      `INSERT INTO staff_totp_credentials
         (user_id, encrypted_secret, nonce, auth_tag, key_version, enabled_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        encrypted.encryptedSecret,
        encrypted.nonce,
        encrypted.authTag,
        encrypted.keyVersion,
        credential === 'enabled' ? new Date() : null,
      ]
    );
  }
  return userId;
}

async function assertGateFails(client) {
  await expect(assertPaymentsAdminGate(enabledProduction, client.query.bind(client)))
    .rejects.toThrow('at least two distinct, enrolled, non-suspended Admins');
}

describe('production payments Admin startup gate', () => {
  test.each([
    ['0 Admins', async () => {}],
    ['1 enrolled Admin', async (client) => { await createAdmin(client); }],
    ['2 Admins where one has no enabled credential', async (client) => {
      await createAdmin(client);
      await createAdmin(client, { credential: 'disabled' });
    }],
    ['2 sessions for one enrolled Admin count as one Admin', async (client) => {
      const userId = await createAdmin(client);
      for (let index = 0; index < 2; index += 1) {
        await client.query(
          `INSERT INTO auth_sessions (family_id, user_id, refresh_token_hash, expires_at, absolute_expires_at)
           VALUES ($1, $2, $3, now() + interval '1 hour', now() + interval '1 day')`,
          [randomUUID(), userId, `gate-session-${randomUUID()}`]
        );
      }
    }],
    ['2 enrolled Admins where one is suspended', async (client) => {
      await createAdmin(client);
      await createAdmin(client, { suspended: true });
    }],
  ])('FR-69: fails closed with %s', async (_label, arrange) => {
    await withIsolatedAdminState(async (client) => {
      await arrange(client);
      await assertGateFails(client);
    });
  });

  test('FR-69: passes with exactly 2 enrolled, non-suspended Admins', async () => {
    await withIsolatedAdminState(async (client) => {
      await createAdmin(client);
      await createAdmin(client);
      await expect(assertPaymentsAdminGate(enabledProduction, client.query.bind(client))).resolves.toBeUndefined();
    });
  });

  test.each([
    ['PAYMENTS_ENABLED unset in production', { NODE_ENV: 'production' }],
    ['PAYMENTS_ENABLED=0 in production', { NODE_ENV: 'production', PAYMENTS_ENABLED: '0' }],
    ['non-production with PAYMENTS_ENABLED=1', { NODE_ENV: 'test', PAYMENTS_ENABLED: '1' }],
  ])('FR-69: does not query the database when %s', async (_label, env) => {
    let queried = false;
    await expect(assertPaymentsAdminGate(env, async () => {
      queried = true;
      throw new Error('query should not run');
    })).resolves.toBeUndefined();
    expect(queried).toBe(false);
  });
});
