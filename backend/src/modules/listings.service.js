/**
 * modules/listings.service.js
 *
 * Owns: FR-15 to FR-21a (specs.md section "3. Listings")
 * Tables owned: listings, listing_measurements, listing_images, listing_evidence
 *
 * Cross-module dependencies OUT:
 * - catalog.service.getMeasurementFieldDefs() to validate FR-15a values
 *   against the admin-defined field set for the listing's sub-category.
 * - users.service.isApprovedSeller() / isIdVerificationRequired()
 *   to gate seller listing actions (FR-08) and high-value publication until
 *   temporary email verification is implemented (FR-08a, FR-19b).
 * - catalog.service.assertReplicaDisclosureIfNeeded() / assertNotRentalListing()
 *   for FR-14/FR-14a validation at creation time.
 *
 * FR-18a (OPEN, Verified-badge criteria): no automatic scoring exists or is
 * planned yet — `is_verified` is a plain boolean a moderator sets by hand
 * after reviewing evidence. That's the deliberate interim behavior per
 * schema.sql, not a gap needing a thrown error.
 */

const db = require('../db.service');
const catalog = require('./catalog.service');
const users = require('./users.service');
const eventBus = require('../lib/eventBus');
const events = require('../lib/events');
const { NotFoundError, ValidationError, ForbiddenError } = require('../lib/errors');

const MIN_LISTING_IMAGES = 3;
const MAX_LISTING_IMAGES = 6;
const EDITABLE_LISTING_FIELDS = new Map([
  ['title', 'title'],
  ['mainCategoryId', 'main_category_id'],
  ['subCategoryId', 'sub_category_id'],
  ['condition', 'condition'],
  ['replicaDisclosure', 'replica_disclosure'],
  ['askingPrice', 'asking_price'],
  ['description', 'description'],
  ['fabricMaterial', 'fabric_material'],
  ['brand', 'brand'],
  ['color', 'color'],
  ['embellishmentDetail', 'embellishment_detail'],
]);

/** FR-16, FR-74: require three through six listing images before submission or publication. */
function assertValidListingImageCount(count) {
  if (count < MIN_LISTING_IMAGES || count > MAX_LISTING_IMAGES) {
    throw new ValidationError(`A listing needs ${MIN_LISTING_IMAGES} to ${MAX_LISTING_IMAGES} photos before review`);
  }
}

/** FR-19: move a seller-owned draft or rejected listing into the review queue. */
async function transitionListingToReview(listingId, sellerId, expectedStatus) {
  await assertApprovedSeller(sellerId);
  return db.withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM listings WHERE id = $1 FOR UPDATE', [listingId]);
    const listing = rows[0];
    if (!listing) throw new NotFoundError('listing', listingId);
    if (listing.seller_id !== sellerId) throw new ForbiddenError('Not your listing');
    if (listing.status !== expectedStatus) {
      throw new ValidationError(`Only ${expectedStatus} listings may use this review transition`);
    }

    const { rows: imageRows } = await client.query(
      'SELECT count(*)::int AS count FROM listing_images WHERE listing_id = $1', [listingId]
    );
    assertValidListingImageCount(imageRows[0].count);
    const requiresId = await users.isIdVerificationRequired(listing.asking_price);
    const { rows: updated } = await client.query(
      `UPDATE listings
       SET status = 'pending_review', requires_id_verification = $1, updated_at = now()
       WHERE id = $2 RETURNING *`,
      [requiresId, listingId]
    );
    await eventBus.emitAsync(events.LISTING_STATUS_CHANGED, { listingId, status: 'pending_review' }, { transaction: client });
    return updated[0];
  });
}

/** FR-08: seller listing operations require a currently approved, active seller. */
async function assertApprovedSeller(sellerId) {
  if (!(await users.isApprovedSeller(sellerId))) {
    throw new ForbiddenError('Only active approved sellers can manage listings (FR-08)');
  }
}

// ---- FR-15, FR-15a, FR-15b: create listing ----

