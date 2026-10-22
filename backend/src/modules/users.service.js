/**
 * modules/users.service.js
 *
 * Owns: FR-01 to FR-10 (specs.md section "1. Identity & Users")
 * Tables owned: cities, users, seller_applications, seller_profiles,
 * auth_sessions, email_login_codes, password_reset_tokens, staff_totp_credentials,
 * seller_totp_credentials, seller_totp_backup_codes, step_up_grants, known_auth_devices
 *
 * Cross-module dependencies this file has OUT to other services:
 * - settlement.service.getSetting('high_value_threshold_pkr') for FR-08a
 *   (the price threshold for temporary registered-email verification lives in
 *   platform_settings, owned by settlement.service.js).
 *
 * Cross-module dependencies other files have IN to this file:
 * - listings.service.js calls isApprovedSeller() for seller operations and
 *   isIdVerificationRequired() to apply the temporary high-value publication
 *   publication gate for high-value listings until the seller verifies the
 *   registered email (FR-08a, FR-19b).
 * - admin.service.js delegates FR-52/53 user + seller-application management
 *   here instead of re-implementing it.
 */

const { randomUUID, randomBytes, createHash, createHmac } = require('node:crypto');
const db = require('../db.service');
const settlement = require('./settlement.service');
const eventBus = require('../lib/eventBus');
const events = require('../lib/events');
const { hashPassword, verifyPassword } = require('../lib/passwordHashPool');
const { signAccessToken, getJwtConfig } = require('../lib/jwt');
const { decryptStaffTotpSecret, matchingTotpStep } = require('../lib/totp');
const { encryptStaffTotpSecret, verifyTotpCode } = require('../lib/totp');
const { NotFoundError, ForbiddenError, ValidationError } = require('../lib/errors');
const { createIdentityVerifier } = require('../lib/adapters/identityVerifier');
const { keyProviderFromEnv } = require('../lib/keyProvider');
const { encryptPayoutDetails } = require('../lib/payoutEncryption');
const { getSecurityLimits } = require('../config');
const {
  makeCode, addressDigest, queueCodeEmail, queueEmail, reserveAddressSend, emailVerificationLocked,
  emailCodeLockedForDigest, hashCode, equalHash,
} = require('../lib/emailCodeDelivery');

const STAFF_ROLES = new Set(['admin', 'moderator']);
const STEP_UP_ACTIONS = Object.freeze(['payout.update', 'password.change', 'security.change', 'payout.force_release']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function refreshPolicy(role) {
  const limits = getSecurityLimits();
  const staff = STAFF_ROLES.has(role);
  return {
    absoluteSeconds: limits[staff ? 'AUTH_STAFF_REFRESH_ABSOLUTE_SECONDS' : 'AUTH_BUYER_REFRESH_ABSOLUTE_SECONDS'],
    idleSeconds: limits[staff ? 'AUTH_STAFF_REFRESH_IDLE_SECONDS' : 'AUTH_BUYER_REFRESH_IDLE_SECONDS'],
  };
}

function tokenDigest(token) {
  return createHash('sha256').update(token).digest('hex');
}

function authDeviceDigest(identity) {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) throw new ValidationError('Authentication configuration is unavailable.');
  return createHmac('sha256', secret).update('poshaak-auth-device-v1\0').update(identity).digest('hex');
}

function normalizedBackupCode(value) {
  return typeof value === 'string' ? value.replace(/-/g, '').toUpperCase() : '';
}

function issueAccessToken(userId, sessionId) {
  const jwt = getJwtConfig();
  return { token: signAccessToken(userId, { ...jwt, sessionId }), lifetimeSeconds: jwt.lifetimeSeconds };
}

async function insertSession(client, user, {
  familyId = randomUUID(), absoluteExpiresAt, deviceIdentity, deviceHash: existingDeviceHash,
  notifyNewDevice = true, enrollmentOnly = false,
} = {}) {
  const now = Date.now();
  const policy = refreshPolicy(user.role);
  const absolute = absoluteExpiresAt || new Date(now + policy.absoluteSeconds * 1000);
  const expiresAt = new Date(Math.min(now + policy.idleSeconds * 1000, absolute.getTime()));
  const refreshToken = randomBytes(32).toString('base64url');
  const sessionId = randomUUID();
  const deviceHash = existingDeviceHash || (deviceIdentity ? authDeviceDigest(deviceIdentity) : null);
  const access = issueAccessToken(user.id, sessionId);
  const { rows } = await client.query(
    `INSERT INTO auth_sessions
      (id, family_id, user_id, refresh_token_hash, expires_at, absolute_expires_at, device_hash, enrollment_only)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [sessionId, familyId, user.id, tokenDigest(refreshToken), expiresAt, absolute, deviceHash, enrollmentOnly]
  );
  if (deviceHash) {
    const { rows: known } = await client.query(
      `INSERT INTO known_auth_devices (user_id, device_hash)
       VALUES ($1, $2) ON CONFLICT (user_id, device_hash) DO NOTHING RETURNING user_id`,
      [user.id, deviceHash]
    );
    if (known.length && notifyNewDevice && user.email) {
      await queueEmail(user.email, 'New sign-in to Poshaak',
        'A new device signed in to your Poshaak account. If this was not you, secure your account.',
        { transaction: client, idempotencyKey: `new-device:${user.id}:${deviceHash}` });
    } else if (!known.length) {
      await client.query(
        'UPDATE known_auth_devices SET last_seen_at = now() WHERE user_id = $1 AND device_hash = $2',
        [user.id, deviceHash]
      );
    }
  }
  return {
    accessToken: access.token,
    accessExpiresIn: access.lifetimeSeconds,
    refreshToken,
    refreshMaxAge: Math.max(0, Math.floor((expiresAt.getTime() - now) / 1000)),
    user: { id: user.id, role: user.role },
    sessionId: rows[0].id,
  };
}

// ---- FR-01, FR-02: registration & auth ----

/** FR-01: register a new user, buyer role by default. */
async function registerUser({ name, phone, email, password, cityId }) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new ValidationError('Password must be 12 to 128 characters');
  }
  const passwordHash = await hashPassword(password);
  const { rows } = await db.query(
    `INSERT INTO users (full_name, phone, email, password_hash, city_id, role)
     VALUES ($1, $2, $3, $4, $5, 'buyer')
     ON CONFLICT DO NOTHING
     RETURNING id, full_name, phone, email, city_id, role, created_at`,
    [name, phone, email, passwordHash, cityId]
  );
  return rows[0] || null;
}

/** FR-02, SEC-07: load current authorization fields for a verified access-token subject. */
async function getAuthenticationPrincipal(userId, sessionId) {
  const { rows } = sessionId
    ? await db.query(
      `SELECT u.id, u.role, u.is_suspended, s.enrollment_only FROM users u
       JOIN auth_sessions s ON s.user_id = u.id
       WHERE u.id = $1 AND s.id = $2 AND s.revoked_at IS NULL AND s.consumed_at IS NULL
         AND s.expires_at > now() AND s.absolute_expires_at > now()`, [userId, sessionId]
    )
    : await db.query('SELECT id, role, is_suspended FROM users WHERE id = $1', [userId]);
  return rows[0] || null;
}

/** FR-83d: request address verification with uniform behavior for known and unknown addresses. */
async function requestEmailVerification(email) {
  if (typeof email !== 'string' || email.trim().length > 255) {
    throw new ValidationError('A valid email address is required.');
  }
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new ValidationError('A valid email address is required.');
  }
  const code = makeCode();
  await reserveAddressSend(normalized);
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT id FROM users WHERE email = $1 AND email_verified_at IS NULL FOR UPDATE', [normalized]
    );
    const userId = rows[0]?.id || null;
    await client.query(
      `UPDATE email_login_codes SET consumed_at = now()
       WHERE user_id = $1 AND purpose = 'verify_email' AND consumed_at IS NULL`, [userId]
    );
    await client.query(
      `INSERT INTO email_login_codes
        (login_attempt_id, user_id, email_digest, code_hash, expires_at, purpose)
       VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 second'), 'verify_email')`,
      [randomUUID(), userId, addressDigest(normalized), hashCode(code), getSecurityLimits().EMAIL_CODE_TTL_SECONDS]
    );
    await queueCodeEmail(normalized, code, { transaction: client, idempotencyKey: `verify:${randomUUID()}` });
    return { accepted: true };
  });
}

