/**
 * modules/users.service.js
 *
 * Owns: FR-01 to FR-10 (specs.md section "1. Identity & Users")
 * Tables owned: cities, users, seller_applications, seller_profiles
 *
 * Cross-module dependencies this file has OUT to other services:
 * - settlement.service.getSetting('high_value_threshold_pkr') for FR-08a
 *   (the price threshold that triggers CNIC/ID verification lives in
 *   platform_settings, owned by settlement.service.js, not here).
 *
 * Cross-module dependencies other files have IN to this file:
 * - listings.service.js calls isIdVerified() and isApprovedSeller() before
 *   allowing a listing to go live (FR-08, FR-19b).
 * - admin.service.js delegates FR-52/53 user + seller-application management
 *   here instead of re-implementing it.
 */

const db = require('../db.service');
const settlement = require('./settlement.service');
const eventBus = require('../lib/eventBus');
const events = require('../lib/events');
const { NotFoundError, ForbiddenError, ValidationError, NotImplementedError } = require('../lib/errors');

// ---- FR-01, FR-02: registration & auth ----

/** FR-01: register a new user, buyer role by default. */
async function registerUser({ name, phone, email, passwordHash, cityId }) {
  const { rows } = await db.query(
    `INSERT INTO users (full_name, phone, email, password_hash, city_id, role)
     VALUES ($1, $2, $3, $4, $5, 'buyer') RETURNING *`,
    [name, phone, email, passwordHash, cityId]
  );
  return rows[0];
}

/** FR-02: authenticate credentials and issue/manage a session. */
async function authenticate({ email, password }) {
  // TODO: look up user by email, verify password hash, issue session/JWT.
  // Left as a stub — depends on the session strategy you pick (cookie
  // session vs JWT), which hasn't been decided yet in specs.md.
  throw new NotImplementedError('authenticate() — pick a session strategy first');
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
  const { rows } = await db.query(
    `UPDATE seller_applications
     SET status = $1, rejection_reason = $2, reviewed_by = $3, reviewed_at = now()
     WHERE id = $4 RETURNING *`,
    [decision, reason || null, reviewerId, applicationId]
  );
  if (!rows[0]) throw new NotFoundError('seller_application', applicationId);

  if (decision === 'approved') {
    await db.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO seller_profiles (user_id, is_approved, approved_at)
         VALUES ($1, true, now())
         ON CONFLICT (user_id) DO UPDATE SET is_approved = true, approved_at = now()`,
        [rows[0].user_id]
      );
      await client.query(`UPDATE users SET role = 'seller' WHERE id = $1`, [rows[0].user_id]);
    });
  }

  eventBus.emit(events.SELLER_APPLICATION_STATUS_CHANGED, { applicationId, decision, reason });
  return rows[0];
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
  return Number(listingPrice) >= Number(thresholdPkr);
}

/** FR-08a: whether the seller has completed ID verification. */
async function isIdVerified(userId) {
  const { rows } = await db.query('SELECT id_verified FROM seller_profiles WHERE user_id = $1', [userId]);
  return Boolean(rows[0]?.id_verified);
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
  const { rows } = await db.query(`UPDATE users SET is_suspended = true WHERE id = $1 RETURNING *`, [userId]);
  if (!rows[0]) throw new NotFoundError('user', userId);
  eventBus.emit(events.SELLER_SUSPENDED, { userId, adminId, reason });
  return rows[0];
}

module.exports = {
  registerUser,
  authenticate,
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
  markIdVerified,
  getSellerProfile,
  updateSellerPayoutMethod,
  suspendSeller,
};
