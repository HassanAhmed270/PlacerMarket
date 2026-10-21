/**
 * modules/users.service.js
 *
 * Owns: FR-01 to FR-10 (specs.md section "1. Identity & Users")
 * Tables owned: cities, users, seller_applications, seller_profiles,
 * auth_sessions, email_login_codes, password_reset_tokens, staff_totp_credentials
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

const { randomUUID, randomBytes, createHash } = require('node:crypto');
const db = require('../db.service');
const settlement = require('./settlement.service');
const eventBus = require('../lib/eventBus');
const events = require('../lib/events');
const { hashPassword, verifyPassword } = require('../lib/passwordHashPool');
const { signAccessToken, getJwtConfig } = require('../lib/jwt');
const { decryptStaffTotpSecret, matchingTotpStep } = require('../lib/totp');
const { encryptStaffTotpSecret, verifyTotpCode } = require('../lib/totp');
const { NotFoundError, ForbiddenError, ValidationError } = require('../lib/errors');
const { getSecurityLimits } = require('../config');
const {
  makeCode, addressDigest, queueCodeEmail, queueEmail, reserveAddressSend, emailVerificationLocked,
  emailCodeLockedForDigest, hashCode, equalHash,
} = require('../lib/emailCodeDelivery');

const STAFF_ROLES = new Set(['admin', 'moderator']);
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

function issueAccessToken(userId, sessionId) {
  const jwt = getJwtConfig();
  return { token: signAccessToken(userId, { ...jwt, sessionId }), lifetimeSeconds: jwt.lifetimeSeconds };
}

async function insertSession(client, user, { familyId = randomUUID(), absoluteExpiresAt } = {}) {
  const now = Date.now();
  const policy = refreshPolicy(user.role);
  const absolute = absoluteExpiresAt || new Date(now + policy.absoluteSeconds * 1000);
  const expiresAt = new Date(Math.min(now + policy.idleSeconds * 1000, absolute.getTime()));
  const refreshToken = randomBytes(32).toString('base64url');
  const sessionId = randomUUID();
  const access = issueAccessToken(user.id, sessionId);
  const { rows } = await client.query(
    `INSERT INTO auth_sessions
      (id, family_id, user_id, refresh_token_hash, expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [sessionId, familyId, user.id, tokenDigest(refreshToken), expiresAt, absolute]
  );
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
      `SELECT u.id, u.role, u.is_suspended FROM users u
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
async function authenticate({ email, password }) {
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
  // Seller factor requirements remain parked under FR-83c; do not issue a session.
  return null;
}

/** FR-02, FR-83h: finish a buyer login only with its matching single-use email code. */
async function completeBuyerLogin(loginAttemptId, code, email) {
  const userId = await confirmLoginEmailCode(loginAttemptId, code);
  if (!userId) return null;
  const { rows } = await db.query(
    'SELECT id, email, role, is_suspended FROM users WHERE id = $1', [userId]
  );
  const principal = rows[0];
  if (!principal || principal.is_suspended || principal.role !== 'buyer' || principal.email !== email) return null;
  return db.withTransaction((client) => insertSession(client, principal));
}

