/**
 * modules/listings.service.js
 *
 * Owns: FR-15 to FR-21a (specs.md section "3. Listings")
 * Tables owned: listings, listing_measurements, listing_images, listing_evidence
 *
 * Cross-module dependencies OUT:
 * - catalog.service.getMeasurementFieldDefs() to validate FR-15a values
 *   against the admin-defined field set for the listing's sub-category.
 * - users.service.isApprovedSeller() / isIdVerified() / isIdVerificationRequired()
 *   to gate listing creation (FR-08) and the high-value ID-verification
 *   requirement (FR-08a, FR-19b).
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

// ---- FR-15, FR-15a, FR-15b: create listing ----

/** FR-15, FR-15a, FR-15b: approved sellers create a draft listing. */
async function createListing(sellerId, data) {
  if (!(await users.isApprovedSeller(sellerId))) {
    throw new ForbiddenError('Only approved sellers can create listings (FR-08)');
  }
  catalog.assertNotRentalListing(data); // FR-14a
  catalog.assertReplicaDisclosureIfNeeded(data); // FR-14

  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO listings
         (seller_id, main_category_id, sub_category_id, condition, asking_price,
          description, fabric_material, brand, color, embellishment_detail, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft') RETURNING *`,
      [
        sellerId, data.mainCategoryId, data.subCategoryId, data.condition, data.askingPrice,
        data.description, data.fabricMaterial, data.brand, data.color, data.embellishmentDetail,
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
  const defNames = new Set(defs.map((d) => d.field_name));
  for (const m of measurements) {
    if (!defNames.has(m.fieldName)) {
      throw new ValidationError(`Unknown measurement field "${m.fieldName}" for this sub-category (FR-15a)`);
    }
    await client.query(
      `INSERT INTO listing_measurements (listing_id, field_name, value) VALUES ($1, $2, $3)`,
      [listingId, m.fieldName, m.value]
    );
  }
}

/** FR-16: multiple images per listing. */
async function addListingImages(listingId, imageUrls) {
  const inserts = imageUrls.map((url, i) =>
    db.query(
      'INSERT INTO listing_images (listing_id, url, sort_order) VALUES ($1, $2, $3)',
      [listingId, url, i]
    )
  );
  await Promise.all(inserts);
}

// ---- FR-17, FR-18, FR-18a: evidence & verified badge ----

/** FR-17: seller optionally submits authenticity evidence (receipts, tags, docs). */
async function submitAuthenticityEvidence(listingId, sellerId, evidenceUrls) {
  const inserts = evidenceUrls.map((url) =>
    db.query(
      'INSERT INTO listing_evidence (listing_id, url, submitted_by) VALUES ($1, $2, $3)',
      [listingId, url, sellerId]
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
    'UPDATE listings SET is_verified = $1 WHERE id = $2 RETURNING *',
    [granted, listingId]
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
 * FR-19a/FR-19b: approving a listing to go live is independent of the
 * Verified badge, but IS gated by ID verification once the listing crosses
 * the high-value threshold (FR-08a).
 */
async function approveListing(listingId, reviewerId) {
  const { rows } = await db.query('SELECT * FROM listings WHERE id = $1', [listingId]);
  const listing = rows[0];
  if (!listing) throw new NotFoundError('listing', listingId);

  const requiresId = await users.isIdVerificationRequired(listing.asking_price); // FR-08a
  if (requiresId && !(await users.isIdVerified(listing.seller_id))) {
    // FR-19b: cannot approve yet — this is the FR-08b manual fork point.
    // Caller (admin route) should present the hold/approve-unpublished/reject
    // choice; this function just refuses to silently approve.
    throw new ForbiddenError(
      'Listing crosses high-value threshold and seller ID is not verified — requires manual FR-08b decision'
    );
  }

  const { rows: updated } = await db.query(
    `UPDATE listings SET status = 'live', approved_by = $1, approved_at = now() WHERE id = $2 RETURNING *`,
    [reviewerId, listingId]
  );
  eventBus.emit(events.LISTING_STATUS_CHANGED, { listingId, status: 'live' });
  return updated[0];
}

/** FR-08b (OPEN process, decided as manual): explicit hold state, no automatic transition out of it. */
async function holdListingPendingIdVerification(listingId, reviewerId, note) {
  const { rows } = await db.query(
    `UPDATE listings SET status = 'held_pending_id' WHERE id = $1 RETURNING *`,
    [listingId]
  );
  if (!rows[0]) throw new NotFoundError('listing', listingId);
  return rows[0];
}

// ---- FR-20, FR-21, FR-21a: seller/admin edits ----

/** FR-20: sellers can edit, pause, or remove their own listings. */
async function updateOwnListing(listingId, sellerId, patch) {
  const { rows } = await db.query('SELECT seller_id FROM listings WHERE id = $1', [listingId]);
  if (!rows[0]) throw new NotFoundError('listing', listingId);
  if (rows[0].seller_id !== sellerId) throw new ForbiddenError('Not your listing');
  // TODO: build the actual SET clause from patch fields once the listing edit UI is scoped.
  return db.query('UPDATE listings SET updated_at = now() WHERE id = $1 RETURNING *', [listingId]);
}

/** FR-21: admin can unpublish/reject a live listing post-publication, with a reason. */
async function rejectOrUnpublishListing(listingId, { reviewerId, reason }) {
  const { rows } = await db.query(
    `UPDATE listings SET status = 'rejected', decision_reason = $1 WHERE id = $2 RETURNING *`,
    [reason, listingId]
  );
  if (!rows[0]) throw new NotFoundError('listing', listingId);
  eventBus.emit(events.LISTING_STATUS_CHANGED, { listingId, status: 'rejected', reason });
  return rows[0];
}

/** FR-21a: rejected listings can be resubmitted after edits, reviewed case-by-case, no cooldown. */
async function resubmitListing(listingId, sellerId) {
  const { rows } = await db.query(
    `UPDATE listings SET status = 'pending_review' WHERE id = $1 AND seller_id = $2 RETURNING *`,
    [listingId, sellerId]
  );
  if (!rows[0]) throw new NotFoundError('listing', listingId);
  return rows[0];
}

module.exports = {
  createListing,
  addListingImages,
  submitAuthenticityEvidence,
  setVerifiedBadge,
  getModerationQueue,
  approveListing,
  holdListingPendingIdVerification,
  updateOwnListing,
  rejectOrUnpublishListing,
  resubmitListing,
};
