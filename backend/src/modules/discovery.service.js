/**
 * Owns favorites; reviews are read through orders.service.js. Public listing
 * image reads go through listings.service.js, which owns listing_images.
 */
const db = require('../db.service');
const users = require('./users.service');
const orders = require('./orders.service');
const listings = require('./listings.service');
const { ValidationError } = require('../lib/errors');

const PUBLIC_LISTING_COLUMNS = `l.id, l.main_category_id, l.sub_category_id, l.condition,
  l.replica_disclosure, l.title, l.description, l.asking_price, l.fabric_material, l.brand, l.color,
  l.embellishment_detail, l.created_at, l.updated_at`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    `SELECT ${PUBLIC_LISTING_COLUMNS} FROM listings l
     WHERE l.status = 'published' AND (l.title ILIKE $1 OR l.description ILIKE $1)
     ORDER BY l.created_at DESC LIMIT $2 OFFSET $3`,
    [`%${keyword.trim()}%`, safeLimit, safeOffset]
  );
  return rows;
}

/** FR-24: filter published listings; cityId follows the seller's registered city. */
async function filterListings({ mainCategoryId, subCategoryId, condition, minPrice, maxPrice, cityId }) {
  if (cityId !== undefined && cityId !== null && (typeof cityId !== 'string' || !UUID.test(cityId))) {
    throw new ValidationError('cityId must be a valid city UUID');
  }
  // cross-module read: users (owned by users.service.js), permitted for this multi-table public listing filter.
  const clauses = ["l.status = 'published'"];
  const params = [];
  if (mainCategoryId) { params.push(mainCategoryId); clauses.push(`l.main_category_id = $${params.length}`); }
  if (subCategoryId) { params.push(subCategoryId); clauses.push(`l.sub_category_id = $${params.length}`); }
  if (condition) { params.push(condition); clauses.push(`l.condition = $${params.length}`); }
  if (minPrice !== undefined && minPrice !== null && minPrice !== '') {
    const value = Number(minPrice);
    if (!Number.isFinite(value) || value < 0) throw new ValidationError('minPrice must be a non-negative number');
    params.push(value); clauses.push(`l.asking_price >= $${params.length}`);
  }
  if (maxPrice !== undefined && maxPrice !== null && maxPrice !== '') {
    const value = Number(maxPrice);
    if (!Number.isFinite(value) || value < 0) throw new ValidationError('maxPrice must be a non-negative number');
    params.push(value); clauses.push(`l.asking_price <= $${params.length}`);
  }
  if (cityId) { params.push(cityId); clauses.push(`u.city_id = $${params.length}`); }
  if (minPrice != null && maxPrice != null && minPrice !== '' && maxPrice !== '' && Number(minPrice) > Number(maxPrice)) {
    throw new ValidationError('minPrice cannot exceed maxPrice');
  }
  const { rows } = await db.read(
    `SELECT ${PUBLIC_LISTING_COLUMNS} FROM listings l
     JOIN users u ON u.id = l.seller_id
     WHERE ${clauses.join(' AND ')} ORDER BY l.created_at DESC`, params
  );
  return rows;
}

/** FR-25: return published listing details, approved photos, and the permitted seller summary. */
async function getListingDetail(listingId) {
  const { rows } = await db.read(
    `SELECT ${PUBLIC_LISTING_COLUMNS}, l.seller_id FROM listings l WHERE l.id = $1 AND l.status = 'published'`, [listingId]
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
    displayAlias: profile.display_alias,
    joinDate: profile.created_at,
    averageRating: ratingSummary.averageRating,
    ratingCount: ratingSummary.ratingCount,
  };
}

module.exports = {
  searchListings, filterListings, getListingDetail, addFavorite, removeFavorite,
  buildShareUrl, getSellerPublicCard,
};
