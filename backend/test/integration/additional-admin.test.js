const { randomUUID } = require('node:crypto');
const db = require('../../src/db.service');
const users = require('../../src/modules/users.service');
const { generateTotpSecret, generateTotpCode, encryptStaffTotpSecret } = require('../../src/lib/totp');
const { passwordHashPool } = require('../../src/lib/passwordHashPool');
const { ConflictError } = require('../../src/lib/errors');

const createdUserIds = new Set();
const password = 'additional-admin-password-2026';
const previousTotpEncryptionSecret = process.env.STAFF_TOTP_ENCRYPTION_SECRET;

beforeAll(() => {
  process.env.STAFF_TOTP_ENCRYPTION_SECRET = 'integration-staff-totp-key-material-over-32-bytes';
});

function uniquePhone(prefix) {
  return `+${prefix}${Date.now().toString().slice(-8)}${randomUUID().replace(/\D/g, '').slice(0, 7)}`;
}

async function createAdminInitiator({ role = 'admin', suspended = false, enabled = true } = {}) {
  const suffix = randomUUID();
  const email = `initiator-${suffix}@example.test`;
  const secret = generateTotpSecret();
  const encrypted = encryptStaffTotpSecret(secret);
  const { rows } = await db.query(
    `INSERT INTO users (full_name, phone, email, password_hash, role, is_suspended)
     VALUES ($1, $2, $3, 'integration-hash', $4, $5) RETURNING id`,
    [`Initiator ${suffix}`, uniquePhone('1'), email, role, suspended]
  );
  const id = rows[0].id;
  createdUserIds.add(id);
  if (enabled) {
    await db.query(
      `INSERT INTO staff_totp_credentials
         (user_id, encrypted_secret, nonce, auth_tag, key_version, enabled_at, last_used_step)
       VALUES ($1, $2, $3, $4, $5, now(), NULL)`,
      [id, encrypted.encryptedSecret, encrypted.nonce, encrypted.authTag, encrypted.keyVersion]
    );
  }
  return { id, email, secret };
}

function input(initiator, overrides = {}) {
  const suffix = randomUUID();
  return {
    initiatorEmail: initiator.email,
    name: `Additional Admin ${suffix}`,
    email: `additional-${suffix}@example.test`,
    phone: uniquePhone('2'),
    password,
    ...overrides,
  };
}

function promptFor(initiator, {
  initiatorCode = generateTotpCode(initiator.secret),
  enrollmentCode = (secret) => generateTotpCode(secret),
} = {}) {
  return async ({ purpose, secret }) => purpose === 'initiator' ? initiatorCode : enrollmentCode(secret);
}

async function expectNoPromptLocks() {
  const { rows: transactions } = await db.query(
    `SELECT pid FROM pg_stat_activity
     WHERE datname = current_database()
       AND state LIKE 'idle in transaction%'
       AND pid <> pg_backend_pid()`
  );
  const { rows: advisoryLocks } = await db.query(
    `WITH lock_key AS (
       SELECT hashtext('poshaak-additional-admin-creation')::bigint AS value
     )
     SELECT pid FROM pg_locks, lock_key
     WHERE locktype = 'advisory' AND granted
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND classid = ((lock_key.value >> 32) & 4294967295)::oid
       AND objid = (lock_key.value & 4294967295)::oid
       AND objsubid = 1
       AND pid <> pg_backend_pid()`
  );
  expect(transactions).toHaveLength(0);
  expect(advisoryLocks).toHaveLength(0);
}

async function createAdditional(initiator, values = {}, promptOptions = {}) {
  return users.createAdditionalAdmin(input(initiator, values), {
    promptTotpCode: promptFor(initiator, promptOptions),
  });
}

beforeEach(() => {
  createdUserIds.clear();
});

afterEach(async () => {
  if (createdUserIds.size) {
    await db.query(
      `UPDATE users SET role = 'buyer', is_suspended = true, updated_at = now()
       WHERE id = ANY($1::uuid[])`,
      [[...createdUserIds]]
    );
  }
});

afterAll(async () => {
  try {
    await passwordHashPool.close();
  } finally {
    if (previousTotpEncryptionSecret === undefined) delete process.env.STAFF_TOTP_ENCRYPTION_SECRET;
    else process.env.STAFF_TOTP_ENCRYPTION_SECRET = previousTotpEncryptionSecret;
  }
});

