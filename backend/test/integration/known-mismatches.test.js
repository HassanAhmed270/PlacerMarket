const db = require('../../src/db.service');
const users = require('../../src/modules/users.service');
const catalog = require('../../src/modules/catalog.service');
const listings = require('../../src/modules/listings.service');
const { ForbiddenError, ValidationError } = require('../../src/lib/errors');
const discovery = require('../../src/modules/discovery.service');
const { createFixture } = require('./fixtures');
const request = require('supertest');
const app = require('../../src/app');
const { signAccessToken } = require('../../src/lib/jwt');
const { passwordHashPool } = require('../../src/lib/passwordHashPool');
const { hashCode, addressDigest } = require('../../src/lib/emailCodeDelivery');
const { getSharedRedisClient, setSharedRedisClient } = require('../../src/lib/redis');
const { hashPassword } = require('../../src/lib/passwordHashPool');
const { generateTotpSecret, generateTotpCode, encryptStaffTotpSecret } = require('../../src/lib/totp');

let fixture;
let registrationPhone;
let createdCityId;
let createdSubCategoryId;
let createdMainCategoryId;

async function addListingPhotos(listing, count) {
  await listings.addListingImages(
    listing.listingId,
    listing.userId,
    Array.from({ length: count }, (_, index) => `https://images.invalid/${listing.suffix}-${index}.jpg`)
  );
}

async function setMeasurementFieldDefs(subCategoryId, definitions, adminId = fixture.userId) {
  return catalog.setMeasurementFieldDefs(
    subCategoryId, definitions, adminId, listings.getReferencedMeasurementDefinitionIds
  );
}

beforeEach(async () => {
  fixture = await createFixture();
  registrationPhone = null;
  createdCityId = null;
  createdSubCategoryId = null;
  createdMainCategoryId = null;
});

afterEach(async () => {
  if (registrationPhone) await db.query('DELETE FROM users WHERE phone = $1', [registrationPhone]);
  if (createdSubCategoryId) await db.query('DELETE FROM sub_categories WHERE id = $1', [createdSubCategoryId]);
  if (createdMainCategoryId) await db.query('DELETE FROM main_categories WHERE id = $1', [createdMainCategoryId]);
  if (createdCityId) await db.query('DELETE FROM cities WHERE id = $1', [createdCityId]);
  await fixture.cleanup();
});

afterAll(async () => {
  await passwordHashPool.close();
});

