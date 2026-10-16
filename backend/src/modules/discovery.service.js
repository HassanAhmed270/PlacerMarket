/**
 * modules/discovery.service.js
 *
 * Owns: FR-22 to FR-27b (specs.md section "4. Search & Discovery")
 * Tables owned: favorites (reviews live in orders.service.js — see FR-27b note below)
 *
 * FR-22, FR-22a, FR-22b are mostly a route-guarding / frontend-redirect
 * concern (public browsing vs. login-gated actions), not business logic —
 * this file exposes the read functions; the login gate itself belongs on
 * the Express route (auth middleware on /favorite, /message, /offer only).
 *
 * FR-27a/FR-27b: the seller's public card shows ONLY rating + join date.
 * The rating aggregate is computed from `reviews`, which is owned by
 * orders.service.js (reviews reference orders, and are created there) —
 * this file calls orders.service.getSellerRatingSummary() rather than
 * querying `reviews` directly, to keep one owner per table.
 */

const db = require('../db.service');
const users = require('./users.service');
const orders = require('./orders.service');

// ---- FR-23, FR-24, FR-25: search/filter/detail ----

/** FR-23: keyword search. */
async function searchListings(keyword, { limit = 20, offset = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM listings WHERE status = 'live' AND description ILIKE $1
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [`%${keyword}%`, limit, offset]
  );
  return rows;
}

/** FR-24: filter by main category, sub-category, condition, price range, city. */
async function filterListings({ mainCategoryId, subCategoryId, condition, minPrice, maxPrice, cityId }) {
  // TODO: build this as a dynamic WHERE clause once the filter UI's exact
  // field set is finalized — sketched here to show the shape.
  const clauses = ["status = 'live'"];
  const params = [];
  if (mainCategoryId) { params.push(mainCategoryId); clauses.push(`main_category_id = $${params.length}`); }
  if (subCategoryId) { params.push(subCategoryId); clauses.push(`sub_category_id = $${params.length}`); }
  if (condition) { params.push(condition); clauses.push(`condition = $${params.length}`); }
  if (minPrice) { params.push(minPrice); clauses.push(`asking_price >= $${params.length}`); }
  if (maxPrice) { params.push(maxPrice); clauses.push(`asking_price <= $${params.length}`); }
  const { rows } = await db.query(`SELECT * FROM listings WHERE ${clauses.join(' AND ')}`, params);
  return rows;
}

/** FR-25: full listing detail + seller summary + images. */
async function getListingDetail(listingId) {
  const { rows } = await db.query('SELECT * FROM listings WHERE id = $1', [listingId]);
  if (!rows[0]) return null;
  const sellerCard = await getSellerPublicCard(rows[0].seller_id); // FR-27a
  return { ...rows[0], seller: sellerCard };
}

// ---- FR-26: favorites (login-gated at the route level) ----

/** FR-26: favorite a listing (login-gated at the route). */
async function addFavorite(userId, listingId) {
  await db.query(
    'INSERT INTO favorites (user_id, listing_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [userId, listingId]
  );
}

/** FR-26: un-favorite a listing. */
async function removeFavorite(userId, listingId) {
  await db.query('DELETE FROM favorites WHERE user_id = $1 AND listing_id = $2', [userId, listingId]);
}

// ---- FR-27: share link (public, no login) ----

/** FR-27: public share link for a listing, no login needed. */
function buildShareUrl(listingId) {
  return `${process.env.PUBLIC_BASE_URL || ''}/listing/${listingId}`;
}

// ---- FR-27a: seller public card — rating + join date ONLY, nothing else ----

/** FR-27a, FR-27b: seller card: rating + join date only. */
async function getSellerPublicCard(sellerId) {
  const profile = await users.getSellerProfile(sellerId);
  const ratingSummary = await orders.getSellerRatingSummary(sellerId); // FR-27b feeds this
  return {
    sellerId,
    displayName: profile.display_name,
    joinDate: profile.created_at,
    averageRating: ratingSummary.averageRating,
    ratingCount: ratingSummary.ratingCount,
    // Deliberately no sales count, no verified badge, no response-time
    // stats here — those may appear on the seller's OWN private dashboard
    // (a different function, not this one) but never on the buyer-facing card.
  };
}

module.exports = {
  searchListings,
  filterListings,
  getListingDetail,
  addFavorite,
  removeFavorite,
  buildShareUrl,
  getSellerPublicCard,
};
