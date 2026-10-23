/** FR-73: immutable moderated edits for previously published listing content. */
const db = require('../db.service');
const catalog = require('./catalog.service');
const users = require('./users.service');
const eventBus = require('../lib/eventBus');
const events = require('../lib/events');
const { ValidationError, ForbiddenError, NotFoundError } = require('../lib/errors');

const FIELDS = Object.freeze({
  title: 'proposed_title', condition: 'proposed_condition', replicaDisclosure: 'proposed_replica_disclosure',
  description: 'proposed_description', askingPrice: 'proposed_asking_price',
  fabricMaterial: 'proposed_fabric_material', brand: 'proposed_brand', color: 'proposed_color',
  embellishmentDetail: 'proposed_embellishment_detail',
});
const ALLOWED = new Set(Object.keys(FIELDS).concat('measurements'));

function assertEnabled(env = process.env) {
  if (env.NODE_ENV === 'production' && env.LISTING_REVISIONS_ENABLED !== '1') {
    throw new ValidationError('Listing revisions are disabled by the production feature flag');
  }
  if (env.LISTING_REVISIONS_ENABLED === '0') throw new ValidationError('Listing revisions are disabled by the feature flag');
}

function conflict(message) {
  const error = new ValidationError(message);
  error.statusCode = 409;
  return error;
}

function validateMeasurements(definitions, submitted) {
  if (!Array.isArray(submitted)) throw new ValidationError('Revision measurements must be an array');
  const byId = new Map(definitions.map((item) => [item.id, item]));
  const seen = new Set();
  const resolved = [];
  for (const row of submitted) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.fieldDefId !== 'string' || seen.has(row.fieldDefId)) {
      throw new ValidationError('Each revision measurement needs a unique fieldDefId');
    }
    const def = byId.get(row.fieldDefId);
    if (!def) throw conflict('A measurement definition changed; correct the measurements and submit a new revision');
    if (!def.is_active) throw conflict(`Measurement field "${def.field_name}" is inactive; correct the measurements and submit a new revision`);
    const value = Number(row.value);
    if (!Number.isFinite(value) || value < 0 || value > 9999.99) throw new ValidationError('Measurement values must be between 0 and 9999.99');
    seen.add(row.fieldDefId);
    resolved.push({ fieldDefId: row.fieldDefId, value });
  }
  const missing = definitions.find((item) => item.is_active && item.required && !seen.has(item.id));
  if (missing) throw new ValidationError(`Required measurement field "${missing.field_name}" is missing`);
  return resolved;
}

function proposedFromListing(listing) {
  return {
    title: listing.title,
    condition: listing.condition,
    replicaDisclosure: listing.replica_disclosure,
    description: listing.description,
    askingPrice: listing.asking_price,
    fabricMaterial: listing.fabric_material,
    brand: listing.brand,
    color: listing.color,
    embellishmentDetail: listing.embellishment_detail,
  };
}

function validateProposedFields(proposed) {
  const limits = { fabricMaterial: 100, brand: 100, color: 50 };
  for (const [key, max] of Object.entries(limits)) {
    if (proposed[key] !== null && proposed[key] !== undefined && (typeof proposed[key] !== 'string' || proposed[key].length > max)) {
      throw new ValidationError(`${key} must be text up to ${max} characters`);
    }
  }
  for (const key of ['replicaDisclosure', 'description', 'embellishmentDetail']) {
    if (proposed[key] !== null && proposed[key] !== undefined && typeof proposed[key] !== 'string') {
      throw new ValidationError(`${key} must be text`);
    }
  }
  if ((proposed.description?.length || 0) > 10000 || (proposed.replicaDisclosure?.length || 0) > 2000 ||
      (proposed.embellishmentDetail?.length || 0) > 5000) {
    throw new ValidationError('Revision text exceeds its supported length');
  }
}

