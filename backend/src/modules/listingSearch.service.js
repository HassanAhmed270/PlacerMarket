const crypto = require('crypto');
const db = require('../db.service');
const queue = require('../lib/queue');
const { NotFoundError, ValidationError } = require('../lib/errors');

const SEARCH_QUEUE = queue.QUEUES.LISTING_SEARCH;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEARCH_COLUMNS = [
  'listing_id', 'search_version', 'title', 'description', 'main_category_id', 'main_category',
  'sub_category_id', 'sub_category', 'condition', 'asking_price', 'seller_city_id', 'seller_city',
  'color_id', 'color', 'fabric_id', 'fabric', 'brand_id', 'brand', 'embellishment_detail',
  'published_at', 'is_reserved', 'search_text',
];
const SEARCH_UPDATE_COLUMNS = SEARCH_COLUMNS.filter((column) => column !== 'listing_id');
const SEARCH_UPSERT_CLAUSE = `
  ON CONFLICT (listing_id) DO UPDATE SET
    ${SEARCH_UPDATE_COLUMNS.map((column) => `${column} = EXCLUDED.${column}`).join(',\n    ')}
  WHERE listing_search.search_version <= EXCLUDED.search_version`;

const LISTING_SEARCH_SELECT = `
  SELECT l.id AS listing_id, l.search_version, l.title, l.description,
         l.main_category_id, main.name AS main_category,
         l.sub_category_id, sub.name AS sub_category, l.condition::text AS condition,
         l.asking_price, seller.city_id AS seller_city_id, city.name AS seller_city,
         l.color_id, l.color, l.fabric_id, l.fabric_material AS fabric,
         l.brand_id, l.brand, l.embellishment_detail,
         COALESCE(l.published_at, l.created_at) AS published_at,
         EXISTS (
           SELECT 1 FROM orders reserved_order
           WHERE reserved_order.listing_id = l.id
             AND reserved_order.status IN ('order_placed', 'seller_preparing')
         ) AS is_reserved,
         concat_ws(' ', l.title, l.description, main.name, sub.name, l.condition::text,
                   l.color, l.fabric_material, l.brand, l.embellishment_detail, city.name,
                   measurements.search_terms) AS search_text,
         l.status::text AS listing_status
  FROM listings l
  JOIN main_categories main ON main.id = l.main_category_id
  JOIN sub_categories sub ON sub.id = l.sub_category_id
  JOIN users seller ON seller.id = l.seller_id
  LEFT JOIN cities city ON city.id = seller.city_id
  LEFT JOIN LATERAL (
    SELECT string_agg(concat_ws(' ', definition.field_name, measurement.value::text), ' ') AS search_terms
    FROM listing_measurements measurement
    JOIN measurement_field_defs definition ON definition.id = measurement.field_def_id
    WHERE measurement.listing_id = l.id
  ) measurements ON TRUE`;

function versionValue(version) {
  const value = String(version);
  if (!/^[1-9]\d*$/.test(value)) throw new ValidationError('A valid listing search version is required');
  return value;
}

/** FR-80a: atomically enqueue one versioned index update with its listing change. */
async function enqueueListingSearchSync(client, listingId, searchVersion, { reasonKey } = {}) {
  const version = versionValue(searchVersion);
  return queue.enqueue(SEARCH_QUEUE, { listingId, searchVersion: version }, {
    idempotencyKey: `${listingId}:${version}${reasonKey ? `:${reasonKey}` : ''}`,
    orderingKey: listingId,
    transaction: client,
  });
}

function validateJob(data) {
  if (!data || typeof data.listingId !== 'string' || !data.listingId ||
      typeof data.searchVersion !== 'string' && typeof data.searchVersion !== 'number') {
    throw new TypeError('Listing-search jobs require a listing id and search version.');
  }
  return versionValue(data.searchVersion);
}

/** FR-80a: apply only the current published listing version or remove its stale index row. */
async function processListingSearchJob(data) {
  const requestedVersion = validateJob(data);
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `${LISTING_SEARCH_SELECT} WHERE l.id = $1 FOR SHARE OF l`,
      [data.listingId]
    );
    const listing = rows[0];
    if (!listing) {
      await client.query('DELETE FROM listing_search WHERE listing_id = $1', [data.listingId]);
      return { outcome: 'deleted', listingId: data.listingId };
    }
    if (String(listing.search_version) !== requestedVersion) {
      return { outcome: 'stale', listingId: data.listingId, searchVersion: String(listing.search_version) };
    }
    if (listing.listing_status !== 'published') {
      await client.query(
        'DELETE FROM listing_search WHERE listing_id = $1 AND search_version <= $2',
        [data.listingId, requestedVersion]
      );
      return { outcome: 'removed', listingId: data.listingId, searchVersion: requestedVersion };
    }
    await upsertListingSearchRow(client, listing);
    return { outcome: 'indexed', listingId: data.listingId, searchVersion: requestedVersion };
  });
}