/** FR-15, FR-15a, FR-15b: approved sellers create a draft listing. */
async function createListing(sellerId, data) {
  await assertApprovedSeller(sellerId);
  catalog.assertNotRentalListing(data); // FR-14a
  catalog.assertReplicaDisclosureIfNeeded(data); // FR-14

  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO listings
         (seller_id, main_category_id, sub_category_id, condition, title, replica_disclosure,
          asking_price, description, fabric_material, brand, color, embellishment_detail, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft') RETURNING *`,
      [
        sellerId, data.mainCategoryId, data.subCategoryId, data.condition, data.title,
        data.replicaDisclosure, data.askingPrice, data.description, data.fabricMaterial,
        data.brand, data.color, data.embellishmentDetail,
      ]
    );
    const listing = rows[0];

    if (data.measurements?.length) {
      await saveListingMeasurements(client, listing.id, data.subCategoryId, data.measurements); // FR-15a
    }
    return listing;
  });
}

/** FR-15a: validates values against catalog.service's admin-defined field set before storing. */
async function saveListingMeasurements(client, listingId, subCategoryId, measurements) {
  const defs = await catalog.getMeasurementFieldDefs(subCategoryId);
  const defsByName = new Map(defs.map((def) => [def.field_name, def]));
  for (const m of measurements) {
    const definition = defsByName.get(m.fieldName);
    if (!definition) {
      throw new ValidationError(`Unknown measurement field "${m.fieldName}" for this sub-category (FR-15a)`);
    }
    await client.query(
      `INSERT INTO listing_measurements (listing_id, field_def_id, value) VALUES ($1, $2, $3)`,
      [listingId, definition.id, m.value]
    );
  }
}

/** FR-16, FR-20: the listing owner may add photos while a draft or rejected listing is editable. */
async function addListingImages(listingId, sellerId, imageUrls) {
  await assertApprovedSeller(sellerId);
  if (!Array.isArray(imageUrls)) throw new ValidationError('imageUrls must be an array');
  if (imageUrls.length === 0) return;

  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT seller_id, status FROM listings WHERE id = $1 FOR UPDATE', [listingId]
    );
    if (!rows[0]) throw new NotFoundError('listing', listingId);
    if (rows[0].seller_id !== sellerId) throw new ForbiddenError('Not your listing');
    if (!['draft', 'rejected'].includes(rows[0].status)) {
      throw new ValidationError('Photos can only be added to draft or rejected listings');
    }

    const { rows: countRows } = await client.query(
      'SELECT count(*)::int AS count FROM listing_images WHERE listing_id = $1', [listingId]
    );
    const existingCount = countRows[0].count;
    if (existingCount + imageUrls.length > MAX_LISTING_IMAGES) {
      throw new ValidationError(`A listing cannot have more than ${MAX_LISTING_IMAGES} photos`);
    }
    for (const [index, url] of imageUrls.entries()) {
      await client.query(
        'INSERT INTO listing_images (listing_id, image_url, display_order) VALUES ($1, $2, $3)',
        [listingId, url, existingCount + index]
      );
    }
  });
}

/** FR-25: expose a listing's ordered photo rows to public detail reads. */
async function getListingImages(listingId) {
  const { rows } = await db.read(
    'SELECT id, image_url, display_order FROM listing_images WHERE listing_id = $1 ORDER BY display_order, id',
    [listingId]
  );
  return rows;
}

/** FR-19: sellers explicitly submit a draft after completing its required photos. */
async function submitListingForReview(listingId, sellerId) {
  return transitionListingToReview(listingId, sellerId, 'draft');
}

// ---- FR-17, FR-18, FR-18a: evidence & verified badge ----