/** FR-83d: atomically consume an address-verification code and update only email ownership state. */
async function confirmEmailVerification(email, code) {
  const length = getSecurityLimits().EMAIL_CODE_LENGTH;
  if (typeof email !== 'string' || typeof code !== 'string' || !new RegExp(`^\\d{${length}}$`).test(code)) return false;
  const normalized = email.trim().toLowerCase();
  if (await emailVerificationLocked(normalized)) return false;
  const verified = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, user_id, code_hash, attempts_used, expires_at
       FROM email_login_codes
       WHERE email_digest = $1 AND purpose = 'verify_email' AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [addressDigest(normalized)]
    );
    const record = rows[0];
    if (!record || record.expires_at <= new Date() || record.attempts_used >= getSecurityLimits().EMAIL_CODE_MAX_ATTEMPTS) return false;
    if (!equalHash(record.code_hash, hashCode(code))) {
      const nextAttempts = record.attempts_used + 1;
      await client.query(
        `UPDATE email_login_codes SET attempts_used = $1,
          consumed_at = CASE WHEN $1 >= $2 THEN now() ELSE consumed_at END WHERE id = $3`,
        [nextAttempts, getSecurityLimits().EMAIL_CODE_MAX_ATTEMPTS, record.id]
      );
      return false;
    }
    await client.query('UPDATE email_login_codes SET consumed_at = now() WHERE id = $1', [record.id]);
    if (!record.user_id) return false;
    await client.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [record.user_id]);
    return true;
  });
  if (!verified) await emailVerificationLocked(normalized, { failed: true });
  return verified;
}

/** FR-83d: issue an email factor code bound to one login attempt UUID. */
async function requestLoginEmailCode(loginAttemptId, userId, email) {
  if (typeof loginAttemptId !== 'string' || !UUID.test(loginAttemptId) ||
      typeof email !== 'string' || email.trim().length > 255) {
    throw new ValidationError('A valid login attempt and email address are required.');
  }
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new ValidationError('A valid login attempt and email address are required.');
  }
  const code = makeCode();
  await reserveAddressSend(normalized);
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT id FROM users WHERE id = $1 AND email = $2', [userId, normalized]
    );
    const targetUserId = rows[0]?.id || null;
    await client.query(
      `UPDATE email_login_codes SET consumed_at = now()
       WHERE login_attempt_id = $1 AND purpose = 'login' AND consumed_at IS NULL`, [loginAttemptId]
    );
    await client.query(
      `INSERT INTO email_login_codes
        (login_attempt_id, user_id, email_digest, code_hash, expires_at, purpose)
       VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 second'), 'login')`,
      [loginAttemptId, targetUserId, addressDigest(normalized), hashCode(code), getSecurityLimits().EMAIL_CODE_TTL_SECONDS]
    );
    await queueCodeEmail(normalized, code, { transaction: client, idempotencyKey: `login:${loginAttemptId}:${randomUUID()}` });
    return { accepted: true };
  });
}