/** FR-73: capture an immutable seller change against the current public content version. */
async function submitListingRevision(listingId, sellerId, patch) {
  assertEnabled();
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ValidationError('Revision details are required');
  const unsupported = Object.keys(patch).find((key) => !ALLOWED.has(key));
  if (unsupported) throw new ValidationError(`Unsupported revision field: ${unsupported}`);
  await db.query('SELECT id FROM users WHERE id = $1 AND role = \'seller\' AND is_suspended = false', [sellerId]).then(({ rows }) => {
    if (!rows[0]) throw new ForbiddenError('An active seller account is required');
  });

  try {
    return await db.withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM listings WHERE id = $1 FOR UPDATE', [listingId]);
      const listing = rows[0];
      if (!listing) throw new NotFoundError('listing', listingId);
      if (listing.seller_id !== sellerId) throw new ForbiddenError('Not your listing');
      if (!listing.published_at || !['published', 'paused'].includes(listing.status)) {
        throw new ValidationError('Only previously published, available or paused listings can be revised');
      }
      const { rows: profile } = await client.query('SELECT is_approved FROM seller_profiles WHERE user_id = $1', [sellerId]);
      if (!profile[0]?.is_approved) throw new ForbiddenError('Only active approved sellers can submit revisions');
      const { rows: open } = await client.query(
        "SELECT id FROM listing_revisions WHERE listing_id = $1 AND status = 'pending_review' FOR UPDATE", [listingId]
      );
      if (open.length) throw conflict('A revision is already awaiting moderation');

      const proposed = proposedFromListing(listing);
      for (const key of Object.keys(FIELDS)) if (Object.hasOwn(patch, key)) proposed[key] = patch[key];
      if (typeof proposed.title !== 'string' || !proposed.title.trim() || proposed.title.trim().length > 150) {
        throw new ValidationError('Revision title is required and must be at most 150 characters');
      }
      proposed.title = proposed.title.trim();
      const price = Number(proposed.askingPrice);
      if (!Number.isFinite(price) || price <= 0 || price > 9999999999.99) throw new ValidationError('Revision price must be a positive valid amount');
      proposed.askingPrice = price;
      if (!catalog.listConditionTypes().includes(proposed.condition)) throw new ValidationError('Revision condition is invalid');
      validateProposedFields(proposed);
      catalog.assertReplicaDisclosureIfNeeded({ condition: proposed.condition, replicaDisclosure: proposed.replicaDisclosure });

      const definitions = await catalog.getMeasurementFieldDefs(listing.sub_category_id, { includeInactive: true });
      const current = await client.query('SELECT field_def_id, value FROM listing_measurements WHERE listing_id = $1', [listingId]);
      const measurements = Object.hasOwn(patch, 'measurements')
        ? validateMeasurements(definitions, patch.measurements)
        : validateMeasurements(definitions.filter((def) => def.is_active), current.rows
          .filter((row) => definitions.some((def) => def.id === row.field_def_id && def.is_active))
          .map((row) => ({ fieldDefId: row.field_def_id, value: row.value })));
      const changed = Object.keys(FIELDS).some((key) => String(proposed[key] ?? '') !== String(proposedFromListing(listing)[key] ?? '')) || Object.hasOwn(patch, 'measurements');
      if (!changed) throw new ValidationError('Revision must change at least one listing field');

      const columns = Object.values(FIELDS);
      const values = Object.keys(FIELDS).map((key) => proposed[key]);
      const { rows: inserted } = await client.query(
        `INSERT INTO listing_revisions (listing_id, seller_id, base_content_version, ${columns.join(', ')})
         VALUES ($1, $2, $3, ${values.map((_, i) => `$${i + 4}`).join(', ')})
         RETURNING *`, [listingId, sellerId, listing.content_version, ...values]
      );
      const revision = inserted[0];
      for (const item of measurements) {
        await client.query(
          'INSERT INTO listing_revision_measurements (revision_id, field_def_id, value) VALUES ($1, $2, $3)',
          [revision.id, item.fieldDefId, item.value]
        );
      }
      return { ...revision, measurements };
    });
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'listing_revisions_one_pending_per_listing') {
      throw conflict('A revision is already awaiting moderation');
    }
    throw error;
  }
}

