/**
 * modules/admin.service.js
 *
 * Owns: FR-52 to FR-59 (specs.md section "12. Administration")
 * Tables owned: NONE — per schema.sql's own note, admin actions operate on
 * users, seller_applications, listings, orders, disputes, platform_settings,
 * and delivery_partners, all of which already have an owning service file.
 *
 * THIS FILE IS A THIN ORCHESTRATION/FACADE LAYER, NOT A LOGIC OWNER. If a
 * change belongs in "what counts as a valid seller application decision" or
 * "how a listing gets approved", that logic goes in users.service.js /
 * listings.service.js — NOT here. This file only calls straight through to
 * the owning service's exported function. If you find yourself writing a
 * SQL query directly in this file, stop — the function belongs in the
 * owning module instead.
 *
 * PERMISSIONS ARE NOT CHECKED HERE. Per rules.md Section 5, permission
 * checks live at the route layer only (routes/admin.routes.js, via
 * requirePermission()). Nothing in this file looks at a role.
 */

const users = require('./users.service');
const listings = require('./listings.service');
const disputes = require('./disputes.service');
const delivery = require('./delivery.service');
const settlement = require('./settlement.service');
const payout = require('./payout.service');
const { ValidationError } = require('../lib/errors');

// ---- FR-52: users ----

/** FR-52, FR-10: admin suspends a user (delegates to users.service). */
async function suspendUser(userId, { adminId, reason }) {
  return users.suspendSeller(userId, { adminId, reason });
}

// ---- FR-53: seller applications ----

/** FR-53, FR-07: admin/moderator decides a seller application (delegates to users.service). */
async function reviewSellerApplication(applicationId, { decision, reason, reviewerId }) {
  return users.reviewSellerApplication(applicationId, { decision, reason, reviewerId });
}

/** FR-07b: admin/moderator reads the seller-application review queue. */
async function getSellerApplicationQueue(options) {
  return users.getSellerApplicationQueue(options);
}

/** FR-09a / SEC-35: Admin view contains masked payout metadata and safety flags only. */
async function getSellerPayoutQueue() {
  return users.getSellerPayoutAdminQueue();
}

/** FR-83l: Admin sets a seller-level disbursement pause. */
async function setSellerPayoutHold(sellerId, { adminId, reason }) {
  return users.setSellerPayoutHold(sellerId, { adminId, reason });
}

/** FR-83l: Admin clears a payout pause with a separate reason. */
async function clearSellerPayoutHold(sellerId, { adminId, reason }) {
  return users.clearSellerPayoutHold(sellerId, { adminId, reason });
}

/** FR-66: Admin-only manual identity check delegates storage to users.service. */
async function verifySellerIdentity(sellerId, { adminId, note }) {
  return users.verifySellerIdentity(sellerId, { adminId, note });
}

// ---- FR-54: listings ----

/** FR-54, FR-19a: approve a listing to go live (delegates to listings.service). */
async function approveListing(listingId, reviewerId) {
  return listings.approveListing(listingId, reviewerId);
}

/** FR-54, FR-21: reject/unpublish a listing with a reason (delegates to listings.service). */
async function rejectListing(listingId, { reviewerId, reason }) {
  return listings.rejectOrUnpublishListing(listingId, { reviewerId, reason });
}

/** FR-54, FR-18: manually set the Verified badge (delegates to listings.service). */
async function grantVerifiedBadge(listingId, { granted, reviewerId }) {
  return listings.setVerifiedBadge(listingId, { granted, reviewerId });
}

// ---- FR-55: monitor orders/delivery/COD (read-only aggregation) ----

/** FR-55, FR-45h: combined held-orders + dispute view for ops (delegates to payout.service). */
async function getOperationsOverview() {
  // Delegates to the owning modules' existing read functions rather than
  // querying `orders` / `cod_collections` directly from here.
  return payout.getHeldOrdersWithDisputeStatus(); // combined HELD + dispute view (FR-44/FR-45h) already covers most of this
}

// ---- FR-56: disputes ----

/** FR-56, FR-45: resolve a dispute (delegates to disputes.service). */
async function resolveDispute(disputeId, { resolutionAmountToBuyer, resolvedBy, resolutionNote }) {
  return disputes.resolveDispute(disputeId, { resolutionAmountToBuyer, resolvedBy, resolutionNote });
}

// ---- FR-57: delivery partner config ----

/** FR-57, FR-40a: admin creates/activates delivery partners (delegates to delivery.service). */
async function manageDeliveryPartner(action, ...args) {
  if (action === 'create') return delivery.createDeliveryPartner(...args);
  if (action === 'setActive') return delivery.setDeliveryPartnerActive(...args);
  throw new ValidationError(`Unknown delivery partner admin action: ${action}`);
}

// ---- FR-58: fee configuration ----

/** FR-58, FR-50: admin adjusts the commission % (delegates to settlement.service). */
async function configureFees(newCommissionPercent, adminId) {
  return settlement.adjustCommissionPercent(newCommissionPercent, adminId);
}

// ---- FR-59: advertising/analytics ----

/**
 * FR-59: no ad_campaigns table exists yet (per schema.sql's own note —
 * "future ad_campaigns table, not yet modeled — deferred"). This is a
 * placeholder so the route/router surface exists; do NOT build real logic
 * against it until that table is scoped and added to schema.sql.
 */
async function getAdvertisingOverview() {
  return { note: 'FR-59 deferred — ad_campaigns table not yet modeled in schema.sql' };
}

module.exports = {
  suspendUser,
  reviewSellerApplication,
  getSellerApplicationQueue,
  getSellerPayoutQueue,
  setSellerPayoutHold,
  clearSellerPayoutHold,
  verifySellerIdentity,
  approveListing,
  rejectListing,
  grantVerifiedBadge,
  getOperationsOverview,
  resolveDispute,
  manageDeliveryPartner,
  configureFees,
  getAdvertisingOverview,
};
