/**
 * Owns favorites; reviews are read through orders.service.js. Public listing
 * image reads go through listings.service.js, which owns listing_images.
 */
const crypto = require('node:crypto');
const db = require('../db.service');
const users = require('./users.service');
const orders = require('./orders.service');
const listings = require('./listings.service');
const catalog = require('./catalog.service');
const { getSharedRedisClient } = require('../lib/redis');
const { buildSeoPayload } = require('../lib/listingSeo');
const { canonicalListingUrl, listingUrlKey, parseListingUrlKey } = require('../lib/listingUrls');
const { ValidationError } = require('../lib/errors');

const PUBLIC_LISTING_COLUMNS = `l.id, l.main_category_id, l.sub_category_id, l.condition,
  l.replica_disclosure, l.title, l.description, l.asking_price, l.fabric_material, l.brand, l.color,
  l.fabric_id, l.brand_id, l.color_id, l.slug, l.short_id,
  l.embellishment_detail, l.created_at, l.updated_at`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESERVED_ORDER_STATUSES = [
  'bag', 'order_placed', 'seller_preparing', 'handed_to_delivery',
  'out_for_delivery', 'delivered', 'held',
];
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_MAX_QUERY_LENGTH = 120;
const SEARCH_MAX_TERMS = 5;
const SEARCH_MAX_FILTERS = 8;
const SEARCH_CACHE_TTL_SECONDS = 60;
const SEARCH_SINGLE_FLIGHT = new Map();

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

function normalizeSort(sort, hasQuery) {
  const value = typeof sort === 'string' ? sort.trim().toLowerCase() : '';
  const mapping = {
    newest: 'newest',
    'price-asc': 'price_asc',
    'price_asc': 'price_asc',
    'price-low-high': 'price_asc',
    'price-desc': 'price_desc',
    'price_desc': 'price_desc',
    'price-high-low': 'price_desc',
    relevance: 'relevance',
  };
  if (mapping[value]) return mapping[value];
  return hasQuery ? 'relevance' : 'newest';
}

function normalizeFilterValue(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value).trim();
}

function normalizePublicQuery(rawQuery) {
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  if (!query) return { text: '', terms: [] };
  if (query.length > SEARCH_MAX_QUERY_LENGTH) {
    throw new ValidationError(`Search query must be ${SEARCH_MAX_QUERY_LENGTH} characters or fewer.`);
  }
  const terms = query
    .replace(/[\u2000-\u206F\u2E00-\u2E7F!@#$%^&*()+=\[\]{};:'"<>?,./~`_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 0)
    .slice(0, SEARCH_MAX_TERMS);
  if (terms.length === 0) return { text: '', terms: [] };
  return { text: query, terms };
}

function normalizeFilterCount(filters) {
  const count = Object.values(filters).filter((value) => value !== undefined && value !== null && value !== '').length;
  if (count > SEARCH_MAX_FILTERS) {
    throw new ValidationError('Too many search filters; reduce the number of selected filters.');
  }
}

function validateCatalogFilter(name, value) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new ValidationError(`${name} must be a valid UUID`);
  }
}

function buildSearchCacheKey(params) {
  const normalized = JSON.stringify(params);
  return `search:v1:${crypto.createHash('sha256').update(normalized).digest('hex')}`;
}

async function withSingleFlight(key, work) {
  const existing = SEARCH_SINGLE_FLIGHT.get(key);
  if (existing) return existing;
  const promise = Promise.resolve().then(work);
  SEARCH_SINGLE_FLIGHT.set(key, promise);
  promise.finally(() => SEARCH_SINGLE_FLIGHT.delete(key));
  return promise;
}