/** FR-73: return revision history only to the owning seller. */
async function getSellerRevisionHistory(listingId, sellerId) {
  assertEnabled();
  const { rows: owner } = await db.query('SELECT seller_id FROM listings WHERE id = $1', [listingId]);
  if (!owner[0]) throw new NotFoundError('listing', listingId);
  if (owner[0].seller_id !== sellerId) throw new ForbiddenError('Not your listing');
  const { rows } = await db.query(
    `SELECT r.*, coalesce((SELECT jsonb_agg(jsonb_build_object('fieldDefId', m.field_def_id, 'value', m.value)
      ORDER BY m.field_def_id) FROM listing_revision_measurements m WHERE m.revision_id = r.id), '[]'::jsonb) AS measurements
     FROM listing_revisions r WHERE r.listing_id = $1 ORDER BY r.submitted_at DESC, r.id DESC LIMIT 100`, [listingId]
  );
  return rows;
}

/** FR-73: let a seller withdraw only their pending revision without changing the live listing. */
async function withdrawListingRevision(revisionId, sellerId) {
  assertEnabled();
  return db.withTransaction(async (client) => {
    const { rows: ref } = await client.query('SELECT listing_id FROM listing_revisions WHERE id = $1', [revisionId]);
    if (!ref[0]) throw new NotFoundError('listing revision', revisionId);
    const { rows: listing } = await client.query('SELECT id FROM listings WHERE id = $1 FOR UPDATE', [ref[0].listing_id]);
    const { rows: revision } = await client.query('SELECT * FROM listing_revisions WHERE id = $1 FOR UPDATE', [revisionId]);
    if (revision[0].seller_id !== sellerId) throw new ForbiddenError('Not your revision');
    if (revision[0].status !== 'pending_review') throw conflict('Only a pending revision can be withdrawn');
    const { rows: updated } = await client.query(
      "UPDATE listing_revisions SET status = 'withdrawn' WHERE id = $1 RETURNING *", [revisionId]
    );
    return updated[0];
  });
}

/** FR-73: moderator queue contains pending revision details only for authorized staff routes. */
async function getListingRevisionQueue() {
  assertEnabled();
  const { rows } = await db.query(
    `SELECT r.*, l.title AS current_title, l.content_version AS current_content_version
     FROM listing_revisions r JOIN listings l ON l.id = r.listing_id
     WHERE r.status = 'pending_review' ORDER BY r.submitted_at, r.id LIMIT 100`
  );
  return rows;
}

/** FR-73: authorized staff detail lookup for a single revision and its measurements. */
async function getListingRevision(revisionId) {
  assertEnabled();
  const { rows } = await db.query('SELECT * FROM listing_revisions WHERE id = $1', [revisionId]);
  if (!rows[0]) throw new NotFoundError('listing revision', revisionId);
  const measurements = await db.query(
    'SELECT field_def_id, value FROM listing_revision_measurements WHERE revision_id = $1 ORDER BY field_def_id', [revisionId]
  );
  return { ...rows[0], measurements: measurements.rows };
}