async function upsertListingSearchRow(client, row) {
  const values = SEARCH_COLUMNS.map((column) => row[column]);
  const placeholders = values.map((_, index) => `$${index + 1}`);
  await client.query(
    `INSERT INTO listing_search (${SEARCH_COLUMNS.join(', ')})
     VALUES (${placeholders.join(', ')})
     ${SEARCH_UPSERT_CLAUSE}`,
    values
  );
}

/** FR-80a: rebuild the listing index from a stable published-listing snapshot. */
async function rebuildListingSearch() {
  return db.withTransaction(async (client) => {
    await client.query('LOCK TABLE listings IN SHARE MODE');
    await client.query('DELETE FROM listing_search');
    const { rowCount } = await client.query(
      `INSERT INTO listing_search (${SEARCH_COLUMNS.join(', ')})
       SELECT ${SEARCH_COLUMNS.join(', ')}
       FROM (${LISTING_SEARCH_SELECT}) searchable
       WHERE listing_status = 'published'
       ${SEARCH_UPSERT_CLAUSE}`
    );
    return { indexed: rowCount };
  });
}

/** FR-80a: enqueue missing, stale, and no-longer-published listing index rows. */
async function reconcileListingSearch() {
  return db.withTransaction(async (client) => {
    const reasonKey = `reconcile:${crypto.randomUUID()}`;
    const { rows } = await client.query(
      `SELECT listing.id, listing.search_version
       FROM listings listing
       LEFT JOIN listing_search search ON search.listing_id = listing.id
       WHERE (listing.status = 'published'
              AND (search.listing_id IS NULL OR search.search_version <> listing.search_version))
          OR (listing.status <> 'published'
              AND search.listing_id IS NOT NULL
              AND search.search_version <= listing.search_version)
       ORDER BY listing.id`
    );
    for (const listing of rows) {
      await enqueueListingSearchSync(client, listing.id, listing.search_version, { reasonKey });
    }
    return { enqueued: rows.length };
  });
}

function validateSynonymTerm(term, field) {
  if (typeof term !== 'string' || !term.trim() || term.trim().length > 100) {
    throw new ValidationError(`${field} must be a non-empty string of at most 100 characters`);
  }
  return term.trim();
}

function validateSynonymId(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new ValidationError('A valid synonym id is required');
  return id;
}

/** FR-80a: list admin-managed Roman Urdu and spelling synonym pairs. */
async function listSearchSynonyms() {
  const { rows } = await db.query(
    `SELECT id, source_term AS "sourceTerm", target_term AS "targetTerm",
            created_by AS "createdBy", updated_by AS "updatedBy",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM search_synonyms ORDER BY normalized_source_term, normalized_target_term, id`
  );
  return rows;
}

/** FR-80a: create or idempotently retain an admin-managed synonym pair. */
async function createSearchSynonym({ sourceTerm, targetTerm }, adminId) {
  const source = validateSynonymTerm(sourceTerm, 'sourceTerm');
  const target = validateSynonymTerm(targetTerm, 'targetTerm');
  const { rows } = await db.query(
    `INSERT INTO search_synonyms (source_term, target_term, created_by, updated_by)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (normalized_source_term, normalized_target_term) DO UPDATE
       SET updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING id, source_term AS "sourceTerm", target_term AS "targetTerm",
               created_by AS "createdBy", updated_by AS "updatedBy",
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [source, target, adminId]
  );
  return rows[0];
}

/** FR-80a: update an admin-managed synonym pair. */
async function updateSearchSynonym(id, { sourceTerm, targetTerm }, adminId) {
  validateSynonymId(id);
  const source = validateSynonymTerm(sourceTerm, 'sourceTerm');
  const target = validateSynonymTerm(targetTerm, 'targetTerm');
  let rows;
  try {
    ({ rows } = await db.query(
      `UPDATE search_synonyms SET source_term = $1, target_term = $2, updated_by = $3, updated_at = now()
       WHERE id = $4
       RETURNING id, source_term AS "sourceTerm", target_term AS "targetTerm",
                 created_by AS "createdBy", updated_by AS "updatedBy",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [source, target, adminId, id]
    ));
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'search_synonyms_pair_unique') {
      throw new ValidationError('That synonym pair already exists');
    }
    throw error;
  }
  if (!rows[0]) throw new NotFoundError('search synonym', id);
  return rows[0];
}

/** FR-80a: remove an admin-managed synonym pair. */
async function deleteSearchSynonym(id) {
  validateSynonymId(id);
  const { rows } = await db.query('DELETE FROM search_synonyms WHERE id = $1 RETURNING id', [id]);
  if (!rows[0]) throw new NotFoundError('search synonym', id);
  return { deleted: true };
}

module.exports = {
  enqueueListingSearchSync,
  processListingSearchJob,
  rebuildListingSearch,
  reconcileListingSearch,
  listSearchSynonyms,
  createSearchSynonym,
  updateSearchSynonym,
  deleteSearchSynonym,
};