/** FR-83d: consume a login factor only for the attempt that received it. */
async function confirmLoginEmailCode(loginAttemptId, code) {
  const length = getSecurityLimits().EMAIL_CODE_LENGTH;
  if (typeof loginAttemptId !== 'string' || !UUID.test(loginAttemptId) ||
      typeof code !== 'string' || !new RegExp(`^\\d{${length}}$`).test(code)) return null;
  const located = await db.query(
    `SELECT email_digest FROM email_login_codes
     WHERE login_attempt_id = $1 AND purpose = 'login' AND consumed_at IS NULL`, [loginAttemptId]
  );
  const digest = located.rows[0]?.email_digest;
  if (!digest || await emailCodeLockedForDigest(digest)) return null;
  const result = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, user_id, email_digest, code_hash, attempts_used, expires_at
       FROM email_login_codes
       WHERE login_attempt_id = $1 AND purpose = 'login' AND consumed_at IS NULL
       FOR UPDATE`, [loginAttemptId]
    );
    const record = rows[0];
    if (!record || record.expires_at <= new Date() || record.attempts_used >= getSecurityLimits().EMAIL_CODE_MAX_ATTEMPTS) {
      return { userId: null, failed: true, emailDigest: digest };
    }
    if (!equalHash(record.code_hash, hashCode(code))) {
      const nextAttempts = record.attempts_used + 1;
      await client.query(
        `UPDATE email_login_codes SET attempts_used = $1,
          consumed_at = CASE WHEN $1 >= $2 THEN now() ELSE consumed_at END WHERE id = $3`,
        [nextAttempts, getSecurityLimits().EMAIL_CODE_MAX_ATTEMPTS, record.id]
      );
      return { userId: null, failed: true, emailDigest: record.email_digest };
    }
    await client.query('UPDATE email_login_codes SET consumed_at = now() WHERE id = $1', [record.id]);
    return { userId: record.user_id, failed: !record.user_id, emailDigest: record.email_digest };
  });
  if (result.failed) await emailCodeLockedForDigest(result.emailDigest, { failed: true });
  return result.userId || null;
}

/** FR-02, FR-83h: verify password and begin the required role-specific second factor. */
async function authenticate({ email, password }, sessionContext = {}) {
  const { rows } = await db.query(
    `SELECT id, email, password_hash, role, is_suspended
     FROM users WHERE email = $1`, [email]
  );
  const user = rows[0];
  if (!user) {
    await hashPassword(password); // SEC-08: keep the unknown-account password path in the same Argon2 timing class.
    return null;
  }
  const passwordMatches = await verifyPassword(user.password_hash, password);
  if (!passwordMatches || user.is_suspended) return null;
  if (user.role === 'buyer') {
    return { challengeRequired: true, factor: 'email', loginAttemptId: randomUUID(), userId: user.id, email: user.email };
  }
  if (STAFF_ROLES.has(user.role)) return { challengeRequired: true, factor: 'totp' };
  if (user.role === 'seller') {
    const { rows: factors } = await db.query(
      'SELECT enabled_at FROM seller_totp_credentials WHERE user_id = $1', [user.id]
    );
    if (factors[0]?.enabled_at) return { challengeRequired: true, factor: 'totp' };
    return { session: await db.withTransaction((client) => insertSession(client, user, { ...sessionContext, enrollmentOnly: true })) };
  }
  return null;
}

/** FR-02, FR-83h: finish a buyer login only with its matching single-use email code. */
async function completeBuyerLogin(loginAttemptId, code, email, sessionContext = {}) {
  const userId = await confirmLoginEmailCode(loginAttemptId, code);
  if (!userId) return null;
  const { rows } = await db.query(
    'SELECT id, email, role, is_suspended FROM users WHERE id = $1', [userId]
  );
  const principal = rows[0];
  if (!principal || principal.is_suspended || principal.role !== 'buyer' || principal.email !== email) return null;
  return db.withTransaction((client) => insertSession(client, principal, sessionContext));
}

/** FR-02, FR-83h: staff login requires a valid password plus the enrolled authenticator. */
async function authenticateStaffWithTotp({ email, password, code }, sessionContext = {}) {
  const { rows } = await db.query(
    `SELECT id, email, password_hash, role, is_suspended
     FROM users WHERE email = $1`, [email]
  );
  const user = rows[0];
  if (!user) {
    await hashPassword(password);
    return null;
  }
  const passwordMatches = await verifyPassword(user.password_hash, password);
  if (!passwordMatches || user.is_suspended || (!STAFF_ROLES.has(user.role) && user.role !== 'seller')) return null;
  return db.withTransaction(async (client) => {
    if (user.role === 'seller') {
      const { rows: credentials } = await client.query(
        `SELECT encrypted_secret, nonce, auth_tag, key_version, enabled_at, last_used_step
         FROM seller_totp_credentials WHERE user_id = $1 FOR UPDATE`, [user.id]
      );
      const credential = credentials[0];
      if (!credential?.enabled_at) return null;
      let secret;
      try { secret = decryptStaffTotpSecret(credential); } catch { return null; }
      const matchedStep = matchingTotpStep(secret, code);
      if (matchedStep === null || (credential.last_used_step !== null && matchedStep <= Number(credential.last_used_step))) return null;
      await client.query('UPDATE seller_totp_credentials SET last_used_step = $1, updated_at = now() WHERE user_id = $2', [matchedStep, user.id]);
      return insertSession(client, user, sessionContext);
    }
    const { rows: credentials } = await client.query(
      `SELECT encrypted_secret, nonce, auth_tag, key_version, enabled_at, last_used_step
       FROM staff_totp_credentials WHERE user_id = $1 FOR UPDATE`, [user.id]
    );
    const credential = credentials[0];
    if (!credential?.enabled_at) return null;
    let secret;
    try { secret = decryptStaffTotpSecret({
      encrypted_secret: credential.encrypted_secret,
      nonce: credential.nonce,
      auth_tag: credential.auth_tag,
      key_version: credential.key_version,
    }); } catch { return null; }
    const matchedStep = matchingTotpStep(secret, code);
    if (matchedStep === null || (credential.last_used_step !== null && matchedStep <= Number(credential.last_used_step))) return null;
    await client.query('UPDATE staff_totp_credentials SET last_used_step = $1, updated_at = now() WHERE user_id = $2', [matchedStep, user.id]);
    return insertSession(client, user, sessionContext);
  });
}

/** FR-83g: request a reset with the same public response for known and unknown addresses. */
async function requestPasswordReset(email) {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {
    throw new ValidationError('A valid email address is required.');
  }
  const normalized = email.trim().toLowerCase();
  return db.withTransaction(async (client) => {
    const { rows } = await client.query('SELECT id FROM users WHERE email = $1 FOR UPDATE', [normalized]);
    const userId = rows[0]?.id;
    if (userId) {
      const raw = randomBytes(32).toString('base64url');
      await client.query(`UPDATE password_reset_tokens SET consumed_at = now()
        WHERE user_id = $1 AND consumed_at IS NULL`, [userId]);
      await client.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
        VALUES ($1, $2, now() + ($3 * interval '1 second'))`, [userId, tokenDigest(raw), getSecurityLimits().PASSWORD_RESET_TTL_SECONDS]);
      await queueEmail(normalized, 'Reset your Poshaak password',
        `Use this one-time password reset token within 30 minutes: ${raw}`, {
          transaction: client, idempotencyKey: `password-reset:${randomUUID()}`,
        });
    }
    return { accepted: true };
  });
}