describe('additional Admin provisioning', () => {
  test('FR-69: creates a distinct enrolled Admin and an audit record naming the initiator and new Admin', async () => {
    const initiator = await createAdminInitiator();
    const values = input(initiator);
    const codes = [];
    const returned = await users.createAdditionalAdmin(values, {
      promptTotpCode: async ({ purpose, secret }) => {
        const code = purpose === 'initiator' ? generateTotpCode(initiator.secret) : generateTotpCode(secret);
        codes.push(code);
        return code;
      },
    });
    createdUserIds.add(returned.id);

    const { rows: accounts } = await db.query(
      `SELECT u.id, u.role, u.is_suspended, t.enabled_at
       FROM users u JOIN staff_totp_credentials t ON t.user_id = u.id WHERE u.id = $1`,
      [returned.id]
    );
    const { rows: audits } = await db.query(
      `SELECT actor_id, action, metadata, created_at FROM money_audit_events
       WHERE actor_id = $1 AND action = 'additional_admin_created'
         AND metadata->>'newAdminId' = $2`,
      [initiator.id, returned.id]
    );
    expect(returned).toEqual({ id: returned.id, email: values.email.toLowerCase(), role: 'admin' });
    expect(returned.id).not.toBe(initiator.id);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: returned.id, role: 'admin', is_suspended: false });
    expect(accounts[0].enabled_at).not.toBeNull();
    expect(audits).toHaveLength(1);
    expect(audits[0].actor_id).toBe(initiator.id);
    expect(audits[0].metadata.newAdminId).toBe(returned.id);
    expect(audits[0].created_at).toBeInstanceOf(Date);
    const sensitiveValuesPresent = [initiator.secret, password, ...codes].some((value) =>
      JSON.stringify({ returned, audit: audits[0] }).includes(value)
    );
    expect(sensitiveValuesPresent).toBe(false);
    expect(JSON.stringify(audits[0].metadata).toLowerCase().includes('code')).toBe(false);
    expect(JSON.stringify(audits[0].metadata).toLowerCase().includes('password')).toBe(false);
  });

  test('FR-69: holds no transaction or advisory lock while either TOTP prompt waits', async () => {
    const initiator = await createAdminInitiator();
    const values = input(initiator);
    const purposes = [];
    const returned = await users.createAdditionalAdmin(values, {
      promptTotpCode: async ({ purpose, secret, attempt }) => {
        purposes.push(`${purpose}:${attempt}`);
        await expectNoPromptLocks();
        return purpose === 'initiator'
          ? generateTotpCode(initiator.secret)
          : generateTotpCode(secret);
      },
    });
    createdUserIds.add(returned.id);
    expect(purposes).toEqual(['initiator:1', 'new-admin-enrollment:1']);
  });

  test('FR-69: creates the Admin after an enrollment prompt lasts longer than the database idle timeout', async () => {
    const initiator = await createAdminInitiator();
    const values = input(initiator);
    const returned = await users.createAdditionalAdmin(values, {
      promptTotpCode: async ({ purpose, secret }) => {
        if (purpose === 'initiator') return generateTotpCode(initiator.secret);
        await new Promise((resolve) => setTimeout(resolve, 11000));
        return generateTotpCode(secret);
      },
    });
    createdUserIds.add(returned.id);
    expect(returned.email).toBe(values.email.toLowerCase());
  }, 30000);

  test('FR-69: refuses an unknown, non-Admin, suspended, or unenrolled initiator', async () => {
    const unknown = await createAdminInitiator();
    const unknownInput = input(unknown, { initiatorEmail: `missing-${randomUUID()}@example.test` });
    await expect(users.createAdditionalAdmin(unknownInput, {
      promptTotpCode: promptFor(unknown),
    })).rejects.toThrow('active Admin account');

    const seller = await createAdminInitiator({ role: 'seller' });
    await expect(createAdditional(seller)).rejects.toThrow('active Admin account');

    const suspended = await createAdminInitiator({ suspended: true });
    await expect(createAdditional(suspended)).rejects.toThrow('active Admin account');

    const unenrolled = await createAdminInitiator({ enabled: false });
    await expect(createAdditional(unenrolled)).rejects.toThrow('active Admin account');
  });

  test('FR-69: refuses a wrong initiating code and a code already consumed by a successful creation', async () => {
    const initiator = await createAdminInitiator();
    await expect(createAdditional(initiator, {}, { initiatorCode: 'not-a-code' }))
      .rejects.toThrow('invalid or has already been used');

    const reusedCode = generateTotpCode(initiator.secret);
    const returned = await createAdditional(initiator, {}, { initiatorCode: reusedCode });
    createdUserIds.add(returned.id);
    await expect(createAdditional(initiator, {}, { initiatorCode: reusedCode }))
      .rejects.toThrow('invalid or has already been used');
  });

  test('FR-69: ignores a TOTP verifier override and creates nothing for invalid codes', async () => {
    const initiator = await createAdminInitiator();
    const values = input(initiator);
    await expect(users.createAdditionalAdmin(values, {
      totpVerifier: () => 4000000,
      promptTotpCode: async () => 'not-a-code',
    })).rejects.toThrow('invalid or has already been used');

    const { rows: accounts } = await db.query('SELECT id FROM users WHERE email = $1', [values.email]);
    const { rows: audits } = await db.query(
      `SELECT id FROM money_audit_events
       WHERE actor_id = $1 AND action = 'additional_admin_created'`,
      [initiator.id]
    );
    expect(accounts).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  test('FR-69: consumes the initiator code after three wrong enrollment codes and creates nothing', async () => {
    const initiator = await createAdminInitiator();
    const values = input(initiator);
    const reusedCode = generateTotpCode(initiator.secret);
    const attempts = [];
    await expect(users.createAdditionalAdmin(values, {
      promptTotpCode: async ({ purpose, attempt }) => {
        if (purpose === 'initiator') return reusedCode;
        attempts.push(attempt);
        return 'not-a-code';
      },
    })).rejects.toThrow('new Admin authenticator code is invalid');
    expect(attempts).toEqual([1, 2, 3]);

    const { rows: accounts } = await db.query(
      `SELECT u.id FROM users u WHERE u.email = $1`,
      [values.email]
    );
    const { rows: credentials } = await db.query(
      `SELECT t.user_id FROM staff_totp_credentials t
       JOIN users u ON u.id = t.user_id WHERE u.email = $1`,
      [values.email]
    );
    const { rows: audits } = await db.query(
      `SELECT id FROM money_audit_events
       WHERE actor_id = $1 AND action = 'additional_admin_created'`,
      [initiator.id]
    );
    expect(accounts).toHaveLength(0);
    expect(credentials).toHaveLength(0);
    expect(audits).toHaveLength(0);
    await expect(createAdditional(initiator, { email: values.email, phone: values.phone }, {
      initiatorCode: reusedCode,
    })).rejects.toThrow('invalid or has already been used');
  });

  test('FR-69: retries one enrollment typo and creates exactly one Admin and audit record', async () => {
    const initiator = await createAdminInitiator();
    const values = input(initiator);
    const attempts = [];
    const returned = await users.createAdditionalAdmin(values, {
      promptTotpCode: async ({ purpose, secret, attempt }) => {
        if (purpose === 'initiator') return generateTotpCode(initiator.secret);
        attempts.push(attempt);
        return attempt === 1 ? 'not-a-code' : generateTotpCode(secret);
      },
    });
    createdUserIds.add(returned.id);

    const { rows: accounts } = await db.query(
      `SELECT u.id FROM users u
       JOIN staff_totp_credentials t ON t.user_id = u.id AND t.enabled_at IS NOT NULL
       WHERE u.email = $1`,
      [values.email]
    );
    const { rows: audits } = await db.query(
      `SELECT id FROM money_audit_events
       WHERE actor_id = $1 AND action = 'additional_admin_created'
         AND metadata->>'newAdminId' = $2`,
      [initiator.id, returned.id]
    );
    expect(attempts).toEqual([1, 2]);
    expect(accounts).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  test('FR-69: aborts if the initiator is suspended during the enrollment prompt', async () => {
    const initiator = await createAdminInitiator();
    const values = input(initiator);
    await expect(users.createAdditionalAdmin(values, {
      promptTotpCode: async ({ purpose, secret }) => {
        if (purpose === 'initiator') return generateTotpCode(initiator.secret);
        await db.query('UPDATE users SET is_suspended = true, updated_at = now() WHERE id = $1', [initiator.id]);
        return generateTotpCode(secret);
      },
    })).rejects.toThrow('A current TOTP code from an active Admin account is required.');

    const { rows: accounts } = await db.query('SELECT id FROM users WHERE email = $1', [values.email]);
    const { rows: audits } = await db.query(
      `SELECT id FROM money_audit_events
       WHERE actor_id = $1 AND action = 'additional_admin_created'`,
      [initiator.id]
    );
    expect(accounts).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  test('FR-69: refuses an email inserted during the enrollment prompt without adding another account', async () => {
    const initiator = await createAdminInitiator();
    const values = input(initiator);
    let duplicateId;
    await expect(users.createAdditionalAdmin(values, {
      promptTotpCode: async ({ purpose, secret }) => {
        if (purpose === 'initiator') return generateTotpCode(initiator.secret);
        const { rows } = await db.query(
          `INSERT INTO users (full_name, phone, email, password_hash, role)
           VALUES ('Duplicate email during prompt', $1, $2, 'integration-hash', 'buyer')
           RETURNING id`,
          [uniquePhone('9'), values.email]
        );
        duplicateId = rows[0].id;
        createdUserIds.add(duplicateId);
        return generateTotpCode(secret);
      },
    })).rejects.toBeInstanceOf(ConflictError);

    const { rows: accounts } = await db.query('SELECT id FROM users WHERE email = $1', [values.email]);
    const { rows: audits } = await db.query(
      `SELECT id FROM money_audit_events
       WHERE actor_id = $1 AND action = 'additional_admin_created'`,
      [initiator.id]
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe(duplicateId);
    expect(audits).toHaveLength(0);
  });

  test('FR-69: refuses invalid identity fields and passwords below the bootstrap policy', async () => {
    const initiator = await createAdminInitiator();
    await expect(createAdditional(initiator, { name: '  ' })).rejects.toThrow('Valid additional administrator details');
    await expect(createAdditional(initiator, { email: 'not-an-email' })).rejects.toThrow('Valid additional administrator details');
    await expect(createAdditional(initiator, { phone: '123' })).rejects.toThrow('Valid additional administrator details');
    await expect(createAdditional(initiator, { password: 'short' })).rejects.toThrow('Valid additional administrator details');
  });

  test('FR-69: refuses duplicate phone and email values', async () => {
    const firstInitiator = await createAdminInitiator();
    const existing = await createAdditional(firstInitiator);
    createdUserIds.add(existing.id);
    const { rows: existingUsers } = await db.query('SELECT phone FROM users WHERE id = $1', [existing.id]);

    const phoneInitiator = await createAdminInitiator();
    await expect(createAdditional(phoneInitiator, { phone: existingUsers[0].phone }))
      .rejects.toThrow('already exists');

    const emailInitiator = await createAdminInitiator();
    await expect(createAdditional(emailInitiator, { email: existing.email }))
      .rejects.toThrow('already exists');
  });

  test('FR-69: serializes simultaneous attempts for the same new identity', async () => {
    const initiator = await createAdminInitiator();
    const values = input(initiator);
    const options = { promptTotpCode: promptFor(initiator) };
    const results = await Promise.allSettled([
      users.createAdditionalAdmin(values, options),
      users.createAdditionalAdmin(values, options),
    ]);
    const created = results.filter((result) => result.status === 'fulfilled');
    created.forEach((result) => createdUserIds.add(result.value.id));
    const { rows } = await db.query(
      'SELECT id FROM users WHERE email = $1 OR phone = $2',
      [values.email, values.phone]
    );
    expect(created).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  test('FR-84: createInitialAdmin still refuses when any Admin exists', async () => {
    await createAdminInitiator();
    const secret = generateTotpSecret();
    await expect(users.createInitialAdmin({
      name: 'Bootstrap Refusal Test',
      email: `bootstrap-refusal-${randomUUID()}@example.test`,
      phone: uniquePhone('3'),
      password,
      totpSecret: secret,
      totpCode: generateTotpCode(secret),
    })).rejects.toThrow('one-time only');
  });
});