/** FR-17: seller optionally submits authenticity evidence (receipts, tags, docs). */
async function submitAuthenticityEvidence(listingId, sellerId, evidenceUrls) {
  await assertApprovedSeller(sellerId);
  const { rows } = await db.query('SELECT seller_id FROM listings WHERE id = $1', [listingId]);
  if (!rows[0]) throw new NotFoundError('listing', listingId);
  if (rows[0].seller_id !== sellerId) throw new ForbiddenError('Not your listing');

  const inserts = evidenceUrls.map((url) =>
    db.query(
      'INSERT INTO listing_evidence (listing_id, evidence_url, evidence_type) VALUES ($1, $2, $3)',
      [listingId, url, null]
    )
  );
  await Promise.all(inserts);
}

/**
 * FR-18 / FR-18a: admin/moderator reviews evidence and manually grants (or
 * doesn't grant) the Verified badge. No automated criteria — see file header.
 */
async function setVerifiedBadge(listingId, { granted, reviewerId }) {
  const { rows } = await db.query(
    `UPDATE listings
     SET is_verified = $1,
         verified_by = CASE WHEN $1 THEN $2::uuid ELSE NULL END,
         verified_at = CASE WHEN $1 THEN now() ELSE NULL END
     WHERE id = $3 RETURNING *`,
    [granted, reviewerId, listingId]
  );
  if (!rows[0]) throw new NotFoundError('listing', listingId);
  return rows[0];
}

// ---- FR-19, FR-19a, FR-19b: moderation queue & go-live ----

/** FR-19: ONE unified moderation queue; high-value / evidence-submitted listings are flagged inline, not split out. */
async function getModerationQueue() {
  const { rows } = await db.query(
    `SELECT l.*,
            (l.asking_price >= (SELECT value::numeric FROM platform_settings WHERE key = 'high_value_threshold_pkr')) AS is_high_value,
            EXISTS(SELECT 1 FROM listing_evidence e WHERE e.listing_id = l.id) AS has_evidence_submitted
     FROM listings l
     WHERE l.status = 'pending_review'
     ORDER BY l.created_at ASC`
  );
  return rows;
}

/**
 * FR-19a/FR-19b: approval is separate from the Verified badge. High-value
 * listings remain pending until the required email-verification flow exists.
 */
async function approveListing(listingId, reviewerId) {
  const updated = await db.withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM listings WHERE id = $1 FOR UPDATE', [listingId]);
    const listing = rows[0];
    if (!listing) throw new NotFoundError('listing', listingId);
    if (listing.status !== 'pending_review') {
      throw new ValidationError('Only listings pending review can be published');
    }

    const { rows: imageRows } = await client.query(
      'SELECT count(*)::int AS count FROM listing_images WHERE listing_id = $1', [listingId]
    );
    assertValidListingImageCount(imageRows[0].count);

    const requiresEmailVerification = await users.isIdVerificationRequired(listing.asking_price); // FR-08a
    if (requiresEmailVerification) {
      // FR-08a/FR-08b: email verification is scheduled before Phase 2; no verification mechanism exists yet.
      throw new ForbiddenError(
        'Listing crosses the high-value threshold and cannot be published until the seller email is verified (FR-08a)'
      );
    }

    const { rows: published } = await client.query(
      `UPDATE listings SET status = 'published', reviewed_by = $1, published_at = now(), updated_at = now()
       WHERE id = $2 AND status = 'pending_review' RETURNING *`,
      [reviewerId, listingId]
    );
    await eventBus.emitAsync(events.LISTING_STATUS_CHANGED, { listingId, status: 'published' }, { transaction: client });
    return published[0];
  });
  return updated;
}

// ---- FR-20, FR-21, FR-21a: seller/admin edits ----