/** FR-83g: atomically consume a reset token, update the password and revoke all sessions. */
async function resetPassword(token, password) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      typeof password !== 'string' || password.length < 12 || password.length > 128) return false;
  const passwordHash = await hashPassword(password);
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT t.id, t.user_id, u.email FROM password_reset_tokens t
      JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.consumed_at IS NULL AND t.expires_at > now() FOR UPDATE OF t` , [tokenDigest(token)]);
    const record = rows[0];
    if (!record) return false;
    await client.query('UPDATE password_reset_tokens SET consumed_at = now() WHERE id = $1', [record.id]);
    await client.query('UPDATE users SET password_hash = $1, password_changed_at = now() WHERE id = $2', [passwordHash, record.user_id]);
    await client.query(`UPDATE auth_sessions SET revoked_at = now(), revoke_reason = 'password_reset'
      WHERE user_id = $1 AND revoked_at IS NULL`, [record.user_id]);
    await queueEmail(record.email, 'Your Poshaak password was changed',
      'Your password was changed. If you did not make this change, contact the account owner.', {
        transaction: client, idempotencyKey: `password-reset-notice:${record.id}`,
      });
    return true;
  });
}

/** SEC-10, FR-84: create the sole initial administrator and enroll verified TOTP in one transaction. */
async function createInitialAdmin({ name, email, phone, password, totpSecret, totpCode }) {
  if (typeof name !== 'string' || !name.trim() || typeof email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof phone !== 'string' ||
      !/^\+?[1-9]\d{7,19}$/.test(phone) || typeof password !== 'string' ||
      password.length < 12 || password.length > 128 || !verifyTotpCode(totpSecret, totpCode)) {
    throw new ValidationError('Valid initial administrator details and authenticator code are required.');
  }
  const passwordHash = await hashPassword(password);
  const encrypted = encryptStaffTotpSecret(totpSecret);
  return db.withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('poshaak-initial-admin-bootstrap'))");
    const { rows: existing } = await client.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1 FOR UPDATE");
    if (existing.length) throw new ValidationError('An administrator already exists; bootstrap is one-time only.');
    const { rows } = await client.query(`INSERT INTO users (full_name, phone, email, password_hash, role)
      VALUES ($1, $2, $3, $4, 'admin') RETURNING id`, [name.trim(), phone, email.trim().toLowerCase(), passwordHash]);
    const user = rows[0];
    await client.query(`INSERT INTO staff_totp_credentials
      (user_id, encrypted_secret, nonce, auth_tag, key_version, enabled_at, last_used_step)
      VALUES ($1, $2, $3, $4, $5, now(), $6)`, [
      user.id, encrypted.encryptedSecret, encrypted.nonce, encrypted.authTag, encrypted.keyVersion,
      Math.floor(Date.now() / 30000),
    ]);
    return { id: user.id, email: email.trim().toLowerCase(), role: 'admin' };
  });
}

/** FR-83c: prepare encrypted TOTP enrollment; the secret is returned once for authenticator setup. */
async function beginSellerAuthenticatorEnrollment(userId) {
  const secret = require('../lib/totp').generateTotpSecret();
  const encrypted = encryptStaffTotpSecret(secret);
  return db.withTransaction(async (client) => {
    const { rows: usersFound } = await client.query('SELECT email, role FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!usersFound[0] || usersFound[0].role !== 'seller') throw new ForbiddenError('Seller account required.');
    const { rows: current } = await client.query('SELECT enabled_at FROM seller_totp_credentials WHERE user_id = $1 FOR UPDATE', [userId]);
    if (current[0]?.enabled_at) throw new ValidationError('An authenticator is already enabled.');
    await client.query(
      `INSERT INTO seller_totp_credentials
        (user_id, encrypted_secret, nonce, auth_tag, key_version, enabled_at, last_used_step)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL)
       ON CONFLICT (user_id) DO UPDATE SET encrypted_secret = EXCLUDED.encrypted_secret,
         nonce = EXCLUDED.nonce, auth_tag = EXCLUDED.auth_tag, key_version = EXCLUDED.key_version,
         enabled_at = NULL, last_used_step = NULL, updated_at = now()`,
      [userId, encrypted.encryptedSecret, encrypted.nonce, encrypted.authTag, encrypted.keyVersion]
    );
    const label = encodeURIComponent(`Poshaak:${usersFound[0].email}`);
    const issuer = encodeURIComponent('Poshaak');
    return { secret, otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30` };
  });
}

/** FR-83f: confirm setup and return ten hashed-at-rest, single-use recovery codes once. */
async function confirmSellerAuthenticatorEnrollment(userId, sessionId, code) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT encrypted_secret, nonce, auth_tag, key_version, enabled_at, last_used_step
       FROM seller_totp_credentials WHERE user_id = $1 FOR UPDATE`, [userId]
    );
    const credential = rows[0];
    if (!credential || credential.enabled_at) throw new ValidationError('Authenticator enrollment is not pending.');
    const secret = decryptStaffTotpSecret(credential);
    const matchedStep = matchingTotpStep(secret, code);
    if (matchedStep === null) throw new ValidationError('Authenticator code is invalid or expired.');
    const backupCodes = Array.from({ length: 10 }, () => randomBytes(12).toString('hex').toUpperCase());
    for (const backupCode of backupCodes) {
      await client.query('INSERT INTO seller_totp_backup_codes (user_id, code_hash) VALUES ($1, $2)', [userId, tokenDigest(backupCode)]);
    }
    await client.query('UPDATE seller_totp_credentials SET enabled_at = now(), last_used_step = $1, updated_at = now() WHERE user_id = $2', [matchedStep, userId]);
    const { rows: upgraded } = await client.query(
      `UPDATE auth_sessions SET enrollment_only = false
        WHERE id = $1 AND user_id = $2 AND enrollment_only = true AND revoked_at IS NULL
          AND consumed_at IS NULL AND expires_at > now() AND absolute_expires_at > now()
        RETURNING id`,
      [sessionId, userId]
    );
    if (!upgraded[0]) throw new ForbiddenError('A seller enrollment session is required.');
    return { enabled: true, backupCodes };
  });
}

async function verifyStepUpFactor(client, userId, code) {
  const { rows: usersFound } = await client.query('SELECT role FROM users WHERE id = $1', [userId]);
  const user = usersFound[0];
  if (!user) return false;
  const table = user.role === 'seller' ? 'seller_totp_credentials' : (STAFF_ROLES.has(user.role) ? 'staff_totp_credentials' : null);
  if (!table) return false;
  const { rows } = await client.query(
    `SELECT encrypted_secret, nonce, auth_tag, key_version, enabled_at, last_used_step
       FROM ${table} WHERE user_id = $1 FOR UPDATE`, [userId]
  );
  const credential = rows[0];
  if (!credential?.enabled_at) return false;
  if (/^\d{6}$/.test(code)) {
    const secret = decryptStaffTotpSecret(credential);
    const matchedStep = matchingTotpStep(secret, code);
    if (matchedStep === null || (credential.last_used_step !== null && matchedStep <= Number(credential.last_used_step))) return false;
    await client.query(`UPDATE ${table} SET last_used_step = $1, updated_at = now() WHERE user_id = $2`, [matchedStep, userId]);
    return true;
  }
  const normalized = normalizedBackupCode(code);
  if (!/^[A-F0-9]{24}$/.test(normalized) || user.role !== 'seller') return false;
  const { rows: used } = await client.query(
    `UPDATE seller_totp_backup_codes SET consumed_at = now()
      WHERE user_id = $1 AND code_hash = $2 AND consumed_at IS NULL RETURNING id`,
    [userId, tokenDigest(normalized)]
  );
  return used.length === 1;
}

/** FR-83f: grants are short-lived, one-use and bound to the current session and action. */
async function createStepUpGrant(userId, sessionId, action, code) {
  if (!STEP_UP_ACTIONS.includes(action) || typeof sessionId !== 'string' || !sessionId) throw new ValidationError('A supported action and active session are required.');
  const rawGrant = randomBytes(32).toString('base64url');
  const ttl = getSecurityLimits().STEP_UP_GRANT_TTL_SECONDS;
  const inserted = await db.withTransaction(async (client) => {
    const { rows: sessions } = await client.query(
      `SELECT id FROM auth_sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        AND consumed_at IS NULL AND expires_at > now() AND absolute_expires_at > now() FOR UPDATE`,
      [sessionId, userId]
    );
    if (!sessions[0] || !(await verifyStepUpFactor(client, userId, code))) return false;
    await client.query(
      `INSERT INTO step_up_grants (token_hash, user_id, session_id, action, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 second'))`,
      [tokenDigest(rawGrant), userId, sessionId, action, ttl]
    );
    return true;
  });
  if (!inserted) throw new ForbiddenError('Authenticator verification failed.');
  return { grant: rawGrant, expiresIn: ttl };
}

