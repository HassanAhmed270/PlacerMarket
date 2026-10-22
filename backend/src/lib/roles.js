/**
 * lib/roles.js
 *
 * FR-05, FR-05a: role definitions and the Admin vs Moderator/Ops permission
 * split. Route files check permissions through `hasPermission()` here —
 * do not hardcode `if (role === 'admin')` checks scattered across route
 * files, or the Moderator/Ops scope (FR-05a, FR-53/54/56) will drift out of
 * sync with this list over time.
 */

const ROLES = Object.freeze({
  BUYER: 'buyer',
  SELLER: 'seller',
  ADMIN: 'admin',
  MODERATOR: 'moderator', // "Moderator/Ops" in specs.md
});

// Actions a Moderator/Ops account IS allowed to perform (FR-05a).
// Anything not in this list, for a moderator, is denied.
const MODERATOR_ALLOWED_ACTIONS = new Set([
  'listing.review', // FR-54
  'listing.approve',
  'listing.reject',
  'listing.grant_verified_badge',
  'dispute.review', // FR-56
  'dispute.resolve',
  'seller_application.approve', // FR-07, FR-53
  'seller_application.reject',
]);

// Explicitly Admin-only per FR-05a / FR-58 — listed for clarity even though
// hasPermission() below would deny these to a moderator by default anyway.
const ADMIN_ONLY_ACTIONS = new Set([
  'catalog.manage', // FR-12, FR-15a
  'seller_identity.verify', // FR-66, manual identity check
  'fee.configure', // FR-58
  'user.suspend', // FR-10, FR-05a ("cannot suspend users")
  'user.reinstate',
  'delivery_partner.configure', // FR-57
  'advertising.manage', // FR-59
  'operations.view', // FR-55
]);

/**
 * @param {string} role - one of ROLES
 * @param {string} action - e.g. 'listing.approve'
 * @returns {boolean}
 */
function hasPermission(role, action) {
  if (role === ROLES.ADMIN) return true;
  if (role === ROLES.MODERATOR) return MODERATOR_ALLOWED_ACTIONS.has(action);
  return false;
}

module.exports = { ROLES, MODERATOR_ALLOWED_ACTIONS, ADMIN_ONLY_ACTIONS, hasPermission };
