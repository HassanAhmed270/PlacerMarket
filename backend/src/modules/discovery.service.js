/**
 * Owns favorites; reviews are read through orders.service.js. Public listing
 * image reads go through listings.service.js, which owns listing_images.
 */
const db = require('../db.service');
const users = require('./users.service');
const orders = require('./orders.service');
const listings = require('./listings.service');
const { ValidationError } = require('../lib/errors');

const PUBLIC_LISTING_COLUMNS = `id, main_category_id, sub_category_id, condition,
  replica_disclosure, title, description, asking_price, fabric_material, brand, color,
  embellishment_detail, created_at, updated_at`;

function pageValue(value, fallback, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) throw new ValidationError('Pagination values must be non-negative integers');
  return Math.min(parsed, maximum);
}

/** FR-23: keyword-search public published listings by title or description. */
async function searchListings(keyword, { limit = 20, offset = 0 } = {}) {
  if (typeof keyword !== 'string' || !keyword.trim()) throw new ValidationError('A search keyword is required');
  const safeLimit = pageValue(limit, 20, 100);
  const safeOffset = pageValue(offset, 0, 10000);
  const { rows } = await db.read(
    `SELECT ${PUBLIC_LISTING_COLUMNS} FROM listings
     WHERE status = 'published' AND (title ILIKE $1 OR description ILIKE $1)
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [`%${keyword.trim()}%`, safeLimit, safeOffset]
  );
  return rows;
}

/** FR-24: apply supported filters; city remains unresolved because listings have no city column. */
async function filterListings({ mainCategoryId, subCategoryId, condition, minPrice, maxPrice, cityId }) {
  // FR-24 city filtering is tracked in open-questions.md: do not infer seller-city semantics.
  void cityId;
  const clauses = ["status = 'published'"];
  const params = [];
  if (mainCategoryId) { params.push(mainCategoryId); clauses.push(`main_category_id = $${params.length}`); }
  if (subCategoryId) { params.push(subCategoryId); clauses.push(`sub_category_id = $${params.length}`); }
  if (condition) { params.push(condition); clauses.push(`condition = $${params.length}`); }
  if (minPrice !== undefined && minPrice !== null && minPrice !== '') {
    const value = Number(minPrice);
    if (!Number.isFinite(value) || value < 0) throw new ValidationError('minPrice must be a non-negative number');
    params.push(value); clauses.push(`asking_price >= $${params.length}`);
  }
  if (maxPrice !== undefined && maxPrice !== null && maxPrice !== '') {
    const value = Number(maxPrice);
    if (!Number.isFinite(value) || value < 0) throw new ValidationError('maxPrice must be a non-negative number');
    params.push(value); clauses.push(`asking_price <= $${params.length}`);
  }
  if (minPrice != null && maxPrice != null && minPrice !== '' && maxPrice !== '' && Number(minPrice) > Number(maxPrice)) {
    throw new ValidationError('minPrice cannot exceed maxPrice');
  }
  const { rows } = await db.read(
    `SELECT ${PUBLIC_LISTING_COLUMNS} FROM listings WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params
  );
  return rows;
}

/** FR-25: return published listing details, approved photos, and the permitted seller summary. */
async function getListingDetail(listingId) {
  const { rows } = await db.read(
    `SELECT ${PUBLIC_LISTING_COLUMNS}, seller_id FROM listings WHERE id = $1 AND status = 'published'`, [listingId]
  );
  if (!rows[0]) return null;
  const { seller_id: sellerId, ...listing } = rows[0];
  const [seller, images] = await Promise.all([
    getSellerPublicCard(sellerId),
    listings.getListingImages(listingId),
  ]);
  return { ...listing, seller, images };
}

/** FR-26: favorite a listing (login-gated at the route). */
async function addFavorite(userId, listingId) {
  await db.write('INSERT INTO favorites (user_id, listing_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, listingId]);
}

/** FR-26: remove a favorite. */
async function removeFavorite(userId, listingId) {
  await db.write('DELETE FROM favorites WHERE user_id = $1 AND listing_id = $2', [userId, listingId]);
}

/** FR-27: public share link for a listing, no login needed. */
function buildShareUrl(listingId) {
  return `${process.env.PUBLIC_BASE_URL || ''}/listing/${listingId}`;
}

/** FR-27a: buyer-facing seller summary contains rating and join date only. */
async function getSellerPublicCard(sellerId) {
  const profile = await users.getSellerProfile(sellerId);
  const ratingSummary = await orders.getSellerRatingSummary(sellerId);
  return {
    joinDate: profile.created_at,
    averageRating: ratingSummary.averageRating,
    ratingCount: ratingSummary.ratingCount,
  };
}

module.exports = {
  searchListings, filterListings, getListingDetail, addFavorite, removeFavorite,
  buildShareUrl, getSellerPublicCard,
};