async function consumeStepUpGrantWithClient(client, userId, sessionId, action, rawGrant) {
  if (typeof rawGrant !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(rawGrant)) throw new ForbiddenError('A valid step-up grant is required.');
  const { rows } = await client.query(
    `UPDATE step_up_grants SET consumed_at = now()
      WHERE token_hash = $1 AND user_id = $2 AND session_id = $3 AND action = $4
        AND consumed_at IS NULL AND expires_at > now() RETURNING id`,
    [tokenDigest(rawGrant), userId, sessionId, action]
  );
  if (rows.length !== 1) throw new ForbiddenError('A valid step-up grant is required.');
}

/** FR-83f: consume an action-bound grant atomically. */
async function consumeStepUpGrant(userId, sessionId, action, rawGrant) {
  return db.withTransaction((client) => consumeStepUpGrantWithClient(client, userId, sessionId, action, rawGrant));
}

/** FR-83f: remove a seller factor only after security-setting step-up. */
async function disableSellerAuthenticator(userId, sessionId, rawGrant) {
  return db.withTransaction(async (client) => {
    await consumeStepUpGrantWithClient(client, userId, sessionId, 'security.change', rawGrant);
    const { rows: profiles } = await client.query(
      'SELECT payout_details_encrypted, payout_bank_account, payout_wallet_number FROM seller_profiles WHERE user_id = $1 FOR UPDATE', [userId]
    );
    if (profiles[0]?.payout_details_encrypted || profiles[0]?.payout_bank_account || profiles[0]?.payout_wallet_number) {
      throw new ForbiddenError('Authenticator cannot be disabled while payout details are configured.');
    }
    await client.query('DELETE FROM seller_totp_backup_codes WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM seller_totp_credentials WHERE user_id = $1', [userId]);
  });
}

/** FR-83f: update the password after fresh-factor confirmation and grant consumption. */
async function changePasswordWithStepUp(userId, sessionId, { currentPassword, newPassword, stepUpGrant }) {
  const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!rows[0] || !(await verifyPassword(rows[0].password_hash, currentPassword))) throw new ForbiddenError('Current password is incorrect.');
  const passwordHash = await hashPassword(newPassword);
  return db.withTransaction(async (client) => {
    await consumeStepUpGrantWithClient(client, userId, sessionId, 'password.change', stepUpGrant);
    await client.query('UPDATE users SET password_hash = $1, password_changed_at = now() WHERE id = $2', [passwordHash, userId]);
    await client.query(
      `UPDATE auth_sessions SET revoked_at = now(), revoke_reason = 'password_change'
        WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [userId, sessionId]
    );
  });
}

/** FR-84: rotate a hashed refresh token, enforce both expiry limits, and revoke its family on reuse. */
async function refreshSession(refreshToken) {
  if (typeof refreshToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(refreshToken)) return null;
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT s.id, s.family_id, s.user_id, s.expires_at, s.absolute_expires_at,
              s.consumed_at, s.revoked_at, s.device_hash, s.enrollment_only, u.role, u.email, u.is_suspended
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.refresh_token_hash = $1 FOR UPDATE OF s`, [tokenDigest(refreshToken)]
    );
    const session = rows[0];
    if (!session) return null;
    if (session.consumed_at) {
      await client.query(
        `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()),
          revoke_reason = COALESCE(revoke_reason, 'refresh_reuse')
         WHERE family_id = $1`, [session.family_id]
      );
      return null;
    }
    if (session.revoked_at || session.is_suspended ||
        session.expires_at <= new Date() || session.absolute_expires_at <= new Date()) {
      await client.query(
        `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()),
          revoke_reason = COALESCE(revoke_reason, 'expired_or_suspended')
         WHERE family_id = $1`, [session.family_id]
      );
      return null;
    }
    const rotated = await insertSession(client, {
      id: session.user_id,
      role: session.role,
      email: session.email,
    }, { familyId: session.family_id, absoluteExpiresAt: session.absolute_expires_at,
      deviceHash: session.device_hash, notifyNewDevice: false, enrollmentOnly: session.enrollment_only });
    await client.query(
      `UPDATE auth_sessions SET consumed_at = now(), last_used_at = now(),
        replaced_by_session_id = $1 WHERE id = $2`, [rotated.sessionId, session.id]
    );
    return rotated;
  });
}

/** FR-84: logout revokes every active refresh-token family for the authenticated user. */
async function revokeAllSessions(userId) {
  await db.query(
    `UPDATE auth_sessions SET revoked_at = now(), revoke_reason = 'logout'
     WHERE user_id = $1 AND revoked_at IS NULL`, [userId]
  );
}

/** FR-84: logout revokes the current refresh-token family. */
async function revokeSessionFamily(userId, sessionId) {
  if (!sessionId) return revokeAllSessions(userId);
  await db.query(
    `UPDATE auth_sessions SET revoked_at = now(), revoke_reason = 'logout'
     WHERE family_id = (SELECT family_id FROM auth_sessions WHERE id = $1 AND user_id = $2)
       AND revoked_at IS NULL`, [sessionId, userId]
  );
}

// ---- FR-03, FR-04: city verification ----

/** FR-03: a buy/sell action requires the user to have a verified city set. */
async function assertCityVerified(userId) {
  const { rows } = await db.query('SELECT city_id FROM users WHERE id = $1', [userId]);
  if (!rows[0]) throw new NotFoundError('user', userId);
  if (!rows[0].city_id) {
    throw new ValidationError('City verification required before buying or selling (FR-03)');
  }
}

/** FR-04: admin-configured list of supported marketplace cities. */
async function listCities() {
  const { rows } = await db.query('SELECT * FROM cities ORDER BY name');
  return rows;
}

