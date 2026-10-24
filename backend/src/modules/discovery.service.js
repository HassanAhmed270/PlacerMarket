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
const RESERVED_ORDER_STATUSES = [
  'bag', 'order_placed', 'seller_preparing', 'handed_to_delivery',
  'out_for_delivery', 'delivered', 'held',
];

function pageValue(value, fallback, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) throw new ValidationError('Pagination values must be non-negative integers');
  return Math.min(parsed, maximum);
}

function getLiveStatus(row) {
  if (row.status === 'removed' || row.status === 'unpublished') return 'removed';
  if (row.status === 'sold') return 'sold';
  if (row.status === 'paused') return 'unavailable';
  if (row.status !== 'published') return null;
  if (row.has_completed_order) return 'sold';
  return row.has_reservation ? 'reserved' : 'available';
}

function liveStatusFields(liveStatus) {
  return {
    status: liveStatus,
    liveStatus,
    available: liveStatus === 'available',
    reserved: liveStatus === 'reserved',
    sold: liveStatus === 'sold',
    removed: liveStatus === 'removed',
    unavailable: liveStatus === 'unavailable',
  };
}

function orderExistsSql(statuses) {
  return `EXISTS (
    SELECT 1 FROM orders o
     WHERE o.listing_id = l.id AND o.status = ANY($${statuses})
  )`;
}

function encodeFavoritesCursor(row) {
  return Buffer.from(JSON.stringify({
    createdAt: row.favorite_created_at,
    listingId: row.id,
  })).toString('base64url');
}

function decodeFavoritesCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > 512) {
    throw new ValidationError('Invalid favorites cursor');
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const validTimestamp = typeof decoded.createdAt === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(decoded.createdAt)
      && !Number.isNaN(Date.parse(decoded.createdAt));
    if (!UUID.test(decoded.listingId) || !validTimestamp) {
      throw new Error('Invalid cursor fields');
    }
    return { createdAt: decoded.createdAt, listingId: decoded.listingId };
  } catch {
    throw new ValidationError('Invalid favorites cursor');
  }
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
    `SELECT ${PUBLIC_LISTING_COLUMNS}, l.seller_id, l.status,
            ${orderExistsSql(2)} AS has_reservation,
            EXISTS (SELECT 1 FROM orders o WHERE o.listing_id = l.id AND o.status = 'completed') AS has_completed_order
       FROM listings l WHERE l.id = $1`,
    [listingId, RESERVED_ORDER_STATUSES]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  const liveStatus = getLiveStatus(row);
  if (!liveStatus) return null;
  if (liveStatus === 'removed') return { ...liveStatusFields(liveStatus) };
  const {
    seller_id: sellerId, status: _status, has_reservation: _hasReservation,
    has_completed_order: _hasCompletedOrder, ...listing
  } = row;
  const [seller, images] = await Promise.all([
    getSellerPublicCard(sellerId),
    listings.getListingImages(listingId),
  ]);
  const detail = { ...listing, ...liveStatusFields(liveStatus), seller, images };
  if (liveStatus === 'sold') {
    detail.similarItems = await getSimilarListings(row);
  }
  return detail;
}

async function getSimilarListings(listing) {
  const { rows } = await db.read(
    `SELECT ${PUBLIC_LISTING_COLUMNS},
            ${orderExistsSql(4)} AS has_reservation
       FROM listings l
      WHERE l.status = 'published'
        AND l.sub_category_id = $1
        AND l.id <> $2
        AND l.asking_price BETWEEN $3::numeric * 0.7 AND $3::numeric * 1.3
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT 6`,
    [listing.sub_category_id, listing.id, listing.asking_price, RESERVED_ORDER_STATUSES]
  );
  return rows.map((row) => {
    const { has_reservation: hasReservation, ...item } = row;
    const liveStatus = hasReservation ? 'reserved' : 'available';
    return { ...item, ...liveStatusFields(liveStatus) };
  });
}

/** FR-27: return the current public availability of a listing. */
async function getListingStatus(listingId) {
  const { rows } = await db.read(
    `SELECT l.status,
            ${orderExistsSql(2)} AS has_reservation,
            EXISTS (SELECT 1 FROM orders o WHERE o.listing_id = l.id AND o.status = 'completed') AS has_completed_order
       FROM listings l WHERE l.id = $1`,
    [listingId, RESERVED_ORDER_STATUSES]
  );
  if (!rows[0]) return null;
  const liveStatus = getLiveStatus(rows[0]);
  return liveStatus ? liveStatusFields(liveStatus) : null;
}

/** FR-26: favorite a listing (login-gated at the route). */
async function addFavorite(userId, listingId) {
  await db.write(
    'INSERT INTO favorites (user_id, listing_id) VALUES ($1, $2) ON CONFLICT (user_id, listing_id) DO NOTHING',
    [userId, listingId]
  );
}

/** FR-26: remove a favorite. */
async function removeFavorite(userId, listingId) {
  await db.write('DELETE FROM favorites WHERE user_id = $1 AND listing_id = $2', [userId, listingId]);
}

/** FR-26: list a user's favorites with a stable keyset cursor. */
async function getFavorites(userId, { limit = 20, cursor } = {}) {
  const safeLimit = pageValue(limit, 20, 100);
  if (safeLimit < 1) throw new ValidationError('limit must be at least 1');
  const decodedCursor = decodeFavoritesCursor(cursor);
  const cursorClause = decodedCursor ? 'AND (f.created_at, f.listing_id) < ($2::timestamptz, $3::uuid)' : '';
  const orderStatusParameter = decodedCursor ? 4 : 2;
  const limitParameter = decodedCursor ? '$5' : '$3';
  const { rows } = await db.read(
    `SELECT ${PUBLIC_LISTING_COLUMNS},
            to_char(f.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS favorite_created_at,
            l.status,
            ${orderExistsSql(orderStatusParameter)} AS has_reservation,
            EXISTS (SELECT 1 FROM orders o WHERE o.listing_id = l.id AND o.status = 'completed') AS has_completed_order
       FROM favorites f
       JOIN listings l ON l.id = f.listing_id
      WHERE f.user_id = $1 ${cursorClause}
      ORDER BY f.created_at DESC, f.listing_id DESC
      LIMIT ${limitParameter}`,
    decodedCursor
      ? [userId, decodedCursor.createdAt, decodedCursor.listingId, RESERVED_ORDER_STATUSES, safeLimit + 1]
      : [userId, RESERVED_ORDER_STATUSES, safeLimit + 1]
  );
  const hasMore = rows.length > safeLimit;
  const page = rows.slice(0, safeLimit).map((row) => {
    const {
      status, has_reservation: hasReservation, has_completed_order: hasCompletedOrder,
      ...item
    } = row;
    return {
      ...item,
      ...liveStatusFields(getLiveStatus({
        status, has_reservation: hasReservation, has_completed_order: hasCompletedOrder,
      })),
    };
  });
  return {
    items: page,
    nextCursor: hasMore ? encodeFavoritesCursor(page[page.length - 1]) : null,
  };
}

/** FR-27: public share link for a listing, no login needed. */
function buildShareUrl(listingId) {
  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return `${baseUrl}/listing/${encodeURIComponent(listingId)}`;
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
  searchListings, filterListings, getListingDetail, getListingStatus, addFavorite, removeFavorite, getFavorites,
  buildShareUrl, getSellerPublicCard,
};