/** FR-20: sellers may edit supported content fields on drafts and rejected listings they own. */
async function updateOwnListing(listingId, sellerId, patch) {
  await assertApprovedSeller(sellerId);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ValidationError('Listing patch must be an object');
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) throw new ValidationError('Listing patch must include at least one supported field');
  const unsupported = keys.filter((key) => !EDITABLE_LISTING_FIELDS.has(key));
  if (unsupported.length) throw new ValidationError(`Unsupported listing field: ${unsupported[0]}`);
  const requiredFields = ['title', 'mainCategoryId', 'subCategoryId', 'condition', 'askingPrice'];
  const missingRequired = keys.find((key) => requiredFields.includes(key) && patch[key] == null);
  if (missingRequired) throw new ValidationError(`${missingRequired} cannot be null`);

  return db.withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM listings WHERE id = $1 FOR UPDATE', [listingId]);
    const listing = rows[0];
    if (!listing) throw new NotFoundError('listing', listingId);
    if (listing.seller_id !== sellerId) throw new ForbiddenError('Not your listing');
    if (listing.status === 'published') {
      throw new ValidationError(
        'Published listing edits require pending-version storage (FR-73); this schema has no safe place to keep them'
      );
    }
    if (!['draft', 'rejected'].includes(listing.status)) {
      throw new ValidationError('Only draft or rejected listings can be edited');
    }

    const merged = {
      condition: patch.condition ?? listing.condition,
      replicaDisclosure: Object.prototype.hasOwnProperty.call(patch, 'replicaDisclosure')
        ? patch.replicaDisclosure
        : listing.replica_disclosure,
    };
    if (!catalog.listConditionTypes().includes(merged.condition)) {
      throw new ValidationError('Unsupported listing condition');
    }
    catalog.assertReplicaDisclosureIfNeeded(merged);

    const nextMainCategoryId = patch.mainCategoryId ?? listing.main_category_id;
    const nextSubCategoryId = patch.subCategoryId ?? listing.sub_category_id;
    if (keys.includes('mainCategoryId') || keys.includes('subCategoryId')) {
      const subCategories = await catalog.listSubCategories(nextMainCategoryId);
      if (!subCategories.some((subCategory) => subCategory.id === nextSubCategoryId)) {
        throw new ValidationError('Sub-category must belong to the selected main category');
      }
      if (nextSubCategoryId !== listing.sub_category_id) {
        const { rows: measurements } = await client.query(
          'SELECT 1 FROM listing_measurements WHERE listing_id = $1 LIMIT 1', [listingId]
        );
        if (measurements.length) {
          throw new ValidationError('Cannot change sub-category while listing measurements use its field definitions');
        }
      }
    }

    const assignments = [];
    const values = [];
    for (const key of keys) {
      const column = EDITABLE_LISTING_FIELDS.get(key);
      values.push(patch[key]);
      assignments.push(`${column} = $${values.length}`);
    }
    assignments.push('updated_at = now()');
    values.push(listingId);
    const { rows: updated } = await client.query(
      `UPDATE listings SET ${assignments.join(', ')} WHERE id = $${values.length} RETURNING *`, values
    );
    return updated[0];
  });
}

/** FR-21: admin can unpublish/reject a live listing post-publication, with a reason. */
async function rejectOrUnpublishListing(listingId, { reviewerId, reason }) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE listings
       SET status = CASE WHEN status = 'published' THEN 'unpublished'::listing_status ELSE 'rejected'::listing_status END,
           rejection_reason = $1, updated_at = now()
       WHERE id = $2 AND status IN ('pending_review', 'published')
       RETURNING *`,
      [reason, listingId]
    );
    if (!rows[0]) {
      const { rows: existing } = await client.query('SELECT id FROM listings WHERE id = $1', [listingId]);
      if (!existing[0]) throw new NotFoundError('listing', listingId);
      throw new ValidationError('Only listings pending review or published can be rejected or unpublished');
    }
    await eventBus.emitAsync(events.LISTING_STATUS_CHANGED, { listingId, status: rows[0].status, reason }, { transaction: client });
    return rows[0];
  });
}

/** FR-21a: rejected listings can be resubmitted after edits, reviewed case-by-case, no cooldown. */
async function resubmitListing(listingId, sellerId) {
  return transitionListingToReview(listingId, sellerId, 'rejected');
}

module.exports = {
  createListing,
  addListingImages,
  getListingImages,
  submitListingForReview,
  submitAuthenticityEvidence,
  setVerifiedBadge,
  getModerationQueue,
  approveListing,
  updateOwnListing,
  rejectOrUnpublishListing,
  resubmitListing,
};