/** FR-04: admin adds a supported city. */
async function createCity({ name }, adminId) {
  const { rows } = await db.query('INSERT INTO cities (name) VALUES ($1) RETURNING *', [name]);
  return rows[0];
}

// ---- FR-05, FR-05a: roles ----

/** FR-05: fetch a user's role. Permission checks themselves live in lib/roles.js. */
async function getUserRole(userId) {
  const { rows } = await db.query('SELECT role FROM users WHERE id = $1', [userId]);
  if (!rows[0]) throw new NotFoundError('user', userId);
  return rows[0].role;
}

// ---- FR-06, FR-07, FR-07a, FR-07b: seller applications ----

/** FR-06: verified-city buyers apply with only their reason and the items they will sell. */
async function submitSellerApplication(userId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['reasonForSelling', 'whatWillSell'].includes(key)) ||
      typeof input.reasonForSelling !== 'string' || !input.reasonForSelling.trim() ||
      typeof input.whatWillSell !== 'string' || !input.whatWillSell.trim()) {
    throw new ValidationError('reasonForSelling and whatWillSell are required');
  }
  await assertCityVerified(userId);
  return db.withTransaction(async (client) => {
    const { rows: userRows } = await client.query('SELECT role FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!userRows[0]) throw new NotFoundError('user', userId);
    if (userRows[0].role !== 'buyer') throw new ValidationError('Only buyers can apply to become sellers');
    const { rows: previousRows } = await client.query(
      'SELECT id, status FROM seller_applications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
      [userId]
    );
    const previous = previousRows[0];
    if (previous?.status === 'pending') throw new ValidationError('A seller application is already pending');
    if (previous?.status === 'approved') throw new ValidationError('This account already has an approved seller application');
    const { rows } = await client.query(
      `INSERT INTO seller_applications
         (user_id, reason_for_selling, what_will_sell, is_resubmission, resubmitted_from, status)
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
      [userId, input.reasonForSelling.trim(), input.whatWillSell.trim(), Boolean(previous), previous?.id || null]
    );
    return rows[0];
  });
}

/**
 * FR-07: admin or moderator reviews an application.
 * FR-07a: rejections can be resubmitted — no cooldown enforced here by design.
 */
async function reviewSellerApplication(applicationId, { decision, reason, reviewerId }) {
  if (!['approved', 'rejected'].includes(decision)) {
    throw new ValidationError('decision must be "approved" or "rejected"');
  }
  if (decision === 'rejected' && (typeof reason !== 'string' || !reason.trim())) {
    throw new ValidationError('A rejection reason is required');
  }
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE seller_applications
       SET status = $1, rejection_reason = $2, reviewed_by = $3, reviewed_at = now()
       WHERE id = $4 AND status = 'pending' RETURNING *`,
      [decision, reason || null, reviewerId, applicationId]
    );
    if (!rows[0]) {
      const { rows: existing } = await client.query('SELECT id FROM seller_applications WHERE id = $1', [applicationId]);
      if (!existing[0]) throw new NotFoundError('seller_application', applicationId);
      throw new ValidationError('Only pending seller applications can be reviewed');
    }

    if (decision === 'approved') {
      await client.query(
        `INSERT INTO seller_profiles (user_id, is_approved, approved_at)
         VALUES ($1, true, now())
         ON CONFLICT (user_id) DO UPDATE SET is_approved = true, approved_at = now()`,
        [rows[0].user_id]
      );
      await client.query(`UPDATE users SET role = 'seller', updated_at = now() WHERE id = $1`, [rows[0].user_id]);
    }
    await eventBus.emitAsync(events.SELLER_APPLICATION_STATUS_CHANGED, { applicationId, decision, reason }, { transaction: client });
    return rows[0];
  });
}

/** FR-07b: the review queue itself — UI places this under Admin -> Users, this is just the data. */
async function getSellerApplicationQueue({ status = 'pending' } = {}) {
  if (!['pending', 'approved', 'rejected'].includes(status)) {
    throw new ValidationError('status must be pending, approved, or rejected');
  }
  const { rows } = await db.query(
    `SELECT sa.*, u.full_name, u.phone, u.city_id, c.name AS city_name
     FROM seller_applications sa
     JOIN users u ON u.id = sa.user_id
     LEFT JOIN cities c ON c.id = u.city_id
     WHERE sa.status = $1
     ORDER BY sa.created_at ASC`,
    [status]
  );
  return rows;
}

/** FR-06, FR-07a: return the current user's latest application status. */
async function getSellerApplicationStatus(userId) {
  const { rows } = await db.query(
    `SELECT id, status, reason_for_selling, what_will_sell, rejection_reason,
            is_resubmission, created_at, reviewed_at
     FROM seller_applications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

// ---- FR-08, FR-08a, FR-08b, FR-09, FR-09a, FR-10: seller profile / gating ----

/** FR-08: gate for seller-only tools (listing creation, dashboard, offers). */
async function isApprovedSeller(userId) {
  const { rows } = await db.query(
    `SELECT u.role, u.is_suspended, sp.is_approved
     FROM users u JOIN seller_profiles sp ON sp.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  );
  return Boolean(rows[0]
    && rows[0].role === 'seller'
    && !rows[0].is_suspended
    && rows[0].is_approved);
}

/** FR-08a: ID verification is required only once a listing crosses the admin-configurable threshold. */
async function isIdVerificationRequired(listingPrice) {
  const thresholdPkr = await settlement.getSetting('high_value_threshold_pkr');
  return Number(listingPrice) > Number(thresholdPkr);
}

/** FR-08a: whether the seller has completed ID verification. */
async function isIdVerified(userId) {
  const { rows } = await db.query('SELECT id_verified FROM seller_profiles WHERE user_id = $1', [userId]);
  return Boolean(rows[0]?.id_verified);
}

/** FR-08a: email ownership verification is distinct from seller identity verification. */
async function isEmailVerified(userId) {
  const { rows } = await db.query('SELECT email_verified_at FROM users WHERE id = $1', [userId]);
  return Boolean(rows[0]?.email_verified_at);
}