/** FR-02, FR-83h: staff login requires a valid password plus the enrolled authenticator. */
async function authenticateStaffWithTotp({ email, password, code }) {
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
  if (!passwordMatches || user.is_suspended || !STAFF_ROLES.has(user.role)) return null;
  return db.withTransaction(async (client) => {
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
    return insertSession(client, user);
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

/** FR-84: rotate a hashed refresh token, enforce both expiry limits, and revoke its family on reuse. */
async function refreshSession(refreshToken) {
  if (typeof refreshToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(refreshToken)) return null;
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT s.id, s.family_id, s.user_id, s.expires_at, s.absolute_expires_at,
              s.consumed_at, s.revoked_at, u.role, u.is_suspended
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
    }, { familyId: session.family_id, absoluteExpiresAt: session.absolute_expires_at });
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

/** FR-06: buyer submits a "Become a Seller" application (name/phone/city only, no CNIC here). */
async function submitSellerApplication(userId, { name, phone, cityId }) {
  const { rows } = await db.query(
    `INSERT INTO seller_applications (user_id, name, phone, city_id, status)
     VALUES ($1, $2, $3, $4, 'pending') RETURNING *`,
    [userId, name, phone, cityId]
  );
  return rows[0];
}

/**
 * FR-07: admin or moderator reviews an application.
 * FR-07a: rejections can be resubmitted — no cooldown enforced here by design.
 */
async function reviewSellerApplication(applicationId, { decision, reason, reviewerId }) {
  if (!['approved', 'rejected'].includes(decision)) {
    throw new ValidationError('decision must be "approved" or "rejected"');
  }
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE seller_applications
       SET status = $1, rejection_reason = $2, reviewed_by = $3, reviewed_at = now()
       WHERE id = $4 RETURNING *`,
      [decision, reason || null, reviewerId, applicationId]
    );
    if (!rows[0]) throw new NotFoundError('seller_application', applicationId);

    if (decision === 'approved') {
      await client.query(
        `INSERT INTO seller_profiles (user_id, is_approved, approved_at)
         VALUES ($1, true, now())
         ON CONFLICT (user_id) DO UPDATE SET is_approved = true, approved_at = now()`,
        [rows[0].user_id]
      );
      await client.query(`UPDATE users SET role = 'seller' WHERE id = $1`, [rows[0].user_id]);
    }
    await eventBus.emitAsync(events.SELLER_APPLICATION_STATUS_CHANGED, { applicationId, decision, reason }, { transaction: client });
    return rows[0];
  });
}

/** FR-07b: the review queue itself — UI places this under Admin -> Users, this is just the data. */
async function getSellerApplicationQueue({ status = 'pending' } = {}) {
  const { rows } = await db.query(
    'SELECT * FROM seller_applications WHERE status = $1 ORDER BY created_at ASC',
    [status]
  );
  return rows;
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

/** FR-08a: mark a seller ID-verified. */
async function markIdVerified(userId, adminId) {
  await db.query('UPDATE seller_profiles SET id_verified = true WHERE user_id = $1', [userId]);
}

/** FR-09: individual seller profile (must read as an individual, not a storefront). */
async function getSellerProfile(userId) {
  const { rows } = await db.query('SELECT * FROM seller_profiles WHERE user_id = $1', [userId]);
  if (!rows[0]) throw new NotFoundError('seller_profile', userId);
  return rows[0];
}

/** FR-09a: payout method is bank transfer or mobile wallet, seller's choice, switchable. */
async function updateSellerPayoutMethod(userId, { method, details }) {
  if (!['bank_transfer', 'mobile_wallet'].includes(method)) {
    throw new ValidationError('payout method must be "bank_transfer" or "mobile_wallet"');
  }
  const { rows } = await db.query(
    `UPDATE seller_profiles SET payout_method = $1, payout_details = $2 WHERE user_id = $3 RETURNING *`,
    [method, details, userId]
  );
  return rows[0];
}

/** FR-10: admin can suspend/revoke seller approval. Moderator CANNOT (FR-05a) — enforced at route level via lib/roles.js. */
async function suspendSeller(userId, { adminId, reason }) {
  const { rows } = await db.query(
    `UPDATE users SET is_suspended = true WHERE id = $1 RETURNING id, role, is_suspended`, [userId]
  );
  if (!rows[0]) throw new NotFoundError('user', userId);
  eventBus.emit(events.SELLER_SUSPENDED, { userId, adminId, reason });
  return rows[0];
}

module.exports = {
  registerUser,
  authenticate,
  authenticateStaffWithTotp,
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
  isApprovedSeller,
  isIdVerificationRequired,
  isIdVerified,
  isEmailVerified,
  markIdVerified,
  getSellerProfile,
  updateSellerPayoutMethod,
  suspendSeller,
};
