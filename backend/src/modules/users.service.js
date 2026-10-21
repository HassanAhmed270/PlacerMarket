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

const { randomUUID } = require('node:crypto');
const db = require('../db.service');
const settlement = require('./settlement.service');
const eventBus = require('../lib/eventBus');
const events = require('../lib/events');
const { hashPassword } = require('../lib/passwordHashPool');
const { NotFoundError, ForbiddenError, ValidationError, NotImplementedError } = require('../lib/errors');
const { getSecurityLimits } = require('../config');
const {
  makeCode, addressDigest, queueCodeEmail, reserveAddressSend, emailVerificationLocked,
  emailCodeLockedForDigest, hashCode, equalHash,
} = require('../lib/emailCodeDelivery');

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
async function getAuthenticationPrincipal(userId) {
  const { rows } = await db.query(
    'SELECT id, role, is_suspended FROM users WHERE id = $1', [userId]
  );
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
  if (typeof loginAttemptId !== 'string' || !/^[0-9a-f-]{36}$/i.test(loginAttemptId) ||
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
  if (typeof loginAttemptId !== 'string' || !/^[0-9a-f-]{36}$/i.test(loginAttemptId) ||
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

/** FR-02: authenticate credentials and issue/manage a session. */
async function authenticate({ email, password }) {
  // TODO FR-02/FR-84: implement after refresh-session and required 2FA
  // persistence are approved. The owner selected Argon2id (FR-84b).
  throw new NotImplementedError('authenticate() — required session and 2FA persistence');
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