/** FR-66: record an Admin's manual identity check; no document or ID number is accepted. */
async function verifySellerIdentity(userId, { adminId, note }) {
  const verifier = createIdentityVerifier({ adapter: 'manual-admin' });
  const result = await verifier.verify({ sellerId: userId, adminId, note });
  if (!result.verified || result.method !== 'manual_admin') throw new ValidationError('Manual identity verification was not completed.');
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE seller_profiles
          SET id_verified = true, verified_by = $2, verified_at = now(), verification_note = $3
        WHERE user_id = $1
        RETURNING user_id, id_verified, verified_by, verified_at, verification_note`,
      [userId, adminId, note]
    );
    if (!rows[0]) throw new NotFoundError('seller_profile', userId);
    return rows[0];
  });
}

/** FR-09: individual seller profile (must read as an individual, not a storefront). */
async function getSellerProfile(userId) {
  const { rows } = await db.query(
    `SELECT user_id, display_alias, is_approved, approved_at, id_verified,
            rating_avg, rating_count, created_at
       FROM seller_profiles WHERE user_id = $1`, [userId]
  );
  if (!rows[0]) throw new NotFoundError('seller_profile', userId);
  return rows[0];
}

function normalizePayoutInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Payout details are required.');
  const method = input.method;
  const common = ['method', 'stepUpGrant'];
  const trimText = (value, label, max = 120) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new ValidationError(`${label} is required and must be at most ${max} characters.`);
    return value.trim();
  };
  if (method === 'bank') {
    const allowed = new Set([...common, 'bankName', 'accountTitle', 'iban', 'accountNumber']);
    if (Object.keys(input).some((key) => !allowed.has(key)) || Boolean(input.iban) === Boolean(input.accountNumber)) {
      throw new ValidationError('Bank payouts require bankName, accountTitle, and exactly one of iban or accountNumber.');
    }
    const bankName = trimText(input.bankName, 'Bank name');
    const accountTitle = trimText(input.accountTitle, 'Account title');
    const field = input.iban ? 'iban' : 'accountNumber';
    const raw = trimText(input[field], field === 'iban' ? 'IBAN' : 'Account number', 34).toUpperCase().replace(/[\s-]/g, '');
    if (field === 'iban' ? !isValidPakistaniIban(raw) : !/^[A-Z0-9]{8,34}$/.test(raw)) {
      throw new ValidationError(field === 'iban' ? 'IBAN must be a valid Pakistani IBAN.' : 'Account number must contain 8 to 34 letters or digits.');
    }
    return { method, details: { bankName, accountTitle, [field]: raw }, last4: raw.slice(-4) };
  }
  if (method === 'easypaisa' || method === 'jazzcash') {
    const allowed = new Set([...common, 'walletNumber', 'accountHolderName']);
    if (Object.keys(input).some((key) => !allowed.has(key))) throw new ValidationError('Unsupported payout fields.');
    const walletNumber = trimText(input.walletNumber, 'Wallet number', 16).replace(/[\s-]/g, '');
    if (!/^(?:03\d{9}|923\d{9})$/.test(walletNumber)) throw new ValidationError('Wallet number must be a valid Pakistan mobile number.');
    const accountHolderName = trimText(input.accountHolderName, 'Account-holder name');
    return { method, details: { walletNumber, accountHolderName }, last4: walletNumber.slice(-4) };
  }
  throw new ValidationError('Payout method must be bank, easypaisa, or jazzcash.');
}

function isValidPakistaniIban(value) {
  if (!/^PK\d{2}[A-Z]{4}\d{16}$/.test(value)) return false;
  let remainder = 0;
  const rearranged = value.slice(4) + value.slice(0, 4);
  for (const character of rearranged) {
    const digits = character >= 'A' && character <= 'Z' ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** FR-09a / SEC-35: require seller TOTP and an action-bound grant; encrypt and queue a generic notice atomically. */
async function updateSellerPayoutMethod(userId, input) {
  const { sessionId, ...payoutInput } = input || {};
  const normalized = normalizePayoutInput(payoutInput);
  if (typeof payoutInput.stepUpGrant !== 'string' || typeof sessionId !== 'string') throw new ForbiddenError('A payout.update step-up grant is required.');
  const keyProvider = keyProviderFromEnv();
  return db.withTransaction(async (client) => {
    const { rows: profileRows } = await client.query(
      `SELECT sp.user_id, sp.is_approved, u.role, u.email
         FROM seller_profiles sp JOIN users u ON u.id = sp.user_id
        WHERE sp.user_id = $1 FOR UPDATE OF sp, u`, [userId]
    );
    const profile = profileRows[0];
    if (!profile) throw new NotFoundError('seller_profile', userId);
    if (profile.role !== 'seller' || !profile.is_approved) throw new ForbiddenError('An approved seller account is required.');
    if (!profile.email) throw new ValidationError('A verified account email is required for payout-change notices.');
    const { rows: factors } = await client.query(
      'SELECT enabled_at FROM seller_totp_credentials WHERE user_id = $1 FOR UPDATE', [userId]
    );
    if (!factors[0]?.enabled_at) throw new ForbiddenError('Enroll an authenticator before saving payout details.');
    await consumeStepUpGrantWithClient(client, userId, sessionId, 'payout.update', payoutInput.stepUpGrant);
    const encrypted = encryptPayoutDetails(normalized.details, userId, keyProvider);
    const { rows } = await client.query(
      `UPDATE seller_profiles SET payout_method = $2, payout_details_encrypted = $3::jsonb,
          payout_last4 = $4, payout_changed_at = now(), payout_needs_update = false,
          payout_bank_account = NULL, payout_wallet_number = NULL
        WHERE user_id = $1
        RETURNING user_id, payout_method, payout_last4, payout_changed_at`,
      [userId, normalized.method, JSON.stringify(encrypted), normalized.last4]
    );
    await queueEmail(profile.email, 'Your Poshaak payout details changed',
      'Payout details were changed for your Poshaak account. If this was not you, contact support.',
      { transaction: client, idempotencyKey: `payout-change:${userId}:${randomUUID()}` });
    return { sellerId: rows[0].user_id, method: rows[0].payout_method, last4: rows[0].payout_last4, changedAt: rows[0].payout_changed_at };
  });
}

/** FR-09a: return only masked payout metadata to the seller. */
async function getSellerPayoutSummary(userId) {
  const { rows } = await db.query(
    `SELECT payout_method, payout_last4, payout_changed_at, payout_needs_update,
            payout_details_encrypted IS NOT NULL AS has_encrypted_details,
            payout_bank_account IS NOT NULL OR payout_wallet_number IS NOT NULL AS has_legacy_details
       FROM seller_profiles WHERE user_id = $1`, [userId]
  );
  if (!rows[0]) throw new NotFoundError('seller_profile', userId);
  return {
    method: rows[0].payout_method,
    last4: rows[0].payout_last4,
    changedAt: rows[0].payout_changed_at,
    configured: Boolean(rows[0].has_encrypted_details),
    needsUpdate: Boolean(rows[0].payout_needs_update || (rows[0].has_legacy_details && !rows[0].has_encrypted_details)),
  };
}

/** FR-09a / SEC-35: Admin sees only masked details and recent-change/hold flags. */
async function getSellerPayoutAdminQueue() {
  const recentDays = getSecurityLimits().PAYOUT_CHANGED_RECENT_DAYS;
  const { rows } = await db.query(
    `SELECT sp.user_id AS seller_id, sp.display_alias, sp.payout_method, sp.payout_last4,
            sp.payout_changed_at,
            (sp.payout_changed_at >= now() - ($1 * interval '1 day')) AS changed_recently,
            sp.id_verified, sp.payout_hold_active, sp.payout_hold_reason, sp.payout_hold_set_at,
            (sp.payout_details_encrypted IS NOT NULL) AS payout_configured,
            sp.payout_needs_update,
            EXISTS (SELECT 1 FROM seller_totp_credentials st WHERE st.user_id = sp.user_id AND st.enabled_at IS NOT NULL) AS authenticator_enabled
       FROM seller_profiles sp
      WHERE sp.payout_details_encrypted IS NOT NULL OR sp.payout_hold_active = true
         OR sp.payout_bank_account IS NOT NULL OR sp.payout_wallet_number IS NOT NULL
      ORDER BY sp.payout_changed_at DESC NULLS LAST, sp.user_id`, [recentDays]
  );
  return rows.map((row) => ({
    sellerId: row.seller_id, displayAlias: row.display_alias, method: row.payout_method,
    last4: row.payout_last4, changedAt: row.payout_changed_at,
    changedRecently: Boolean(row.changed_recently), idVerified: Boolean(row.id_verified),
    payoutHoldActive: Boolean(row.payout_hold_active), payoutHoldReason: row.payout_hold_reason,
    payoutHoldSetAt: row.payout_hold_set_at, payoutConfigured: Boolean(row.payout_configured),
    needsUpdate: Boolean(row.payout_needs_update),
    authenticatorEnabled: Boolean(row.authenticator_enabled),
  }));
}

/** FR-83l: Admin places an audited pause on seller disbursements. */
async function setSellerPayoutHold(sellerId, { adminId, reason }) {
  const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
  if (!normalizedReason || normalizedReason.length > 500) throw new ValidationError('A short payout-hold reason is required.');
  const { rows } = await db.query(
    `UPDATE seller_profiles SET payout_hold_active = true, payout_hold_reason = $2,
        payout_hold_set_by = $3, payout_hold_set_at = now(),
        payout_hold_cleared_by = NULL, payout_hold_cleared_at = NULL, payout_hold_clear_reason = NULL
      WHERE user_id = $1
      RETURNING user_id, payout_hold_active, payout_hold_reason, payout_hold_set_by, payout_hold_set_at`,
    [sellerId, normalizedReason, adminId]
  );
  if (!rows[0]) throw new NotFoundError('seller_profile', sellerId);
  return rows[0];
}

/** FR-83l: clear an active payout pause while retaining the set/clear audit fields. */
async function clearSellerPayoutHold(sellerId, { adminId, reason }) {
  const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
  if (!normalizedReason || normalizedReason.length > 500) throw new ValidationError('A short payout-hold release reason is required.');
  const { rows } = await db.query(
    `UPDATE seller_profiles SET payout_hold_active = false, payout_hold_cleared_by = $2,
        payout_hold_cleared_at = now(), payout_hold_clear_reason = $3
      WHERE user_id = $1 AND payout_hold_active = true
      RETURNING user_id, payout_hold_active, payout_hold_reason, payout_hold_cleared_by, payout_hold_cleared_at, payout_hold_clear_reason`,
    [sellerId, adminId, normalizedReason]
  );
  if (!rows[0]) throw new NotFoundError('active seller payout hold', sellerId);
  return rows[0];
}

/** FR-66 / FR-83l: block disbursement unless ID, authenticator and payout-hold checks all pass. */
async function assertPayoutAllowed(sellerId) {
  const { rows } = await db.query(
    `SELECT sp.id_verified, sp.payout_hold_active, sp.payout_details_encrypted, sp.payout_needs_update,
            EXISTS (SELECT 1 FROM seller_totp_credentials st WHERE st.user_id = sp.user_id AND st.enabled_at IS NOT NULL) AS authenticator_enabled
       FROM seller_profiles sp WHERE sp.user_id = $1`, [sellerId]
  );
  const profile = rows[0];
  if (!profile) throw new NotFoundError('seller_profile', sellerId);
  if (!profile.id_verified) throw new ForbiddenError('Seller identity verification is required before payout.');
  if (!profile.authenticator_enabled) throw new ForbiddenError('An enrolled authenticator is required before payout.');
  if (profile.payout_hold_active) throw new ForbiddenError('Seller payouts are paused by an Admin.');
  if (!profile.payout_details_encrypted || profile.payout_needs_update) throw new ForbiddenError('Current encrypted payout details are required before payout.');
  return true;
}

/** FR-10: admin can suspend/revoke seller approval. Moderator CANNOT (FR-05a) — enforced at route level via lib/roles.js. */
async function suspendSeller(userId, { adminId, reason }) {
  const rows = await db.withTransaction(async (client) => {
    const { rows: updatedUsers } = await client.query(
      `UPDATE users SET is_suspended = true, updated_at = now() WHERE id = $1
       RETURNING id, role, is_suspended`, [userId]
    );
    if (!updatedUsers[0]) throw new NotFoundError('user', userId);
    await client.query(
      'UPDATE seller_profiles SET is_approved = false, approved_at = NULL WHERE user_id = $1', [userId]
    );
    return updatedUsers;
  });
  eventBus.emit(events.SELLER_SUSPENDED, { userId, adminId, reason });
  return rows[0];
}

module.exports = {
  registerUser,
  authenticate,
  authenticateStaffWithTotp,
  beginSellerAuthenticatorEnrollment,
  confirmSellerAuthenticatorEnrollment,
  createStepUpGrant,
  consumeStepUpGrant,
  disableSellerAuthenticator,
  changePasswordWithStepUp,
  STEP_UP_ACTIONS,
  requestPasswordReset,
  resetPassword,
  createInitialAdmin,
  completeBuyerLogin,
  refreshSession,
  revokeAllSessions,
  revokeSessionFamily,
  getAuthenticationPrincipal,
  requestEmailVerification,
  confirmEmailVerification,
  requestLoginEmailCode,
  confirmLoginEmailCode,
  assertCityVerified,
  listCities,
  createCity,
  getUserRole,
  submitSellerApplication,
  reviewSellerApplication,
  getSellerApplicationQueue,
  getSellerApplicationStatus,
  isApprovedSeller,
  isIdVerificationRequired,
  isIdVerified,
  isEmailVerified,
  verifySellerIdentity,
  getSellerProfile,
  updateSellerPayoutMethod,
  getSellerPayoutSummary,
  getSellerPayoutAdminQueue,
  setSellerPayoutHold,
  clearSellerPayoutHold,
  assertPayoutAllowed,
  suspendSeller,
};