describe('known schema and service mismatches', () => {
  test('FR-06: seller applications require a set city and store only reasonForSelling and whatWillSell', async () => {
    await db.query('DELETE FROM seller_applications WHERE user_id = $1', [fixture.userId]);
    await db.query("UPDATE users SET role = 'buyer' WHERE id = $1", [fixture.userId]);
    const application = await users.submitSellerApplication(fixture.userId, {
      reasonForSelling: 'I want to sell my formalwear', whatWillSell: 'Bridal outfits',
    });
    expect(application).toMatchObject({
      user_id: fixture.userId,
      status: 'pending',
      reason_for_selling: 'I want to sell my formalwear',
      what_will_sell: 'Bridal outfits',
      is_resubmission: false,
    });
    expect(application).not.toHaveProperty('name');
    expect(application).not.toHaveProperty('phone');
    expect(application).not.toHaveProperty('city_id');
    await expect(users.submitSellerApplication(fixture.userId, {
      reasonForSelling: 'Selling', whatWillSell: 'Formalwear', cityId: fixture.cityId,
    })).rejects.toThrow('reasonForSelling and whatWillSell are required');
    await db.query('UPDATE users SET city_id = NULL WHERE id = $1', [fixture.userId]);
    await expect(users.submitSellerApplication(fixture.userId, {
      reasonForSelling: 'Selling', whatWillSell: 'Formalwear',
    })).rejects.toThrow('City verification required');
  });

  test('FR-07: approval atomically sets seller role, approval flag and approval timestamp', async () => {
    await db.query("UPDATE users SET role = 'buyer' WHERE id = $1", [fixture.userId]);
    await db.query('UPDATE seller_profiles SET is_approved = false, approved_at = NULL WHERE user_id = $1', [fixture.userId]);
    const result = await users.reviewSellerApplication(fixture.applicationId, {
      decision: 'approved', reviewerId: fixture.otherUserId,
    });
    const { rows } = await db.query(
      `SELECT u.role, sp.is_approved, sp.approved_at, sa.status
       FROM users u JOIN seller_profiles sp ON sp.user_id = u.id
       JOIN seller_applications sa ON sa.user_id = u.id WHERE u.id = $1 AND sa.id = $2`,
      [fixture.userId, fixture.applicationId]
    );
    expect(result.status).toBe('approved');
    expect(rows[0]).toMatchObject({ role: 'seller', is_approved: true, status: 'approved' });
    expect(rows[0].approved_at).toBeTruthy();
  });

  test('FR-07: failed seller approval rolls back the application and profile changes', async () => {
    await db.query("UPDATE users SET role = 'buyer' WHERE id = $1", [fixture.userId]);
    await db.query('UPDATE seller_profiles SET is_approved = false, approved_at = NULL WHERE user_id = $1', [fixture.userId]);
    await db.query(`
      CREATE FUNCTION reject_fixture_seller_role() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${fixture.userId}'::uuid AND NEW.role = 'seller' THEN
          RAISE EXCEPTION 'injected seller-role failure';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER reject_fixture_seller_role BEFORE UPDATE OF role ON users
      FOR EACH ROW EXECUTE FUNCTION reject_fixture_seller_role();
    `);
    try {
      await expect(users.reviewSellerApplication(fixture.applicationId, {
        decision: 'approved', reviewerId: fixture.otherUserId,
      })).rejects.toThrow('injected seller-role failure');
    } finally {
      await db.query('DROP TRIGGER reject_fixture_seller_role ON users; DROP FUNCTION reject_fixture_seller_role();');
    }
    const { rows } = await db.query(
      `SELECT u.role, sp.is_approved, sp.approved_at, sa.status
       FROM users u JOIN seller_profiles sp ON sp.user_id = u.id
       JOIN seller_applications sa ON sa.user_id = u.id WHERE u.id = $1 AND sa.id = $2`,
      [fixture.userId, fixture.applicationId]
    );
    expect(rows[0]).toMatchObject({ role: 'buyer', is_approved: false, approved_at: null, status: 'pending' });
  });

  test('FR-07a: rejected applications can be resubmitted with a link to the rejected application', async () => {
    await db.query("UPDATE seller_applications SET status = 'rejected', rejection_reason = 'More detail needed' WHERE id = $1", [fixture.applicationId]);
    await db.query("UPDATE users SET role = 'buyer' WHERE id = $1", [fixture.userId]);
    const resubmission = await users.submitSellerApplication(fixture.userId, {
      reasonForSelling: 'I have more detail', whatWillSell: 'Wedding outfits',
    });
    expect(resubmission).toMatchObject({
      status: 'pending', is_resubmission: true, resubmitted_from: fixture.applicationId,
    });
  });

  test('FR-10: suspending a seller clears approval and approved_at', async () => {
    await users.suspendSeller(fixture.userId, { adminId: fixture.otherUserId, reason: 'review' });
    const { rows } = await db.query(
      'SELECT is_approved, approved_at FROM seller_profiles WHERE user_id = $1', [fixture.userId]
    );
    expect(rows[0]).toEqual({ is_approved: false, approved_at: null });
    await expect(users.isApprovedSeller(fixture.userId)).resolves.toBe(false);
  });

  test('FR-01, SEC-01: registration stores a server-generated Argon2id password hash', async () => {
    registrationPhone = `+1999${Date.now().toString().slice(-9)}`;
    const created = await users.registerUser({
      name: 'Registered Probe', phone: registrationPhone, email: `register-${Date.now()}@example.test`,
      password: 'registered-probe-password-2026', cityId: fixture.cityId,
    });
    expect(created).not.toHaveProperty('password_hash');
    expect(created).toMatchObject({ full_name: 'Registered Probe', role: 'buyer' });
    const stored = await db.query('SELECT full_name, password_hash FROM users WHERE id = $1', [created.id]);
    expect(stored.rows[0].full_name).toBe('Registered Probe');
    expect(stored.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(stored.rows[0].password_hash).not.toBe('registered-probe-password-2026');
  });

  test('FR-83d: email verification code is single-use under concurrent confirmation', async () => {
    const email = `verify-${Date.now()}@example.test`;
    const previousJwtSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'integration-test-secret-material-at-least-32-bytes';
    const digest = addressDigest(email);
    await db.query('UPDATE users SET email = $2, email_verified_at = NULL WHERE id = $1', [fixture.userId, email]);
    await db.query(
      `INSERT INTO email_login_codes
        (login_attempt_id, user_id, email_digest, code_hash, expires_at, purpose)
       VALUES ($1, $2, $3, $4, now() + interval '5 minutes', 'verify_email')`,
      [require('node:crypto').randomUUID(), fixture.userId, digest, hashCode('654321')]
    );
    const previousRedis = getSharedRedisClient();
    setSharedRedisClient({ isOpen: true, eval: async (_script, { arguments: args }) => args[2] === '0' ? 0 : 1 });
    try {
      const results = await Promise.all([
        users.confirmEmailVerification(email, '654321'),
        users.confirmEmailVerification(email, '654321'),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await users.isEmailVerified(fixture.userId)).toBe(true);
    } finally {
      setSharedRedisClient(previousRedis);
      if (previousJwtSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = previousJwtSecret;
    }
  });

  test('FR-83d: login email code is bound to its login attempt and is single-use', async () => {
    const email = `login-factor-${Date.now()}@example.test`;
    const attemptId = require('node:crypto').randomUUID();
    const wrongAttemptId = require('node:crypto').randomUUID();
    const previousJwtSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'integration-test-secret-material-at-least-32-bytes';
    await db.query('UPDATE users SET email = $2 WHERE id = $1', [fixture.userId, email]);
    await db.query(
      `INSERT INTO email_login_codes
        (login_attempt_id, user_id, email_digest, code_hash, expires_at, purpose)
       VALUES ($1, $2, $3, $4, now() + interval '5 minutes', 'login')`,
      [attemptId, fixture.userId, addressDigest(email), hashCode('827304')]
    );
    const previousRedis = getSharedRedisClient();
    setSharedRedisClient({ isOpen: true, eval: async (_script, { arguments: args }) => args[2] === '0' ? 0 : 1 });
    try {
      await expect(users.confirmLoginEmailCode(wrongAttemptId, '827304')).resolves.toBeNull();
      await expect(users.confirmLoginEmailCode(attemptId, '827304')).resolves.toBe(fixture.userId);
      await expect(users.confirmLoginEmailCode(attemptId, '827304')).resolves.toBeNull();
    } finally {
      setSharedRedisClient(previousRedis);
      if (previousJwtSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = previousJwtSecret;
    }
  });

  test('FR-84, FR-84a, SEC-38: refresh rotation hashes tokens and reuse revokes the family', async () => {
    const email = `session-${Date.now()}@example.test`;
    const attemptId = require('node:crypto').randomUUID();
    const previousJwtSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'integration-test-secret-material-at-least-32-bytes';
    await db.query("UPDATE users SET email = $2, role = 'buyer', is_suspended = false WHERE id = $1", [fixture.userId, email]);
    await db.query(
      `INSERT INTO email_login_codes
        (login_attempt_id, user_id, email_digest, code_hash, expires_at, purpose)
       VALUES ($1, $2, $3, $4, now() + interval '5 minutes', 'login')`,
      [attemptId, fixture.userId, addressDigest(email), hashCode('516204')]
    );
    const previousRedis = getSharedRedisClient();
    setSharedRedisClient({ isOpen: true, eval: async (_script, { arguments: args }) => args[2] === '0' ? 0 : 1 });
    try {
      const session = await users.completeBuyerLogin(attemptId, '516204', email);
      expect(session).toMatchObject({ user: { id: fixture.userId, role: 'buyer' }, accessExpiresIn: 900 });
      const claims = require('../../src/lib/jwt').verifyAccessToken(session.accessToken, {
        secret: process.env.JWT_ACCESS_SECRET,
      });
      expect(claims.sid).toBe(session.sessionId);
      const { rows: stored } = await db.query('SELECT refresh_token_hash FROM auth_sessions WHERE id = $1', [session.sessionId]);
      expect(stored[0].refresh_token_hash).not.toBe(session.refreshToken);
      await expect(users.getAuthenticationPrincipal(fixture.userId, session.sessionId))
        .resolves.toMatchObject({ id: fixture.userId, role: 'buyer', is_suspended: false });

      const refreshResults = await Promise.all([
        users.refreshSession(session.refreshToken),
        users.refreshSession(session.refreshToken),
      ]);
      expect(refreshResults.filter(Boolean)).toHaveLength(1);
      const rotated = refreshResults.find(Boolean);
      expect(rotated.refreshToken).not.toBe(session.refreshToken);
      await expect(users.getAuthenticationPrincipal(fixture.userId, session.sessionId)).resolves.toBeNull();
      await expect(users.refreshSession(rotated.refreshToken)).resolves.toBeNull();
      await expect(users.getAuthenticationPrincipal(fixture.userId, rotated.sessionId)).resolves.toBeNull();
    } finally {
      setSharedRedisClient(previousRedis);
      if (previousJwtSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = previousJwtSecret;
    }
  });

  test('FR-83h, SEC-09: staff TOTP codes are encrypted and cannot be replayed concurrently', async () => {
    const email = `staff-totp-${Date.now()}@example.test`;
    const previousJwtSecret = process.env.JWT_ACCESS_SECRET;
    const previousTotpKey = process.env.STAFF_TOTP_ENCRYPTION_SECRET;
    process.env.JWT_ACCESS_SECRET = 'integration-test-secret-material-at-least-32-bytes';
    process.env.STAFF_TOTP_ENCRYPTION_SECRET = 'integration-staff-totp-encryption-key-material';
    const passwordHash = await hashPassword('staff-integration-password-2026');
    const secret = generateTotpSecret();
    const encrypted = encryptStaffTotpSecret(secret);
    await db.query(
      "UPDATE users SET email = $2, role = 'admin', is_suspended = false, password_hash = $3 WHERE id = $1",
      [fixture.userId, email, passwordHash]
    );
    await db.query(
      `INSERT INTO staff_totp_credentials
        (user_id, encrypted_secret, nonce, auth_tag, key_version, enabled_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [fixture.userId, encrypted.encryptedSecret, encrypted.nonce, encrypted.authTag, encrypted.keyVersion]
    );
    const code = generateTotpCode(secret);
    try {
      const results = await Promise.all([
        users.authenticateStaffWithTotp({ email, password: 'staff-integration-password-2026', code }),
        users.authenticateStaffWithTotp({ email, password: 'staff-integration-password-2026', code }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.find(Boolean)).toMatchObject({ user: { id: fixture.userId, role: 'admin' } });
      const { rows } = await db.query('SELECT last_used_step FROM staff_totp_credentials WHERE user_id = $1', [fixture.userId]);
      expect(rows[0].last_used_step).not.toBeNull();
      const { rows: storedSecret } = await db.query('SELECT encrypted_secret FROM staff_totp_credentials WHERE user_id = $1', [fixture.userId]);
      expect(storedSecret[0].encrypted_secret.toString()).not.toContain(secret);
    } finally {
      if (previousJwtSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = previousJwtSecret;
      if (previousTotpKey === undefined) delete process.env.STAFF_TOTP_ENCRYPTION_SECRET;
      else process.env.STAFF_TOTP_ENCRYPTION_SECRET = previousTotpKey;
    }
  });

  test('FR-83c/f: seller enrollment issues ten hashed recovery codes and step-up grants are session-bound and single-use', async () => {
    const previousTotpKey = process.env.STAFF_TOTP_ENCRYPTION_SECRET;
    const previousJwtKey = process.env.JWT_ACCESS_SECRET;
    process.env.STAFF_TOTP_ENCRYPTION_SECRET = 'integration-seller-totp-encryption-key-material';
    process.env.JWT_ACCESS_SECRET = 'integration-jwt-signing-key-material-at-least-thirty-two-bytes';
    try {
      const { rows: sessionRows } = await db.query(
        `INSERT INTO auth_sessions (family_id, user_id, refresh_token_hash, expires_at, absolute_expires_at, enrollment_only)
         VALUES (gen_random_uuid(), $1, $2, now() + interval '1 hour', now() + interval '1 day', true) RETURNING id`,
        [fixture.userId, `enrollment-${fixture.suffix}`]
      );
      const sessionId = sessionRows[0].id;
      const setup = await users.beginSellerAuthenticatorEnrollment(fixture.userId);
      const enrolled = await users.confirmSellerAuthenticatorEnrollment(
        fixture.userId, sessionId, generateTotpCode(setup.secret)
      );
      expect(enrolled.enabled).toBe(true);
      expect(enrolled.backupCodes).toHaveLength(10);
      expect(new Set(enrolled.backupCodes).size).toBe(10);
      const { rows: upgradedSession } = await db.query('SELECT enrollment_only FROM auth_sessions WHERE id = $1', [sessionId]);
      expect(upgradedSession[0].enrollment_only).toBe(false);
      const { rows: credentialRows } = await db.query(
        'SELECT encrypted_secret, enabled_at, last_used_step FROM seller_totp_credentials WHERE user_id = $1', [fixture.userId]
      );
      expect(credentialRows[0].encrypted_secret.equals(Buffer.from(setup.secret))).toBe(false);
      expect(credentialRows[0].enabled_at).toBeTruthy();
      const { rows: codeRows } = await db.query('SELECT code_hash, consumed_at FROM seller_totp_backup_codes WHERE user_id = $1', [fixture.userId]);
      expect(codeRows).toHaveLength(10);
      expect(codeRows.every((row) => !enrolled.backupCodes.includes(row.code_hash))).toBe(true);
      expect(codeRows.every((row) => row.consumed_at === null)).toBe(true);

      const email = `seller-factor-${fixture.suffix}@example.test`;
      const password = 'seller-factor-login-password';
      await db.query('UPDATE users SET email = $2, password_hash = $3 WHERE id = $1', [fixture.userId, email, await hashPassword(password)]);
      expect(await users.authenticate({ email, password })).toMatchObject({ challengeRequired: true, factor: 'totp' });
      const authenticated = await users.authenticateStaffWithTotp({
        email, password, code: generateTotpCode(setup.secret, Date.now() + 30000),
      });
      expect(authenticated.sessionId).toBeTruthy();

      const grant = await users.createStepUpGrant(fixture.userId, authenticated.sessionId, 'payout.update', enrolled.backupCodes[0]);
      await expect(users.consumeStepUpGrant(fixture.userId, fixture.otherUserId, 'payout.update', grant.grant))
        .rejects.toMatchObject({ name: 'ForbiddenError' });
      await expect(users.consumeStepUpGrant(fixture.userId, authenticated.sessionId, 'security.change', grant.grant))
        .rejects.toMatchObject({ name: 'ForbiddenError' });
      const consumption = await Promise.allSettled([
        users.consumeStepUpGrant(fixture.userId, authenticated.sessionId, 'payout.update', grant.grant),
        users.consumeStepUpGrant(fixture.userId, authenticated.sessionId, 'payout.update', grant.grant),
      ]);
      expect(consumption.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
      expect(consumption.filter((item) => item.status === 'rejected')).toHaveLength(1);

      const recoveryConsumption = await Promise.allSettled([
        users.createStepUpGrant(fixture.userId, authenticated.sessionId, 'security.change', enrolled.backupCodes[3]),
        users.createStepUpGrant(fixture.userId, authenticated.sessionId, 'security.change', enrolled.backupCodes[3]),
      ]);
      expect(recoveryConsumption.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
      expect(recoveryConsumption.filter((item) => item.status === 'rejected')).toHaveLength(1);

      const oldPassword = 'old-seller-password-for-stepup';
      const newPassword = 'new-seller-password-after-stepup';
      await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [fixture.userId, await hashPassword(oldPassword)]);
      const passwordGrant = await users.createStepUpGrant(
        fixture.userId, authenticated.sessionId, 'password.change', enrolled.backupCodes[1]
      );
      await users.changePasswordWithStepUp(fixture.userId, authenticated.sessionId, {
        currentPassword: oldPassword, newPassword, stepUpGrant: passwordGrant.grant,
      });
      const { rows: changedPassword } = await db.query('SELECT password_hash, password_changed_at FROM users WHERE id = $1', [fixture.userId]);
      expect(changedPassword[0].password_hash).not.toBe('fixture-hash');
      expect(changedPassword[0].password_changed_at).toBeTruthy();

      const securityGrant = await users.createStepUpGrant(
        fixture.userId, authenticated.sessionId, 'security.change', enrolled.backupCodes[2]
      );
      await users.disableSellerAuthenticator(fixture.userId, authenticated.sessionId, securityGrant.grant);
      const { rows: disabledFactor } = await db.query('SELECT user_id FROM seller_totp_credentials WHERE user_id = $1', [fixture.userId]);
      expect(disabledFactor).toHaveLength(0);
    } finally {
      if (previousTotpKey === undefined) delete process.env.STAFF_TOTP_ENCRYPTION_SECRET;
      else process.env.STAFF_TOTP_ENCRYPTION_SECRET = previousTotpKey;
      if (previousJwtKey === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = previousJwtKey;
    }
  });

  test('FR-83f: a new device is remembered once and queues one notice email', async () => {
    const previousTotpKey = process.env.STAFF_TOTP_ENCRYPTION_SECRET;
    const previousEmailKey = process.env.EMAIL_QUEUE_ENCRYPTION_SECRET;
    const previousJwtKey = process.env.JWT_ACCESS_SECRET;
    process.env.STAFF_TOTP_ENCRYPTION_SECRET = 'integration-seller-totp-encryption-key-material';
    process.env.EMAIL_QUEUE_ENCRYPTION_SECRET = 'integration-email-queue-key-material-32-bytes';
    process.env.JWT_ACCESS_SECRET = 'integration-jwt-signing-key-material-at-least-thirty-two-bytes';
    const email = `device-${fixture.suffix}@example.test`;
    const passwordHash = await hashPassword('long-enough-device-test-password');
    try {
      await db.query("UPDATE users SET email = $2, password_hash = $3, role = 'buyer', is_suspended = false WHERE id = $1", [fixture.userId, email, passwordHash]);
      const { rows: before } = await db.query("SELECT count(*)::int AS count FROM pgboss.job WHERE name = 'email'");
      const context = { deviceIdentity: `test-device:${fixture.suffix}` };
      const previousRedis = getSharedRedisClient();
      setSharedRedisClient({ isOpen: true, eval: async (_script, { arguments: args }) => args[2] === '0' ? 0 : 1 });
      const sessions = [];
      try {
        for (const code of ['735101', '735102']) {
          const challenge = await users.authenticate({ email, password: 'long-enough-device-test-password' }, context);
          expect(challenge).toMatchObject({ challengeRequired: true, factor: 'email' });
          await db.query(
            `INSERT INTO email_login_codes
              (login_attempt_id, user_id, email_digest, code_hash, expires_at, purpose)
             VALUES ($1, $2, $3, $4, now() + interval '5 minutes', 'login')`,
            [challenge.loginAttemptId, fixture.userId, addressDigest(email), hashCode(code)]
          );
          sessions.push(await users.completeBuyerLogin(challenge.loginAttemptId, code, email, context));
        }
      } finally {
        setSharedRedisClient(previousRedis);
      }
      expect(sessions.every((session) => session.sessionId)).toBe(true);
      const { rows: devices } = await db.query('SELECT device_hash FROM known_auth_devices WHERE user_id = $1', [fixture.userId]);
      expect(devices).toHaveLength(1);
      const { rows: limitedSessions } = await db.query('SELECT enrollment_only FROM auth_sessions WHERE user_id = $1', [fixture.userId]);
      expect(limitedSessions.every((row) => !row.enrollment_only)).toBe(true);
      const { rows: after } = await db.query("SELECT count(*)::int AS count FROM pgboss.job WHERE name = 'email'");
      expect(after[0].count - before[0].count).toBe(1);
    } finally {
      if (previousTotpKey === undefined) delete process.env.STAFF_TOTP_ENCRYPTION_SECRET;
      else process.env.STAFF_TOTP_ENCRYPTION_SECRET = previousTotpKey;
      if (previousEmailKey === undefined) delete process.env.EMAIL_QUEUE_ENCRYPTION_SECRET;
      else process.env.EMAIL_QUEUE_ENCRYPTION_SECRET = previousEmailKey;
      if (previousJwtKey === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = previousJwtKey;
    }
  });

  test('FR-09a, SEC-30/35, FR-66/83l: payout API stores encrypted details, leaks no raw values, and enforces holds', async () => {
    const envKeys = ['STAFF_TOTP_ENCRYPTION_SECRET', 'EMAIL_QUEUE_ENCRYPTION_SECRET', 'JWT_ACCESS_SECRET',
      'PAYOUT_ENCRYPTION_ACTIVE_KEY_ID', 'PAYOUT_ENCRYPTION_KEYS_JSON'];
    const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const previousRedis = getSharedRedisClient();
    const observedLogs = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...args) => observedLogs.push(args.join(' ')));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation((...args) => observedLogs.push(args.join(' ')));
    const jwtSecret = 'integration-payout-jwt-signing-secret-at-least-thirty-two-bytes';
    process.env.STAFF_TOTP_ENCRYPTION_SECRET = 'integration-payout-seller-totp-encryption-key';
    process.env.EMAIL_QUEUE_ENCRYPTION_SECRET = 'integration-payout-email-queue-encryption-key-32bytes';
    process.env.JWT_ACCESS_SECRET = jwtSecret;
    process.env.PAYOUT_ENCRYPTION_ACTIVE_KEY_ID = 'integration-payout-v1';
    process.env.PAYOUT_ENCRYPTION_KEYS_JSON = JSON.stringify({ 'integration-payout-v1': Buffer.alloc(32, 42).toString('base64') });
    setSharedRedisClient({ isOpen: true, eval: async () => [1, 1] });
    const email = `payout-${fixture.suffix}@example.test`;
    const iban = 'PK36SCBL0000001123456702';
    try {
      await db.query('UPDATE users SET email = $2, role = \'seller\' WHERE id = $1', [fixture.userId, email]);
      await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [fixture.otherUserId]);
      const { rows: enrollmentSessionRows } = await db.query(
        `INSERT INTO auth_sessions (family_id, user_id, refresh_token_hash, expires_at, absolute_expires_at, enrollment_only)
         VALUES (gen_random_uuid(), $1, $2, now() + interval '1 hour', now() + interval '1 day', true) RETURNING id`,
        [fixture.userId, `payout-enrollment-${fixture.suffix}`]
      );
      const enrollmentSessionId = enrollmentSessionRows[0].id;
      const setup = await users.beginSellerAuthenticatorEnrollment(fixture.userId);
      const enrollment = await users.confirmSellerAuthenticatorEnrollment(fixture.userId, enrollmentSessionId, generateTotpCode(setup.secret));
      const { rows: adminSessionRows } = await db.query(
        `INSERT INTO auth_sessions (family_id, user_id, refresh_token_hash, expires_at, absolute_expires_at)
         VALUES (gen_random_uuid(), $1, $2, now() + interval '1 hour', now() + interval '1 day') RETURNING id`,
        [fixture.otherUserId, `payout-admin-${fixture.suffix}`]
      );
      const sellerToken = signAccessToken(fixture.userId, { secret: jwtSecret, sessionId: enrollmentSessionId });
      const adminToken = signAccessToken(fixture.otherUserId, { secret: jwtSecret, sessionId: adminSessionRows[0].id });
      const grant = await users.createStepUpGrant(
        fixture.userId, enrollmentSessionId, 'payout.update', enrollment.backupCodes[0]
      );

      const { rows: beforeJobs } = await db.query("SELECT count(*)::int AS count FROM pgboss.job WHERE name = 'email'");
      const saved = await request(app).patch('/api/users/me/payout-method')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({ method: 'bank', bankName: 'Test Bank', accountTitle: 'Test Seller', iban, stepUpGrant: grant.grant });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ method: 'bank', last4: '6702' });
      const sellerSummary = await request(app).get('/api/users/me/payout').set('Authorization', `Bearer ${sellerToken}`);
      expect(sellerSummary.status).toBe(200);
      expect(sellerSummary.body).toMatchObject({ method: 'bank', last4: '6702', configured: true, needsUpdate: false });
      const profile = await request(app).get('/api/users/me/seller-profile').set('Authorization', `Bearer ${sellerToken}`);
      expect(profile.status).toBe(200);
      expect(profile.body).not.toHaveProperty('payout_bank_account');
      expect(profile.body).not.toHaveProperty('payout_details_encrypted');

      const { rows: storedRows } = await db.query(
        `SELECT payout_method, payout_last4, payout_details_encrypted, payout_bank_account, payout_wallet_number
           FROM seller_profiles WHERE user_id = $1`, [fixture.userId]
      );
      const storedJson = JSON.stringify(storedRows[0].payout_details_encrypted);
      expect(storedRows[0]).toMatchObject({ payout_method: 'bank', payout_last4: '6702', payout_bank_account: null, payout_wallet_number: null });
      expect(storedJson).not.toContain(iban);
      expect(JSON.stringify([saved.body, sellerSummary.body, profile.body])).not.toMatch(/Test Bank|Test Seller|PK36SCBL|ciphertext|nonce|authTag/i);

      await expect(users.assertPayoutAllowed(fixture.userId)).rejects.toMatchObject({ name: 'ForbiddenError' });
      await users.verifySellerIdentity(fixture.userId, { adminId: fixture.otherUserId, note: 'Manual identity check complete' });
      await expect(users.assertPayoutAllowed(fixture.userId)).resolves.toBe(true);
      const adminView = await request(app).get('/api/admin/payouts').set('Authorization', `Bearer ${adminToken}`);
      expect(adminView.status).toBe(200);
      const item = adminView.body.find((entry) => entry.sellerId === fixture.userId);
      expect(item).toMatchObject({ method: 'bank', last4: '6702', changedRecently: true, idVerified: true, authenticatorEnabled: true, payoutHoldActive: false });
      expect(JSON.stringify(adminView.body)).not.toMatch(/Test Bank|Test Seller|PK36SCBL|ciphertext|nonce|authTag/i);

      const held = await request(app).post(`/api/admin/payouts/${fixture.userId}/hold`)
        .set('Authorization', `Bearer ${adminToken}`).send({ reason: 'Payout review requested' });
      expect(held.status).toBe(200);
      await expect(users.assertPayoutAllowed(fixture.userId)).rejects.toMatchObject({ name: 'ForbiddenError' });
      const cleared = await request(app).post(`/api/admin/payouts/${fixture.userId}/hold/clear`)
        .set('Authorization', `Bearer ${adminToken}`).send({ reason: 'Review complete' });
      expect(cleared.status).toBe(200);
      await expect(users.assertPayoutAllowed(fixture.userId)).resolves.toBe(true);
      const { rows: afterJobs } = await db.query("SELECT count(*)::int AS count FROM pgboss.job WHERE name = 'email'");
      expect(afterJobs[0].count - beforeJobs[0].count).toBe(1);
      expect(observedLogs.join('\n')).not.toMatch(/Test Bank|Test Seller|PK36SCBL|ciphertext|nonce|authTag/i);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      setSharedRedisClient(previousRedis);
      for (const key of envKeys) {
        if (previousEnv[key] === undefined) delete process.env[key];
        else process.env[key] = previousEnv[key];
      }
    }
  });

  test('FR-83g: password reset token is single-use, changes the password, and revokes every session', async () => {
    const crypto = require('node:crypto');
    const email = `reset-${Date.now()}@example.test`;
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const digest = crypto.createHash('sha256').update(rawToken).digest('hex');
    const originalHash = await hashPassword('previous-reset-password-2026');
    await db.query("UPDATE users SET email = $2, role = 'buyer', password_hash = $3 WHERE id = $1", [fixture.userId, email, originalHash]);
    await db.query('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval \'30 minutes\')', [fixture.userId, digest]);
    const { rows: sessionRows } = await db.query(`INSERT INTO auth_sessions
      (family_id, user_id, refresh_token_hash, expires_at, absolute_expires_at)
      VALUES ($1, $2, $3, now() + interval '1 day', now() + interval '2 days') RETURNING id`,
    [crypto.randomUUID(), fixture.userId, crypto.randomBytes(32).toString('hex')]);
    const queue = require('../../src/lib/queue');
    const queueSpy = jest.spyOn(queue, 'enqueue').mockResolvedValue('job');
    const previousJwtSecret = process.env.JWT_ACCESS_SECRET;
    const previousEmailKey = process.env.EMAIL_QUEUE_ENCRYPTION_SECRET;
    process.env.JWT_ACCESS_SECRET = 'integration-test-secret-material-at-least-32-bytes';
    process.env.EMAIL_QUEUE_ENCRYPTION_SECRET = 'integration-email-queue-encryption-key-material';
    try {
      const results = await Promise.all([
        users.resetPassword(rawToken, 'replacement-password-2026'),
        users.resetPassword(rawToken, 'replacement-password-2026'),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const { rows: changed } = await db.query('SELECT password_hash FROM users WHERE id = $1', [fixture.userId]);
      expect(changed[0].password_hash).not.toBe(originalHash);
      expect(changed[0].password_hash).toMatch(/^\$argon2id\$/);
      const { rows: revoked } = await db.query('SELECT revoked_at, revoke_reason FROM auth_sessions WHERE id = $1', [sessionRows[0].id]);
      expect(revoked[0]).toMatchObject({ revoke_reason: 'password_reset' });
      expect(revoked[0].revoked_at).not.toBeNull();
      expect(queueSpy).toHaveBeenCalledTimes(1);
      expect(queueSpy.mock.calls[0][1].encryptedPayload.ciphertext).not.toContain(rawToken);
    } finally {
      queueSpy.mockRestore();
      if (previousJwtSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = previousJwtSecret;
      if (previousEmailKey === undefined) delete process.env.EMAIL_QUEUE_ENCRYPTION_SECRET;
      else process.env.EMAIL_QUEUE_ENCRYPTION_SECRET = previousEmailKey;
    }
  });

  test('FR-84, SEC-09/10: one-time bootstrap creates an Argon2id admin with encrypted, verified TOTP and refuses reruns', async () => {
    const email = `bootstrap-${Date.now()}@example.test`;
    registrationPhone = `+1888${Date.now().toString().slice(-9)}`;
    const previousTotpKey = process.env.STAFF_TOTP_ENCRYPTION_SECRET;
    process.env.STAFF_TOTP_ENCRYPTION_SECRET = 'integration-staff-totp-encryption-key-material';
    const secret = generateTotpSecret();
    const input = {
      name: 'Bootstrap Admin', email, phone: registrationPhone,
      password: 'bootstrap-admin-password-2026', totpSecret: secret, totpCode: generateTotpCode(secret),
    };
    try {
      const result = await users.createInitialAdmin(input);
      expect(result).toMatchObject({ email, role: 'admin' });
      const { rows } = await db.query(`SELECT u.password_hash, t.encrypted_secret, t.enabled_at
        FROM users u JOIN staff_totp_credentials t ON t.user_id = u.id WHERE u.id = $1`, [result.id]);
      expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
      expect(rows[0].encrypted_secret.toString()).not.toContain(secret);
      expect(rows[0].enabled_at).not.toBeNull();
      await expect(users.createInitialAdmin(input)).rejects.toThrow('one-time only');
    } finally {
      if (previousTotpKey === undefined) delete process.env.STAFF_TOTP_ENCRYPTION_SECRET;
      else process.env.STAFF_TOTP_ENCRYPTION_SECRET = previousTotpKey;
    }
  });

  test('FR-07b: seller-application review queue resolves applicant identity from the user profile', async () => {
    const queue = await users.getSellerApplicationQueue();
    const item = queue.find((application) => application.id === fixture.applicationId);
    expect(item).toMatchObject({
      user_id: fixture.userId, full_name: expect.any(String), phone: expect.any(String),
      city_id: fixture.cityId, city_name: expect.any(String),
    });
    expect(item).not.toHaveProperty('password_hash');
  });

  test('FR-07: rejected seller applications record the required reason', async () => {
    const result = await users.reviewSellerApplication(fixture.applicationId, {
      decision: 'rejected', reason: 'Does not meet criteria', reviewerId: fixture.userId,
    });
    const stored = await db.query('SELECT status, rejection_reason FROM seller_applications WHERE id = $1', [fixture.applicationId]);
    expect(result.status).toBe('rejected');
    expect(stored.rows[0]).toEqual({ status: 'rejected', rejection_reason: 'Does not meet criteria' });
  });

  test('FR-07, FR-08: seller application approval promotes the user and creates an approved profile', async () => {
    await db.query('DELETE FROM seller_profiles WHERE user_id = $1', [fixture.userId]);
    await db.query("UPDATE users SET role = 'buyer' WHERE id = $1", [fixture.userId]);
    const result = await users.reviewSellerApplication(fixture.applicationId, {
      decision: 'approved', reviewerId: fixture.userId,
    });
    const { rows } = await db.query(
      `SELECT u.role, sp.user_id, sp.is_approved, sp.approved_at
       FROM users u LEFT JOIN seller_profiles sp ON sp.user_id = u.id WHERE u.id = $1`,
      [fixture.userId]
    );
    expect(result.status).toBe('approved');
    expect(rows[0]).toEqual({
      role: 'seller', user_id: fixture.userId, is_approved: true, approved_at: expect.any(Date),
    });
  });

  test('FR-27a: public seller card includes display alias, rating, and join date only', async () => {
    const card = await discovery.getSellerPublicCard(fixture.userId);
    expect(card).toEqual({
      displayAlias: expect.stringMatching(/^Fixture alias /),
      joinDate: expect.any(Date), averageRating: 0, ratingCount: 0,
    });
    expect(Object.keys(card).sort()).toEqual(['averageRating', 'displayAlias', 'joinDate', 'ratingCount']);
  });

  test('measurement definition lookup returns fields ordered by display_order', async () => {
    await db.query(
      `INSERT INTO measurement_field_defs (sub_category_id, field_name, display_order)
       VALUES ($1, 'sleeve', 0)`,
      [fixture.subCategoryId]
    );
    const fields = await catalog.getMeasurementFieldDefs(fixture.subCategoryId);
    expect(fields.map((field) => field.field_name)).toEqual(['sleeve', 'chest']);
  });

  test('FR-15a: measurement definition replacement persists flexible fields in display order', async () => {
    const definitions = await setMeasurementFieldDefs(fixture.subCategoryId, [
      { fieldName: 'waist', unit: 'inches' },
      { fieldName: 'sleeve', unit: 'cm' },
    ]);

    expect(definitions).toEqual([
      expect.objectContaining({ field_name: 'waist', unit: 'inches', display_order: 0 }),
      expect.objectContaining({ field_name: 'sleeve', unit: 'cm', display_order: 1 }),
    ]);
  });

  test('FR-15a: administrators can rename and reorder existing measurement field definitions', async () => {
    const initial = await setMeasurementFieldDefs(fixture.subCategoryId, [
      { fieldName: 'chest', unit: 'inches' },
      { fieldName: 'waist', unit: 'inches' },
    ]);
    const updated = await setMeasurementFieldDefs(fixture.subCategoryId, [
      { id: initial[1].id, fieldName: 'waistline', unit: 'cm', required: true },
      { id: initial[0].id, fieldName: 'bust', unit: 'cm', required: false },
    ]);
    expect(updated).toEqual([
      expect.objectContaining({ id: initial[1].id, field_name: 'waistline', unit: 'cm', required: true, display_order: 0 }),
      expect.objectContaining({ id: initial[0].id, field_name: 'bust', unit: 'cm', required: false, display_order: 1 }),
    ]);
  });

  test('FR-15a/FR-15d: required active measurement fields persist and are enforced when a listing is created', async () => {
    const definitions = await setMeasurementFieldDefs(fixture.subCategoryId, [
      { fieldName: 'chest', unit: 'inches', required: true },
      { fieldName: 'waist', unit: 'inches', required: false },
    ]);
    expect(definitions).toEqual([
      expect.objectContaining({ field_name: 'chest', required: true, is_active: true, display_order: 0 }),
      expect.objectContaining({ field_name: 'waist', required: false, is_active: true, display_order: 1 }),
    ]);
    const listingData = {
      mainCategoryId: fixture.categoryId, subCategoryId: fixture.subCategoryId,
      condition: 'brand_new', title: 'Required measurement fixture', askingPrice: 100,
    };
    await expect(listings.createListing(fixture.userId, listingData)).rejects.toThrow('Required measurement field "chest" is missing');
    const listing = await listings.createListing(fixture.userId, {
      ...listingData, measurements: [{ fieldName: 'chest', value: 41 }],
    });
    const { rows } = await db.query('SELECT field_def_id, value FROM listing_measurements WHERE listing_id = $1', [listing.id]);
    expect(rows).toEqual([{ field_def_id: definitions[0].id, value: '41.00' }]);
  });

  test('FR-15a: duplicate measurement field names are rejected without changing definitions', async () => {
    const before = await catalog.getMeasurementFieldDefs(fixture.subCategoryId);
    await expect(setMeasurementFieldDefs(fixture.subCategoryId, [
      { fieldName: 'waist', unit: 'inches' }, { fieldName: 'waist', unit: 'cm' },
    ])).rejects.toThrow(ValidationError);
    expect(await catalog.getMeasurementFieldDefs(fixture.subCategoryId)).toEqual(before);
  });

  test('measurement definitions can be replaced with an empty array when unused', async () => {
    const replaced = await setMeasurementFieldDefs(fixture.subCategoryId, []);
    expect(replaced).toEqual([]);
    expect(await catalog.getMeasurementFieldDefs(fixture.subCategoryId)).toEqual([]);
  });

  test('FR-15a/FR-15d: referenced measurement definitions retire while existing listing values remain', async () => {
    await db.query('INSERT INTO listing_measurements (listing_id, field_def_id, value) VALUES ($1, $2, 41)',
      [fixture.listingId, fixture.fieldDefId]);
    const retired = await setMeasurementFieldDefs(fixture.subCategoryId, []);
    expect(retired).toEqual([expect.objectContaining({ id: fixture.fieldDefId, is_active: false })]);
    expect(await catalog.getMeasurementFieldDefs(fixture.subCategoryId)).toEqual([]);
    expect(await catalog.getMeasurementFieldDefs(fixture.subCategoryId, { includeInactive: true }))
      .toEqual([expect.objectContaining({ id: fixture.fieldDefId, is_active: false })]);
    const { rows } = await db.query(
      'SELECT field_def_id, value FROM listing_measurements WHERE listing_id = $1', [fixture.listingId]
    );
    expect(rows).toEqual([{ field_def_id: fixture.fieldDefId, value: '41.00' }]);
    await expect(listings.createListing(fixture.userId, {
      mainCategoryId: fixture.categoryId, subCategoryId: fixture.subCategoryId, condition: 'brand_new',
      title: 'Retired measurement fixture', askingPrice: 100,
      measurements: [{ fieldName: 'chest', value: 41 }],
    })).rejects.toThrow('is inactive');
  });

  test('FR-09a: obsolete payout method values are rejected before payout SQL', async () => {
    await expect(users.updateSellerPayoutMethod(fixture.userId, {
      method: 'bank_transfer', details: 'fixture details',
    })).rejects.toThrow(ValidationError);
  });

  test('FR-08a: listing status enum does not contain the retired identity hold value', async () => {
    const { rows } = await db.query(
      "SELECT enumlabel FROM pg_enum WHERE enumtypid = 'listing_status'::regtype"
    );
    expect(rows.map((row) => row.enumlabel)).not.toContain('held_pending_id');
  });

  test('user and city service functions return persisted values and expected errors', async () => {
    const citiesBefore = await users.listCities();
    const createdCity = await users.createCity({ name: `City ${fixture.suffix}` }, fixture.userId);
    createdCityId = createdCity.id;
    expect(await users.listCities()).toEqual(expect.arrayContaining([expect.objectContaining({ id: createdCity.id })]));
    expect(citiesBefore.some((row) => row.id === createdCity.id)).toBe(false);
    expect(await users.getUserRole(fixture.userId)).toBe('seller');
    await expect(users.getUserRole('00000000-0000-0000-0000-000000000000'))
      .rejects.toMatchObject({ name: 'NotFoundError', statusCode: 404 });
    await expect(users.assertCityVerified(fixture.userId)).resolves.toBeUndefined();
    await db.query('UPDATE users SET city_id = NULL WHERE id = $1', [fixture.userId]);
    await expect(users.assertCityVerified(fixture.userId)).rejects.toMatchObject({
      name: 'ValidationError', statusCode: 400,
    });
    await db.query('UPDATE users SET city_id = $2 WHERE id = $1', [fixture.userId, fixture.cityId]);
    await expect(users.assertCityVerified('00000000-0000-0000-0000-000000000000'))
      .rejects.toMatchObject({ name: 'NotFoundError', statusCode: 404 });
  });

  test('FR-08a: email verification is required strictly above the configured threshold', async () => {
    expect(await users.getSellerApplicationQueue({ status: 'pending' }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: fixture.applicationId, status: 'pending' })]));
    expect(await users.isApprovedSeller(fixture.userId)).toBe(true);
    await db.query("UPDATE users SET role = 'buyer' WHERE id = $1", [fixture.userId]);
    expect(await users.isApprovedSeller(fixture.userId)).toBe(false);
    await db.query("UPDATE users SET role = 'seller' WHERE id = $1", [fixture.userId]);
    const { rows: settings } = await db.query(
      "SELECT value::numeric AS threshold FROM platform_settings WHERE key = 'high_value_threshold_pkr'"
    );
    const threshold = Number(settings[0].threshold);
    expect(await users.isIdVerificationRequired(threshold)).toBe(false);
    expect(await users.isIdVerificationRequired(threshold + 1)).toBe(true);
    await db.query(
      "UPDATE listings SET status = 'pending_review', asking_price = $2 WHERE id = $1",
      [fixture.listingId, threshold]
    );
    let moderationQueue = await listings.getModerationQueue();
    expect(moderationQueue).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixture.listingId, is_high_value: false }),
    ]));
    await db.query('UPDATE listings SET asking_price = $2 WHERE id = $1', [fixture.listingId, threshold + 1]);
    moderationQueue = await listings.getModerationQueue();
    expect(moderationQueue).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixture.listingId, is_high_value: true }),
    ]));
    expect(await users.isIdVerificationRequired(1)).toBe(false);
    expect(await users.isIdVerified(fixture.userId)).toBe(false);
    const verification = await users.verifySellerIdentity(fixture.userId, {
      adminId: fixture.otherUserId, note: 'Identity checked in person',
    });
    expect(verification).toMatchObject({
      user_id: fixture.userId, id_verified: true, verified_by: fixture.otherUserId,
      verification_note: 'Identity checked in person',
    });
    expect(verification.verified_at).toBeTruthy();
    expect(await users.isIdVerified(fixture.userId)).toBe(true);
    expect((await users.getSellerProfile(fixture.userId)).user_id).toBe(fixture.userId);
    await expect(users.getSellerProfile('00000000-0000-0000-0000-000000000000'))
      .rejects.toMatchObject({ name: 'NotFoundError', statusCode: 404 });
  });

  test('FR-66: email verification does not set or imply manual identity verification', async () => {
    await db.query('UPDATE seller_profiles SET id_verified = false, verified_by = NULL, verified_at = NULL, verification_note = NULL WHERE user_id = $1', [fixture.userId]);
    await db.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [fixture.userId]);
    expect(await users.isEmailVerified(fixture.userId)).toBe(true);
    expect(await users.isIdVerified(fixture.userId)).toBe(false);
    const { rows } = await db.query('SELECT verified_by, verified_at, verification_note FROM seller_profiles WHERE user_id = $1', [fixture.userId]);
    expect(rows[0]).toEqual({ verified_by: null, verified_at: null, verification_note: null });
  });

  test('sub-category listing scopes to its main category and creation persists', async () => {
    const otherCategory = await catalog.createMainCategory({ name: `Other ${fixture.suffix}` }, fixture.userId);
    createdMainCategoryId = otherCategory.id;
    const before = await catalog.listSubCategories(fixture.categoryId);
    const created = await catalog.createSubCategory(fixture.categoryId, { name: `Added ${fixture.suffix}` }, fixture.userId);
    createdSubCategoryId = created.id;
    const rows = await catalog.listSubCategories(fixture.categoryId);
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id, main_category_id: fixture.categoryId })]));
    expect(rows).toHaveLength(before.length + 1);
    expect(await catalog.listSubCategories(otherCategory.id)).toEqual([]);
  });

  test('FR-14, FR-15, FR-15b: listing creation persists title, replica disclosure, attributes, and starts as draft', async () => {
    const created = await listings.createListing(fixture.userId, {
      title: 'Replica probe listing', mainCategoryId: fixture.categoryId,
      subCategoryId: fixture.subCategoryId, condition: 'replica',
      replicaDisclosure: 'This is a replica item.', askingPrice: 10,
      fabricMaterial: 'silk', brand: 'Probe brand', color: 'blue', embellishmentDetail: 'zardozi',
    });
    const { rows } = await db.query(
      'SELECT title, replica_disclosure, fabric_material, brand, color, embellishment_detail, status FROM listings WHERE id = $1', [created.id]
    );
    expect(rows[0]).toEqual({
      title: 'Replica probe listing', replica_disclosure: 'This is a replica item.', fabric_material: 'silk',
      brand: 'Probe brand', color: 'blue', embellishment_detail: 'zardozi', status: 'draft',
    });
  });

  test('FR-15: listing title is validated, trimmed, and retired fields are rejected on creation', async () => {
    await expect(listings.createListing(fixture.userId, {
      title: '  ', mainCategoryId: fixture.categoryId, subCategoryId: fixture.subCategoryId,
      condition: 'brand_new', askingPrice: 10,
    })).rejects.toThrow('title is required');
    await expect(listings.createListing(fixture.userId, {
      title: 'A'.repeat(151), mainCategoryId: fixture.categoryId, subCategoryId: fixture.subCategoryId,
      condition: 'brand_new', askingPrice: 10,
    })).rejects.toThrow('150 characters');
    await expect(listings.createListing(fixture.userId, {
      title: 'Retired field probe', mainCategoryId: fixture.categoryId, subCategoryId: fixture.subCategoryId,
      condition: 'brand_new', askingPrice: 10, listingType: 'sale',
    })).rejects.toThrow('Unsupported or retired listing field: listingType');
    const created = await listings.createListing(fixture.userId, {
      title: '  Valid title  ', mainCategoryId: fixture.categoryId,
      subCategoryId: fixture.subCategoryId, condition: 'brand_new', askingPrice: 10,
    });
    expect(created.title).toBe('Valid title');
  });

  test('FR-15a: listing creation accepts an active measurement definition ID', async () => {
    await setMeasurementFieldDefs(fixture.subCategoryId, [
      { id: fixture.fieldDefId, fieldName: 'chest', required: true },
    ]);
    const created = await listings.createListing(fixture.userId, {
      title: 'Definition ID probe', mainCategoryId: fixture.categoryId,
      subCategoryId: fixture.subCategoryId, condition: 'brand_new', askingPrice: 10,
      measurements: [{ fieldDefId: fixture.fieldDefId, value: 40 }],
    });
    const stored = await db.query('SELECT field_def_id, value FROM listing_measurements WHERE listing_id = $1', [created.id]);
    expect(stored.rows).toEqual([{ field_def_id: fixture.fieldDefId, value: '40.00' }]);
  });

  test('FR-15a: listing creation rejects unknown and inactive measurement definitions', async () => {
    const input = {
      title: 'Measurement rejection probe', mainCategoryId: fixture.categoryId,
      subCategoryId: fixture.subCategoryId, condition: 'brand_new', askingPrice: 10,
    };
    await expect(listings.createListing(fixture.userId, {
      ...input, measurements: [{ fieldName: 'missing field', value: 10 }],
    })).rejects.toThrow('Unknown measurement field');
    await setMeasurementFieldDefs(fixture.subCategoryId, [
      { id: fixture.fieldDefId, fieldName: 'chest', isActive: false },
    ]);
    await expect(listings.createListing(fixture.userId, {
      ...input, measurements: [{ fieldDefId: fixture.fieldDefId, value: 10 }],
    })).rejects.toThrow('is inactive');
  });

  test('FR-15a: listing measurements store the configured field definition ID', async () => {
    const created = await listings.createListing(fixture.userId, {
      title: 'Measured probe listing', mainCategoryId: fixture.categoryId,
      subCategoryId: fixture.subCategoryId, condition: 'brand_new', askingPrice: 10,
      measurements: [{ fieldName: 'chest', value: 40 }],
    });
    const stored = await db.query(
      'SELECT field_def_id, value FROM listing_measurements WHERE listing_id = $1', [created.id]
    );
    expect(stored.rows).toEqual([{ field_def_id: fixture.fieldDefId, value: '40.00' }]);
  });

  test('FR-16: listing images persist through image_url and display_order', async () => {
    await listings.addListingImages(fixture.listingId, fixture.userId, ['https://images.invalid/probe.jpg']);
    const stored = await db.query(
      'SELECT image_url, display_order FROM listing_images WHERE listing_id = $1', [fixture.listingId]
    );
    expect(stored.rows).toEqual([{ image_url: 'https://images.invalid/probe.jpg', display_order: 0 }]);
  });

  test('FR-17: authenticity evidence persists evidence_url with nullable evidence_type', async () => {
    await listings.submitAuthenticityEvidence(fixture.listingId, fixture.userId, ['https://files.invalid/probe.jpg']);
    const stored = await db.query(
      'SELECT evidence_url, evidence_type FROM listing_evidence WHERE listing_id = $1', [fixture.listingId]
    );
    expect(stored.rows).toEqual([{ evidence_url: 'https://files.invalid/probe.jpg', evidence_type: null }]);
  });

  test('SEC-12, FR-17: only the listing seller can submit authenticity evidence', async () => {
    await expect(listings.submitAuthenticityEvidence(
      fixture.listingId, '00000000-0000-0000-0000-000000000000', ['https://files.invalid/other.jpg']
    )).rejects.toBeInstanceOf(ForbiddenError);
    const { rows } = await db.query(
      'SELECT evidence_url FROM listing_evidence WHERE listing_id = $1', [fixture.listingId]
    );
    expect(rows).toEqual([]);
  });

  test('FR-19a: approval publishes a submitted listing with reviewer and timestamp', async () => {
    await addListingPhotos(fixture, 3);
    await listings.submitListingForReview(fixture.listingId, fixture.userId);
    const approved = await listings.approveListing(fixture.listingId, fixture.userId);
    expect(approved.status).toBe('published');
    expect(approved.reviewed_by).toBe(fixture.userId);
    expect(approved.published_at).toBeInstanceOf(Date);
    const { rows } = await db.query(
      'SELECT status, reviewed_by, published_at FROM listings WHERE id = $1', [fixture.listingId]
    );
    expect(rows[0]).toEqual({
      status: 'published', reviewed_by: fixture.userId, published_at: expect.any(Date),
    });
  });

  test('FR-21: rejection stores its reason and reviewer in real listing columns', async () => {
    await addListingPhotos(fixture, 3);
    await listings.submitListingForReview(fixture.listingId, fixture.userId);
    const rejected = await listings.rejectOrUnpublishListing(fixture.listingId, {
      reviewerId: fixture.userId, reason: 'Missing details',
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejection_reason).toBe('Missing details');
    const { rows } = await db.query(
      'SELECT status, rejection_reason, reviewed_by FROM listings WHERE id = $1', [fixture.listingId]
    );
    expect(rows[0]).toEqual({ status: 'rejected', rejection_reason: 'Missing details', reviewed_by: fixture.userId });
  });

  test('FR-21: unpublishing a published listing stores its reason and valid status', async () => {
    await db.query("UPDATE listings SET status = 'published' WHERE id = $1", [fixture.listingId]);
    const unpublished = await listings.rejectOrUnpublishListing(fixture.listingId, {
      reviewerId: fixture.userId, reason: 'Policy violation',
    });
    expect(unpublished.status).toBe('unpublished');
    expect(unpublished.rejection_reason).toBe('Policy violation');
    const { rows } = await db.query(
      'SELECT status, rejection_reason FROM listings WHERE id = $1', [fixture.listingId]
    );
    expect(rows[0]).toEqual({ status: 'unpublished', rejection_reason: 'Policy violation' });
  });

  test('FR-19, FR-74: three photos submit a draft into the moderation queue', async () => {
    await addListingPhotos(fixture, 3);
    await listings.submitAuthenticityEvidence(fixture.listingId, fixture.userId, ['https://files.invalid/receipt.jpg']);
    const submitted = await listings.submitListingForReview(fixture.listingId, fixture.userId);
    expect(submitted.status).toBe('pending_review');
    expect(submitted.requires_id_verification).toBe(false);
    const queued = await listings.getModerationQueue();
    expect(queued).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: fixture.listingId, status: 'pending_review', is_high_value: false, has_evidence_submitted: true,
      }),
    ]));
  });

  test('FR-19b: moderation queue flags a price strictly above the platform threshold', async () => {
    const { rows: settings } = await db.query(
      "SELECT value::numeric AS threshold FROM platform_settings WHERE key = 'high_value_threshold_pkr'"
    );
    await db.query("UPDATE listings SET asking_price = $2, status = 'pending_review' WHERE id = $1",
      [fixture.listingId, Number(settings[0].threshold) + 1]);
    const queue = await listings.getModerationQueue();
    expect(queue).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixture.listingId, is_high_value: true }),
    ]));
    await db.query('UPDATE listings SET asking_price = $2 WHERE id = $1',
      [fixture.listingId, Number(settings[0].threshold)]);
    const atThreshold = await listings.getModerationQueue();
    expect(atThreshold).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixture.listingId, is_high_value: false }),
    ]));
  });

  test('FR-74: submission rejects fewer than three photos and leaves the draft unchanged', async () => {
    await addListingPhotos(fixture, 2);
    await expect(listings.submitListingForReview(fixture.listingId, fixture.userId))
      .rejects.toBeInstanceOf(ValidationError);
    const { rows } = await db.query('SELECT status FROM listings WHERE id = $1', [fixture.listingId]);
    expect(rows[0].status).toBe('draft');
  });

  test('FR-74: six photos are accepted and a seventh addition is rejected', async () => {
    await addListingPhotos(fixture, 6);
    await expect(listings.addListingImages(
      fixture.listingId, fixture.userId, ['https://images.invalid/seventh.jpg']
    )).rejects.toBeInstanceOf(ValidationError);
    const { rows } = await db.query(
      'SELECT image_url, display_order FROM listing_images WHERE listing_id = $1 ORDER BY display_order',
      [fixture.listingId]
    );
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.display_order)).toEqual([0, 1, 2, 3, 4, 5]);
    await expect(listings.submitListingForReview(fixture.listingId, fixture.userId))
      .resolves.toMatchObject({ status: 'pending_review' });
  });

  test('FR-74: submission rejects more than six persisted photos', async () => {
    await db.query(
      `INSERT INTO listing_images (listing_id, image_url, display_order)
       SELECT $1, 'https://images.invalid/direct-' || n || '.jpg', n - 1
       FROM generate_series(1, 7) AS n`,
      [fixture.listingId]
    );
    await expect(listings.submitListingForReview(fixture.listingId, fixture.userId))
      .rejects.toBeInstanceOf(ValidationError);
    const { rows } = await db.query('SELECT status FROM listings WHERE id = $1', [fixture.listingId]);
    expect(rows[0].status).toBe('draft');
  });

  test('SEC-12, FR-16: another seller cannot add photos to the listing', async () => {
    await expect(listings.addListingImages(
      fixture.listingId,
      fixture.otherUserId,
      ['https://images.invalid/unauthorized.jpg']
    )).rejects.toBeInstanceOf(ForbiddenError);
    const { rows } = await db.query('SELECT id FROM listing_images WHERE listing_id = $1', [fixture.listingId]);
    expect(rows).toEqual([]);
  });

  test('FR-16, FR-19: photo additions stop after draft submission for review', async () => {
    await addListingPhotos(fixture, 3);
    await listings.submitListingForReview(fixture.listingId, fixture.userId);
    await expect(listings.addListingImages(
      fixture.listingId, fixture.userId, ['https://images.invalid/late-edit.jpg']
    )).rejects.toBeInstanceOf(ValidationError);
    const { rows } = await db.query(
      'SELECT status, (SELECT count(*)::int FROM listing_images WHERE listing_id = $1) AS photo_count FROM listings WHERE id = $1',
      [fixture.listingId]
    );
    expect(rows[0]).toEqual({ status: 'pending_review', photo_count: 3 });
  });

  test('FR-19, FR-74: approval rejects a pending listing without three photos', async () => {
    await db.query("UPDATE listings SET status = 'pending_review' WHERE id = $1", [fixture.listingId]);
    await expect(listings.approveListing(fixture.listingId, fixture.userId))
      .rejects.toBeInstanceOf(ValidationError);
    const { rows } = await db.query('SELECT status FROM listings WHERE id = $1', [fixture.listingId]);
    expect(rows[0].status).toBe('pending_review');
  });

  test('FR-08b, FR-19b: above-threshold listing remains pending until registered email verification', async () => {
    const { rows: settings } = await db.query(
      "SELECT value::numeric AS threshold FROM platform_settings WHERE key = 'high_value_threshold_pkr'"
    );
    await db.query('UPDATE listings SET asking_price = $2 WHERE id = $1', [fixture.listingId, Number(settings[0].threshold) + 1]);
    await addListingPhotos(fixture, 3);
    const submitted = await listings.submitListingForReview(fixture.listingId, fixture.userId);
    expect(submitted.requires_id_verification).toBe(true);
    await expect(listings.approveListing(fixture.listingId, fixture.userId))
      .rejects.toBeInstanceOf(ForbiddenError);
    const { rows: stillPending } = await db.query('SELECT status FROM listings WHERE id = $1', [fixture.listingId]);
    expect(stillPending[0].status).toBe('pending_review');
    await users.verifySellerIdentity(fixture.userId, {
      adminId: fixture.otherUserId, note: 'Separate manual identity check',
    });
    await expect(listings.approveListing(fixture.listingId, fixture.userId))
      .rejects.toBeInstanceOf(ForbiddenError);
    const { rows: stillPendingAfterLegacyFlag } = await db.query(
      'SELECT status FROM listings WHERE id = $1', [fixture.listingId]
    );
    expect(stillPendingAfterLegacyFlag[0].status).toBe('pending_review');
    await db.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [fixture.userId]);
    await expect(listings.approveListing(fixture.listingId, fixture.userId)).resolves.toMatchObject({ status: 'published' });
  });

  test('FR-19b: a price equal to the threshold can be approved without email verification', async () => {
    const { rows } = await db.query(
      "SELECT value::numeric AS threshold FROM platform_settings WHERE key = 'high_value_threshold_pkr'"
    );
    await db.query('UPDATE users SET email_verified_at = NULL WHERE id = $1', [fixture.userId]);
    await db.query('UPDATE listings SET asking_price = $2 WHERE id = $1', [fixture.listingId, Number(rows[0].threshold)]);
    await addListingPhotos(fixture, 3);
    await listings.submitListingForReview(fixture.listingId, fixture.userId);
    await expect(listings.approveListing(fixture.listingId, fixture.userId)).resolves.toMatchObject({ status: 'published' });
  });

  test('FR-18, FR-19a: granting a verified badge persists reviewer metadata independently', async () => {
    const granted = await listings.setVerifiedBadge(fixture.listingId, {
      granted: true, reviewerId: fixture.userId,
    });
    expect(granted.is_verified).toBe(true);
    expect(granted.verified_by).toBe(fixture.userId);
    expect(granted.verified_at).toBeInstanceOf(Date);
    expect(granted.status).toBe('draft');
  });

  test('FR-20: seller edits supported content but cannot assign system-controlled fields', async () => {
    const updated = await listings.updateOwnListing(fixture.listingId, fixture.userId, {
      title: 'Corrected fixture title', description: 'Updated description', askingPrice: 25,
    });
    expect(updated).toMatchObject({
      title: 'Corrected fixture title', description: 'Updated description', asking_price: '25.00',
      status: 'draft', seller_id: fixture.userId,
    });
    await expect(listings.updateOwnListing(fixture.listingId, fixture.userId, { status: 'published' }))
      .rejects.toBeInstanceOf(ValidationError);
    const { rows } = await db.query('SELECT status, seller_id FROM listings WHERE id = $1', [fixture.listingId]);
    expect(rows[0]).toEqual({ status: 'draft', seller_id: fixture.userId });
  });

  test('FR-20: a different seller cannot edit listing content', async () => {
    await expect(listings.updateOwnListing(
      fixture.listingId, fixture.otherUserId, { title: 'Unauthorized edit' }
    )).rejects.toBeInstanceOf(ForbiddenError);
    const { rows } = await db.query('SELECT title FROM listings WHERE id = $1', [fixture.listingId]);
    expect(rows[0].title).toBe(`Fixture listing ${fixture.suffix}`);
  });

  test('FR-20, FR-73: published edits are refused without pending-version storage', async () => {
    await db.query("UPDATE listings SET status = 'published', published_at = now() WHERE id = $1", [fixture.listingId]);
    await expect(listings.updateOwnListing(fixture.listingId, fixture.userId, {
      title: 'Must stay unpublished until moderation',
    })).rejects.toMatchObject({
      name: 'ValidationError', message: expect.stringContaining('moderated revision'),
    });
    const { rows } = await db.query('SELECT title, status FROM listings WHERE id = $1', [fixture.listingId]);
    expect(rows[0]).toEqual({ title: `Fixture listing ${fixture.suffix}`, status: 'published' });
  });

  test('FR-20: seller pause, resume, and removal take effect immediately and enforce ownership', async () => {
    await db.query("UPDATE listings SET status = 'published', published_at = now() WHERE id = $1", [fixture.listingId]);
    await expect(listings.setOwnListingPaused(fixture.listingId, fixture.otherUserId, true))
      .rejects.toBeInstanceOf(ForbiddenError);
    await expect(listings.setOwnListingPaused(fixture.listingId, fixture.userId, true))
      .resolves.toMatchObject({ status: 'paused' });
    expect(await discovery.getListingDetail(fixture.listingId)).toBeNull();
    await expect(listings.setOwnListingPaused(fixture.listingId, fixture.userId, false))
      .resolves.toMatchObject({ status: 'published' });
    await expect(listings.removeOwnListing(fixture.listingId, fixture.userId))
      .resolves.toMatchObject({ status: 'removed' });
    expect(await discovery.getListingDetail(fixture.listingId)).toBeNull();
  });

  test('FR-21a: only rejected listings can be resubmitted and their rejection reason remains visible', async () => {
    await expect(listings.resubmitListing(fixture.listingId, fixture.userId))
      .rejects.toBeInstanceOf(ValidationError);
    await addListingPhotos(fixture, 3);
    await listings.submitListingForReview(fixture.listingId, fixture.userId);
    await listings.rejectOrUnpublishListing(fixture.listingId, {
      reviewerId: fixture.userId, reason: 'Please correct the title',
    });
    await listings.updateOwnListing(fixture.listingId, fixture.userId, { title: 'Corrected title' });
    const resubmitted = await listings.resubmitListing(fixture.listingId, fixture.userId);
    expect(resubmitted).toMatchObject({ status: 'pending_review', rejection_reason: 'Please correct the title' });
    await expect(listings.resubmitListing(fixture.listingId, fixture.userId))
      .rejects.toBeInstanceOf(ValidationError);
  });

  test('FR-08: seller suspension blocks seller listing operations and sets the suspended flag', async () => {
    const suspended = await users.suspendSeller(fixture.userId, { adminId: fixture.userId, reason: 'probe' });
    const stored = await db.query('SELECT is_suspended FROM users WHERE id = $1', [fixture.userId]);
    expect(suspended.is_suspended).toBe(true);
    expect(suspended).not.toHaveProperty('password_hash');
    expect(stored.rows[0].is_suspended).toBe(true);
    expect(await users.isApprovedSeller(fixture.userId)).toBe(false);
    await expect(listings.createListing(fixture.userId, {
      title: 'Suspended seller listing', mainCategoryId: fixture.categoryId,
      subCategoryId: fixture.subCategoryId, condition: 'brand_new', askingPrice: 10,
    })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listings.addListingImages(
      fixture.listingId, fixture.userId, ['https://images.invalid/suspended.jpg']
    )).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listings.submitListingForReview(fixture.listingId, fixture.userId))
      .rejects.toBeInstanceOf(ForbiddenError);
    await expect(listings.updateOwnListing(fixture.listingId, fixture.userId, { title: 'Blocked edit' }))
      .rejects.toBeInstanceOf(ForbiddenError);
    await expect(listings.submitAuthenticityEvidence(
      fixture.listingId, fixture.userId, ['https://files.invalid/suspended.jpg']
    )).rejects.toBeInstanceOf(ForbiddenError);
  });

  test('SEC-07: authentication principal returns current role and suspension without password data', async () => {
    const principal = await users.getAuthenticationPrincipal(fixture.userId);
    expect(principal).toEqual({ id: fixture.userId, role: 'seller', is_suspended: false });
    expect(principal).not.toHaveProperty('password_hash');
    await users.suspendSeller(fixture.userId, { adminId: fixture.userId, reason: 'SEC-07 integration probe' });
    await expect(users.getAuthenticationPrincipal(fixture.userId)).resolves.toMatchObject({ is_suspended: true });
  });

  test('SEC-07, FR-84: protected seller route rechecks suspension against PostgreSQL on every request', async () => {
    const previousSecret = process.env.JWT_ACCESS_SECRET;
    const secret = 'integration-only-test-secret-with-32-bytes';
    process.env.JWT_ACCESS_SECRET = secret;
    try {
      const token = signAccessToken(fixture.userId, { secret });
      const active = await request(app).get('/api/users/me/seller-profile').set('Authorization', `Bearer ${token}`);
      expect(active.status).toBe(200);
      expect(active.body).not.toHaveProperty('password_hash');
      await users.suspendSeller(fixture.userId, { adminId: fixture.userId, reason: 'SEC-07 integration probe' });
      const suspended = await request(app).get('/api/users/me/seller-profile').set('Authorization', `Bearer ${token}`);
      expect(suspended.status).toBe(401);
    } finally {
      if (previousSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = previousSecret;
    }
  });

  test('FR-23: keyword search matches title or description on published listings only', async () => {
    await db.query("UPDATE listings SET status = 'published', description = 'searchable probe phrase' WHERE id = $1", [fixture.listingId]);
    const { rows: hidden } = await db.query(
      `INSERT INTO listings (seller_id, main_category_id, sub_category_id, condition, title, description, asking_price, status)
       VALUES ($1, $2, $3, 'brand_new', 'Hidden match', 'searchable probe phrase', 10, 'pending_review') RETURNING id`,
      [fixture.userId, fixture.categoryId, fixture.subCategoryId]
    );
    const descriptionResults = await discovery.searchListings('searchable probe phrase');
    expect(descriptionResults.map((row) => row.id)).toContain(fixture.listingId);
    expect(descriptionResults.map((row) => row.id)).not.toContain(hidden[0].id);
    const titleResults = await discovery.searchListings('Fixture listing');
    expect(titleResults.map((row) => row.id)).toContain(fixture.listingId);
  });

  test('FR-24: category, condition, and inclusive price filters include zero minimum', async () => {
    await db.query("UPDATE listings SET status = 'published' WHERE id = $1", [fixture.listingId]);
    const results = await discovery.filterListings({
      mainCategoryId: fixture.categoryId, subCategoryId: fixture.subCategoryId,
      condition: 'brand_new', minPrice: '0', maxPrice: '10',
    });
    expect(results.map((row) => row.id)).toContain(fixture.listingId);
  });

  test('FR-24: city filter uses the seller registered city', async () => {
    await db.query("UPDATE listings SET status = 'published' WHERE id = $1", [fixture.listingId]);
    const matches = await discovery.filterListings({ cityId: fixture.cityId });
    expect(matches.map((row) => row.id)).toContain(fixture.listingId);
    const { rows: otherCities } = await db.query('INSERT INTO cities (name) VALUES ($1) RETURNING id',
      [`Other filter city ${fixture.suffix}`]);
    const otherCityId = otherCities[0].id;
    try {
      await db.query('UPDATE users SET city_id = $2 WHERE id = $1', [fixture.userId, otherCityId]);
      const noLongerMatches = await discovery.filterListings({ cityId: fixture.cityId });
      expect(noLongerMatches.map((row) => row.id)).not.toContain(fixture.listingId);
      const newCityMatches = await discovery.filterListings({ cityId: otherCityId });
      expect(newCityMatches.map((row) => row.id)).toContain(fixture.listingId);
    } finally {
      await db.query('UPDATE users SET city_id = $2 WHERE id = $1', [fixture.userId, fixture.cityId]);
      await db.query('DELETE FROM cities WHERE id = $1', [otherCityId]);
    }
  });

  test('FR-25: listing details hide non-published content and include ordered images and limited seller summary', async () => {
    expect(await discovery.getListingDetail(fixture.listingId)).toBeNull();
    await db.query("UPDATE listings SET status = 'published' WHERE id = $1", [fixture.listingId]);
    await db.query(
      `INSERT INTO listing_images (listing_id, image_url, display_order)
       VALUES ($1, 'https://images.invalid/second.jpg', 1), ($1, 'https://images.invalid/first.jpg', 0)`,
      [fixture.listingId]
    );
    const detail = await discovery.getListingDetail(fixture.listingId);
    expect(detail).toMatchObject({ id: fixture.listingId, images: [
      { image_url: 'https://images.invalid/first.jpg', display_order: 0 },
      { image_url: 'https://images.invalid/second.jpg', display_order: 1 },
    ], seller: { joinDate: expect.any(Date), averageRating: 0, ratingCount: 0 } });
    expect(detail).not.toHaveProperty('reviewed_by');
    expect(detail).not.toHaveProperty('seller_id');
    expect(detail.seller.displayAlias).toMatch(/^Fixture alias /);
    expect(detail.seller).not.toHaveProperty('displayName');
    await db.query("UPDATE listings SET status = 'rejected' WHERE id = $1", [fixture.listingId]);
    expect(await discovery.getListingDetail(fixture.listingId)).toBeNull();
  });

  test('FR-22: public listing-detail route serves published listing photos without authentication', async () => {
    await db.query("UPDATE listings SET status = 'published' WHERE id = $1", [fixture.listingId]);
    await db.query(
      'INSERT INTO listing_images (listing_id, image_url, display_order) VALUES ($1, $2, 0)',
      [fixture.listingId, 'https://images.invalid/public.jpg']
    );
    const response = await request(app).get(`/api/discovery/listings/${fixture.listingId}`).expect(200);
    expect(response.body.images).toEqual([
      expect.objectContaining({ image_url: 'https://images.invalid/public.jpg', display_order: 0 }),
    ]);
    await request(app).get('/api/discovery/search?q=Fixture').expect(200);
    await request(app).get(`/api/discovery/filter?mainCategoryId=${fixture.categoryId}`).expect(200);
  });

  test('FR-23: search rejects an empty keyword instead of returning every public listing', async () => {
    await expect(discovery.searchListings('  ')).rejects.toBeInstanceOf(ValidationError);
  });
});