/** FR-73, FR-73e: approve a revision atomically using listing-then-revision lock order. */
async function approveListingRevision(revisionId, reviewerId) {
  assertEnabled();
  return db.withTransaction(async (client) => {
    const { rows: ref } = await client.query('SELECT listing_id FROM listing_revisions WHERE id = $1', [revisionId]);
    if (!ref[0]) throw new NotFoundError('listing revision', revisionId);
    const { rows: listings } = await client.query('SELECT * FROM listings WHERE id = $1 FOR UPDATE', [ref[0].listing_id]);
    const listing = listings[0];
    const { rows: revisions } = await client.query('SELECT * FROM listing_revisions WHERE id = $1 FOR UPDATE', [revisionId]);
    const revision = revisions[0];
    if (revision.status !== 'pending_review') throw conflict('This revision has already been decided');
    if (Number(revision.base_content_version) !== Number(listing.content_version)) throw conflict('The listing changed after this revision was submitted; ask the seller to correct and resubmit');
    if (!listing.published_at || !['published', 'paused'].includes(listing.status)) throw conflict('This listing is no longer eligible for revision approval');
    const definitions = await catalog.getMeasurementFieldDefs(listing.sub_category_id, { includeInactive: true });
    const saved = await client.query('SELECT field_def_id, value FROM listing_revision_measurements WHERE revision_id = $1', [revisionId]);
    const measurements = validateMeasurements(definitions, saved.rows.map((item) => ({ fieldDefId: item.field_def_id, value: item.value })));
    const requiresEmail = await users.isIdVerificationRequired(revision.proposed_asking_price);
    if (requiresEmail && !(await users.isEmailVerified(revision.seller_id))) {
      throw new ForbiddenError('Listing crosses the high-value threshold and cannot be published until the seller email is verified');
    }
    await client.query(
      `UPDATE listings SET condition = $1, replica_disclosure = $2, title = $3, description = $4,
       asking_price = $5, fabric_material = $6, brand = $7, color = $8, embellishment_detail = $9,
       requires_id_verification = $10, content_version = content_version + 1, updated_at = now() WHERE id = $11`,
      [revision.proposed_condition, revision.proposed_replica_disclosure, revision.proposed_title,
        revision.proposed_description, revision.proposed_asking_price, revision.proposed_fabric_material,
        revision.proposed_brand, revision.proposed_color, revision.proposed_embellishment_detail,
        requiresEmail, listing.id]
    );
    await client.query('DELETE FROM listing_measurements WHERE listing_id = $1', [listing.id]);
    for (const item of measurements) {
      await client.query('INSERT INTO listing_measurements (listing_id, field_def_id, value) VALUES ($1, $2, $3)',
        [listing.id, item.fieldDefId, item.value]);
    }
    const { rows: decided } = await client.query(
      "UPDATE listing_revisions SET status = 'approved', reviewed_by = $2, reviewed_at = now() WHERE id = $1 RETURNING *",
      [revisionId, reviewerId]
    );
    await eventBus.emitAsync(events.LISTING_REVISION_DECIDED,
      { listingId: listing.id, revisionId, decision: 'approved' }, { transaction: client });
    return decided[0];
  });
}

/** FR-73: reject a pending revision with a required reason while preserving public listing content. */
async function rejectListingRevision(revisionId, reviewerId, reason) {
  assertEnabled();
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 1000) throw new ValidationError('A rejection reason of at most 1000 characters is required');
  return db.withTransaction(async (client) => {
    const { rows: ref } = await client.query('SELECT listing_id FROM listing_revisions WHERE id = $1', [revisionId]);
    if (!ref[0]) throw new NotFoundError('listing revision', revisionId);
    await client.query('SELECT id FROM listings WHERE id = $1 FOR UPDATE', [ref[0].listing_id]);
    const { rows } = await client.query('SELECT status FROM listing_revisions WHERE id = $1 FOR UPDATE', [revisionId]);
    if (rows[0]?.status !== 'pending_review') throw conflict('This revision has already been decided');
    const { rows: updated } = await client.query(
      "UPDATE listing_revisions SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), rejection_reason = $3 WHERE id = $1 RETURNING *",
      [revisionId, reviewerId, reason.trim()]
    );
    const listingId = ref[0].listing_id;
    await eventBus.emitAsync(events.LISTING_REVISION_DECIDED,
      { listingId, revisionId, decision: 'rejected' }, { transaction: client });
    return updated[0];
  });
}

module.exports = {
  submitListingRevision, getSellerRevisionHistory, withdrawListingRevision,
  getListingRevisionQueue, getListingRevision, approveListingRevision, rejectListingRevision,
};