async function readSearchCache(key) {
  const client = getSharedRedisClient();
  if (!client || typeof client.get !== 'function') return null;
  try {
    const value = await client.get(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

async function writeSearchCache(key, payload) {
  const client = getSharedRedisClient();
  if (!client || typeof client.set !== 'function') return;
  try {
    await client.set(key, JSON.stringify(payload), { EX: SEARCH_CACHE_TTL_SECONDS });
  } catch {
    // Best-effort cache: ignore Redis write failures without blocking search results.
  }
}

async function expandSearchTerms(terms) {
  if (!terms.length) return terms;
  const { rows } = await db.query(
    `SELECT DISTINCT lower(trim(source_term)) AS term
     FROM search_synonyms
     WHERE lower(trim(source_term)) = ANY($1)
        OR lower(trim(target_term)) = ANY($1)
     UNION ALL
     SELECT DISTINCT lower(trim(target_term)) AS term
     FROM search_synonyms
     WHERE lower(trim(source_term)) = ANY($1)
        OR lower(trim(target_term)) = ANY($1)`,
    [terms]
  );
  const expanded = new Set(terms);
  for (const row of rows) if (row.term) expanded.add(row.term);
  return [...expanded];
}

function buildSearchCursor(order, row) {
  const payload = { order, value: {} };
  if (order === 'price_asc' || order === 'price_desc') {
    payload.value = { askingPrice: String(row.asking_price), publishedAt: row.published_at, listingId: row.id };
  } else {
    payload.value = { publishedAt: row.published_at, listingId: row.id };
  }
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeSearchCursor(cursor) {
  if (!cursor) return null;
  if (typeof cursor !== 'string') throw new ValidationError('Invalid search cursor');
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || !decoded.order || !decoded.value) {
      throw new Error('Malformed cursor payload');
    }
    return decoded;
  } catch {
    throw new ValidationError('Invalid search cursor');
  }
}

function buildSearchClauses({ mainCategoryId, subCategoryId, condition, minPrice, maxPrice, cityId, colorId, brandId, fabricId, queryTerms, queryText }) {
  const clauses = ['l.status = $1'];
  const params = ['published'];
  const push = (value, sql) => {
    if (value !== undefined && value !== null && value !== '') {
      params.push(value);
      clauses.push(sql.replace('$VALUE', `$${params.length}`));
    }
  };

  if (mainCategoryId) push(mainCategoryId, 'l.main_category_id = $VALUE');
  if (subCategoryId) push(subCategoryId, 'l.sub_category_id = $VALUE');
  if (condition) push(condition, 'l.condition = $VALUE');
  if (minPrice !== undefined && minPrice !== null && minPrice !== '') {
    const numeric = Number(minPrice);
    if (!Number.isFinite(numeric) || numeric < 0) throw new ValidationError('minPrice must be a non-negative number');
    params.push(numeric); clauses.push(`l.asking_price >= $${params.length}`);
  }
  if (maxPrice !== undefined && maxPrice !== null && maxPrice !== '') {
    const numeric = Number(maxPrice);
    if (!Number.isFinite(numeric) || numeric < 0) throw new ValidationError('maxPrice must be a non-negative number');
    params.push(numeric); clauses.push(`l.asking_price <= $${params.length}`);
  }
  if (cityId) push(cityId, 'seller.city_id = $VALUE');
  if (colorId) push(colorId, 'l.color_id = $VALUE');
  if (brandId) push(brandId, 'l.brand_id = $VALUE');
  if (fabricId) push(fabricId, 'l.fabric_id = $VALUE');

  if (minPrice != null && maxPrice != null && minPrice !== '' && maxPrice !== '' && Number(minPrice) > Number(maxPrice)) {
    throw new ValidationError('minPrice cannot exceed maxPrice');
  }

  if (queryTerms && queryTerms.length) {
    const likeParts = [];
    const fuzzyParts = [];
    for (const term of queryTerms) {
      params.push(`%${term}%`);
      likeParts.push(`s.search_text ILIKE $${params.length}`);
      if (term.length >= 3) {
        params.push(term);
        fuzzyParts.push(`s.search_text % $${params.length}`);
      }
    }
    if (queryText) {
      params.push(queryText);
      fuzzyParts.push(`s.search_text % $${params.length}`);
    }
    clauses.push(`(${[...likeParts, ...fuzzyParts].join(' OR ')})`);
  }

  return { clauses: clauses.join(' AND '), params };
}

async function executeSearchQuery({ query, filters, sort, limit, cursor }) {
  const normalizedQuery = normalizePublicQuery(query);
  const queryTerms = normalizedQuery.terms;
  const filterSet = {
    mainCategoryId: normalizeFilterValue(filters.mainCategoryId),
    subCategoryId: normalizeFilterValue(filters.subCategoryId),
    condition: normalizeFilterValue(filters.condition),
    minPrice: normalizeFilterValue(filters.minPrice),
    maxPrice: normalizeFilterValue(filters.maxPrice),
    cityId: normalizeFilterValue(filters.cityId ?? filters.city),
    colorId: normalizeFilterValue(filters.colorId ?? filters.color),
    brandId: normalizeFilterValue(filters.brandId ?? filters.brand),
    fabricId: normalizeFilterValue(filters.fabricId ?? filters.fabric),
  };
  validateCatalogFilter('mainCategoryId', filterSet.mainCategoryId);
  validateCatalogFilter('subCategoryId', filterSet.subCategoryId);
  validateCatalogFilter('cityId', filterSet.cityId);
  validateCatalogFilter('colorId', filterSet.colorId);
  validateCatalogFilter('brandId', filterSet.brandId);
  validateCatalogFilter('fabricId', filterSet.fabricId);
  normalizeFilterCount(filterSet);
  const normalizedSort = normalizeSort(sort, Boolean(normalizedQuery.text));
  const resolvedLimit = pageValue(limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
  const decodedCursor = decodeSearchCursor(cursor);
  const termSet = queryTerms.length ? await expandSearchTerms(queryTerms) : [];
  const baseTerms = termSet.length ? termSet : queryTerms;
  const filterClause = buildSearchClauses({ ...filterSet, queryTerms: baseTerms, sort: normalizedSort });
  const where = [`${filterClause.clauses}`];
  const params = [...filterClause.params];

  let orderBy = 'ORDER BY s.published_at DESC, s.listing_id DESC';
  let orderValueIndex = 1;
  if (normalizedSort === 'price_asc') {
    orderBy = 'ORDER BY s.asking_price ASC, s.published_at DESC, s.listing_id DESC';
  } else if (normalizedSort === 'price_desc') {
    orderBy = 'ORDER BY s.asking_price DESC, s.published_at DESC, s.listing_id DESC';
  } else if (normalizedSort === 'relevance' && normalizedQuery.text) {
    const tsTerms = baseTerms.map((term) => term.replace(/[^a-z0-9]+/gi, ' ').trim()).filter(Boolean);
    if (tsTerms.length) {
      const tsquery = tsTerms.map((term) => term.replace(/\s+/g, ':*')).join(' & ');
      params.push(tsquery);
      orderValueIndex = params.length;
      orderBy = `ORDER BY ts_rank_cd(s.search_vector, to_tsquery('simple', $${params.length})) DESC, s.published_at DESC, s.listing_id DESC`;
    }
  }

  if (decodedCursor && decodedCursor.order === normalizedSort) {
    const cursorValue = decodedCursor.value || {};
    if (normalizedSort === 'price_asc' || normalizedSort === 'price_desc') {
      params.push(cursorValue.askingPrice ?? null, cursorValue.publishedAt ?? null, cursorValue.listingId ?? null);
      where.push(`(s.asking_price, s.published_at, s.listing_id) < ($${params.length - 2}::numeric, $${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    } else {
      params.push(cursorValue.publishedAt ?? null, cursorValue.listingId ?? null);
      where.push(`(s.published_at, s.listing_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
  }

  const queryText = normalizedQuery.text;
  const rows = await db.searchQuery(
    `SELECT s.listing_id AS id,
            s.title,
            s.description,
            l.main_category_id,
            l.sub_category_id,
            l.condition,
            s.asking_price,
            s.seller_city,
            s.color,
            s.fabric,
            s.brand,
            s.is_reserved AS reserved,
            s.published_at,
            s.search_text,
            CASE WHEN s.is_reserved THEN 'reserved' ELSE 'available' END AS live_status,
            l.status
     FROM listing_search s
     JOIN listings l ON l.id = s.listing_id
     LEFT JOIN users seller ON seller.id = l.seller_id
     LEFT JOIN cities city ON city.id = seller.city_id
     WHERE ${where.join(' AND ')}
     ${orderBy}
     LIMIT $${params.length + 1}`,
    [...params, resolvedLimit + 1]
  );
  const items = rows.rows.map((row) => ({
    ...row,
    asking_price: String(row.asking_price ?? '0.00'),
    reserved: Boolean(row.reserved),
    liveStatus: row.reserved ? 'reserved' : 'available',
    available: !row.reserved,
    sold: false,
    status: 'published',
    seller_city: row.seller_city || null,
    relevance: queryText ? Math.max(0, 1) : 0,
  }));
  const hasNextPage = items.length > resolvedLimit;
  const pageItems = hasNextPage ? items.slice(0, resolvedLimit) : items;
  const nextCursor = hasNextPage ? buildSearchCursor(normalizedSort, pageItems[pageItems.length - 1]) : null;
  return { items: pageItems, nextCursor, hasNextPage };
}

/** FR-23: keyword-search public published listings by title or description. */
async function searchListings(keywordOrFilters, options = {}) {
  const input = typeof keywordOrFilters === 'string' ? { q: keywordOrFilters, ...options } : { ...keywordOrFilters, ...options };
  const q = normalizeFilterValue(input.q ?? input.query) || '';
  const filters = {
    mainCategoryId: normalizeFilterValue(input.mainCategoryId),
    subCategoryId: normalizeFilterValue(input.subCategoryId),
    condition: normalizeFilterValue(input.condition),
    minPrice: normalizeFilterValue(input.minPrice),
    maxPrice: normalizeFilterValue(input.maxPrice),
    cityId: normalizeFilterValue(input.cityId ?? input.city),
    colorId: normalizeFilterValue(input.colorId ?? input.color),
    brandId: normalizeFilterValue(input.brandId ?? input.brand),
    fabricId: normalizeFilterValue(input.fabricId ?? input.fabric),
  };
  const filterCount = Object.values(filters).filter((value) => value !== undefined && value !== null && value !== '').length;
  if (!q && filterCount === 0) throw new ValidationError('A search keyword is required');
  validateCatalogFilter('mainCategoryId', filters.mainCategoryId);
  validateCatalogFilter('subCategoryId', filters.subCategoryId);
  validateCatalogFilter('cityId', filters.cityId);
  validateCatalogFilter('colorId', filters.colorId);
  validateCatalogFilter('brandId', filters.brandId);
  validateCatalogFilter('fabricId', filters.fabricId);
  const sort = normalizeSort(input.sort, Boolean(q));
  const limit = input.limit ?? SEARCH_DEFAULT_LIMIT;
  const cursor = input.cursor;

  const searchKey = buildSearchCacheKey({ q, sort, limit, cursor, filters });
  const cached = await readSearchCache(searchKey);
  if (cached) return cached;

  const run = async () => executeSearchQuery({ query: q, filters, sort, limit, cursor });
  const result = await withSingleFlight(searchKey, run);
  await writeSearchCache(searchKey, result);
  return result;
}

/** FR-80c: return the current worker-built search suggestion vocabulary. */
async function getSearchVocabulary() {
  const [categories, brands, fabrics, colors, synonyms] = await Promise.all([
    db.query("SELECT id, name AS value FROM main_categories WHERE is_active = TRUE ORDER BY name"),
    db.query("SELECT value FROM managed_catalog_values WHERE attribute_type = 'brand' AND status = 'approved' ORDER BY lower(value)"),
    db.query("SELECT value FROM managed_catalog_values WHERE attribute_type = 'fabric' AND status = 'approved' ORDER BY lower(value)"),
    db.query("SELECT value FROM managed_catalog_values WHERE attribute_type = 'color' AND status = 'approved' ORDER BY lower(value)"),
    db.query("SELECT source_term AS source, target_term AS target FROM search_synonyms ORDER BY lower(source_term), lower(target_term)"),
  ]);
  const payload = {
    version: crypto.createHash('sha256').update(JSON.stringify({
      categories: categories.rows,
      brands: brands.rows,
      fabrics: fabrics.rows,
      colors: colors.rows,
      synonyms: synonyms.rows,
    })).digest('hex').slice(0, 24),
    generatedAt: new Date().toISOString(),
    categories: categories.rows,
    brands: brands.rows.map((row) => row.value),
    fabrics: fabrics.rows.map((row) => row.value),
    colors: colors.rows.map((row) => row.value),
    synonyms: synonyms.rows,
  };
  return payload;
}

/** FR-24: filter published listings; cityId follows the seller's registered city. */
async function filterListings({
  mainCategoryId, subCategoryId, condition, minPrice, maxPrice, cityId, colorId, fabricId, brandId,
}) {
  if (cityId !== undefined && cityId !== null && (typeof cityId !== 'string' || !UUID.test(cityId))) {
    throw new ValidationError('cityId must be a valid city UUID');
  }
  for (const [name, value] of Object.entries({ colorId, fabricId, brandId })) {
    if (value !== undefined && value !== null && (typeof value !== 'string' || !UUID.test(value))) {
      throw new ValidationError(`${name} must be a valid catalog UUID`);
    }
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
  for (const [type, value] of [
    ['color', colorId], ['fabric', fabricId], ['brand', brandId],
  ]) {
    if (!value) continue;
    params.push(value);
    clauses.push(
      `l.${type}_id = $${params.length} AND EXISTS (
        SELECT 1 FROM managed_catalog_values attribute
        WHERE attribute.id = l.${type}_id AND attribute.attribute_type = '${type}' AND attribute.status = 'approved'
      )`
    );
  }
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
async function getListingDetail(listingKey) {
  const parsedKey = parseListingUrlKey(listingKey);
  if (!parsedKey) return null;
  const keyColumn = parsedKey.listingId ? 'l.id' : 'l.short_id';
  const keyValue = parsedKey.listingId || parsedKey.shortId;
  const { rows } = await db.read(
    `SELECT ${PUBLIC_LISTING_COLUMNS}, l.seller_id, l.status,
            l.seo_choice, l.seo_title, l.seo_description,
            ${orderExistsSql(2)} AS has_reservation,
            EXISTS (SELECT 1 FROM orders o WHERE o.listing_id = l.id AND o.status = 'completed') AS has_completed_order
       FROM listings l WHERE ${keyColumn} = $1`,
    [keyValue, RESERVED_ORDER_STATUSES]
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
    listings.getListingImages(row.id),
  ]);
  const [subCategory, city] = await Promise.all([
    catalog.getSubCategoryName(row.sub_category_id),
    users.getSellerCityName(sellerId),
  ]);
  const canonicalKey = listingUrlKey(row);
  const detail = {
    ...listing,
    canonicalKey,
    canonicalUrl: canonicalListingUrl(row),
    seo: buildSeoPayload(row, {
      condition: row.condition, subCategory, color: row.color,
      fabricMaterial: row.fabric_material, brand: row.brand, city,
    }),
    ...liveStatusFields(liveStatus),
    seller,
    images,
  };
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
  const parsedKey = parseListingUrlKey(listingId);
  if (!parsedKey) return null;
  const keyColumn = parsedKey.listingId ? 'l.id' : 'l.short_id';
  const keyValue = parsedKey.listingId || parsedKey.shortId;
  const { rows } = await db.read(
    `SELECT l.status,
            ${orderExistsSql(2)} AS has_reservation,
            EXISTS (SELECT 1 FROM orders o WHERE o.listing_id = l.id AND o.status = 'completed') AS has_completed_order
       FROM listings l WHERE ${keyColumn} = $1`,
    [keyValue, RESERVED_ORDER_STATUSES]
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

/** FR-27, FR-82c: public canonical share link for a listing, no login needed. */
async function buildShareUrl(listingId) {
  const listing = await listings.getListingUrlData(listingId);
  return canonicalListingUrl(listing);
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
  buildShareUrl, getSellerPublicCard, getSearchVocabulary,
};
