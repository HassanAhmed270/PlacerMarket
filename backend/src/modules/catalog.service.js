/**
 * modules/catalog.service.js
 *
 * Owns: FR-11 to FR-14a (specs.md section "2. Catalog")
 * Tables owned: main_categories, sub_categories, measurement_field_defs
 *
 * Note the split with listings.service.js: this file owns the *definitions*
 * of measurement fields per sub-category (admin-configurable); the actual
 * per-listing measurement *values* live in listing_measurements, owned by
 * listings.service.js. Don't duplicate the field-definition logic there —
 * listings.service.js should call getMeasurementFieldDefs() from here to
 * validate what it's storing.
 */

const db = require('../db.service');
const { NotFoundError, ValidationError } = require('../lib/errors');

const CONDITION_TYPES = Object.freeze(['brand_new', 'pre_owned', 'custom_made', 'replica']); // FR-13
const MANAGED_ATTRIBUTE_TYPES = Object.freeze(['color', 'fabric', 'brand']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---- FR-11, FR-12: category tree ----

/** FR-11: main categories (Men's/Women's/Kids'). */
async function listMainCategories() {
  const { rows } = await db.query('SELECT * FROM main_categories ORDER BY name');
  return rows;
}

/** FR-11: sub-categories are defined PER main category, not shared across them. */
async function listSubCategories(mainCategoryId) {
  const { rows } = await db.query(
    'SELECT * FROM sub_categories WHERE main_category_id = $1 ORDER BY name',
    [mainCategoryId]
  );
  return rows;
}

/** FR-12: admin adds/edits/removes main categories independently. */
async function createMainCategory({ name }, adminId) {
  const { rows } = await db.query('INSERT INTO main_categories (name) VALUES ($1) RETURNING *', [name]);
  return rows[0];
}

/** FR-12: admin adds/edits/removes sub-categories independently, scoped to one main category. */
async function createSubCategory(mainCategoryId, { name }, adminId) {
  const { rows } = await db.query(
    'INSERT INTO sub_categories (main_category_id, name) VALUES ($1, $2) RETURNING *',
    [mainCategoryId, name]
  );
  return rows[0];
}

// ---- FR-13, FR-14, FR-14a: condition/type ----

/** FR-13: condition/type is independent of category. */
function listConditionTypes() {
  return CONDITION_TYPES;
}

/** FR-14: replica items require explicit disclosure fields; allowed under ANY sub-category. */
function assertReplicaDisclosureIfNeeded({ condition, replicaDisclosure }) {
  if (condition === 'replica' && !replicaDisclosure) {
    throw new ValidationError('Replica items must include an explicit disclosure field (FR-14)');
  }
}

/** FR-14a: buy-only for MVP — rental listing type is out of scope, guard against it explicitly. */
function assertNotRentalListing({ listingType }) {
  if (listingType === 'rental') {
    throw new ValidationError('Rental listings are deferred, not supported in MVP (FR-14a)');
  }
}

// ---- FR-15a (definitions side): measurement field defs, admin-configurable per sub-category ----

/** FR-15a: admin-defined measurement fields for a sub-category. */
async function getMeasurementFieldDefs(subCategoryId, { includeInactive = false } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM measurement_field_defs
     WHERE sub_category_id = $1 AND ($2::boolean OR is_active = true)
     ORDER BY display_order, id`,
    [subCategoryId, includeInactive]
  );
  return rows;
}

/** FR-15a: share-lock the owning sub-category while a listing reads its active definitions. */
async function lockSubCategoryForListing(client, subCategoryId) {
  const { rows } = await client.query('SELECT id FROM sub_categories WHERE id = $1 FOR SHARE', [subCategoryId]);
  if (!rows[0]) throw new NotFoundError('sub_category', subCategoryId);
}

/** FR-15a: admin adds, renames, reorders, and retires definitions without deleting referenced fields. */
async function setMeasurementFieldDefs(subCategoryId, fieldDefs, adminId, getReferencedDefinitionIds) {
  if (!Array.isArray(fieldDefs) || fieldDefs.some((definition) =>
    !definition || typeof definition !== 'object' || Array.isArray(definition) ||
    typeof definition.fieldName !== 'string' || !definition.fieldName.trim() || definition.fieldName.trim().length > 50 ||
    (definition.unit != null && (typeof definition.unit !== 'string' || definition.unit.length > 20)) ||
    (definition.required != null && typeof definition.required !== 'boolean') ||
    (definition.isActive != null && typeof definition.isActive !== 'boolean')
  )) {
    throw new ValidationError('Each measurement definition needs a fieldName, optional unit, required, and isActive values');
  }
  if (typeof getReferencedDefinitionIds !== 'function') {
    throw new ValidationError('A listing-measurement reference checker is required');
  }

  return db.withTransaction(async (client) => {
    const { rows: subCategories } = await client.query(
      'SELECT id FROM sub_categories WHERE id = $1 FOR UPDATE', [subCategoryId]
    );
    if (!subCategories[0]) throw new NotFoundError('sub_category', subCategoryId);
    const { rows: existingRows } = await client.query(
      'SELECT * FROM measurement_field_defs WHERE sub_category_id = $1 FOR UPDATE', [subCategoryId]
    );
    const existingById = new Map(existingRows.map((definition) => [definition.id, definition]));
    const existingByName = new Map(existingRows.map((definition) => [definition.field_name, definition]));
    const retainedIds = new Set();
    const names = new Set();
    for (const [displayOrder, definition] of fieldDefs.entries()) {
      const fieldName = definition.fieldName.trim();
      if (names.has(fieldName)) throw new ValidationError(`Duplicate measurement field name: ${fieldName}`);
      names.add(fieldName);
      const existing = definition.id
        ? existingById.get(definition.id)
        : existingByName.get(fieldName);
      if (definition.id && !existing) throw new ValidationError('Measurement field id does not belong to this sub-category');
      if (existing && retainedIds.has(existing.id)) throw new ValidationError('A measurement field may be listed only once');
      const active = definition.isActive !== false;
      if (existing) {
        retainedIds.add(existing.id);
        await client.query(
          `UPDATE measurement_field_defs
           SET field_name = $1, unit = $2, required = $3, is_active = $4, display_order = $5
           WHERE id = $6`,
          [fieldName, definition.unit ?? null, definition.required ?? false, active, displayOrder, existing.id]
        );
      } else {
        const { rows } = await client.query(
          `INSERT INTO measurement_field_defs
             (sub_category_id, field_name, unit, required, is_active, display_order)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [subCategoryId, fieldName, definition.unit ?? null, definition.required ?? false, active, displayOrder]
        );
        retainedIds.add(rows[0].id);
      }
    }

    const omittedIds = existingRows.filter((definition) => !retainedIds.has(definition.id)).map((definition) => definition.id);
    const referencedIds = new Set(await getReferencedDefinitionIds(client, omittedIds));
    for (const definitionId of omittedIds) {
      if (referencedIds.has(definitionId)) {
        await client.query('UPDATE measurement_field_defs SET is_active = false WHERE id = $1', [definitionId]);
      } else {
        await client.query('DELETE FROM measurement_field_defs WHERE id = $1', [definitionId]);
      }
    }
    const { rows } = await client.query(
      'SELECT * FROM measurement_field_defs WHERE sub_category_id = $1 ORDER BY display_order, id',
      [subCategoryId]
    );
    return rows;
  });
}

function assertManagedAttributeType(attributeType) {
  if (!MANAGED_ATTRIBUTE_TYPES.includes(attributeType)) {
    throw new ValidationError('attributeType must be color, fabric, or brand');
  }
}

function validateManagedAttributeValue(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) {
    throw new ValidationError('value is required and must be at most 100 characters');
  }
  return value.trim();
}

/** FR-15b: public catalog choices expose approved values only. */
async function listManagedAttributeValues(attributeType) {
  assertManagedAttributeType(attributeType);
  const { rows } = await db.read(
    `SELECT id, attribute_type, value
     FROM managed_catalog_values
     WHERE attribute_type = $1 AND status = 'approved'
     ORDER BY normalized_value, id`,
    [attributeType]
  );
  return rows;
}

/** FR-15b: admins can add approved catalog values without bypassing uniqueness. */
async function createManagedAttributeValue(attributeType, data, adminId) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ValidationError('Managed catalog value details are required');
  }
  assertManagedAttributeType(attributeType);
  const normalizedValue = validateManagedAttributeValue(data.value);
  const { rows } = await db.query(
    `INSERT INTO managed_catalog_values
       (attribute_type, value, status, created_by, reviewed_by, reviewed_at)
     VALUES ($1, $2, 'approved', $3, $3, now())
     ON CONFLICT (attribute_type, normalized_value) DO UPDATE
       SET status = 'approved', reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now(),
           rejection_reason = NULL
     RETURNING id, attribute_type, value, status`,
    [attributeType, normalizedValue, adminId]
  );
  return rows[0];
}

/** FR-15b: sellers' custom values enter a deduplicated approval queue. */
async function resolveListingAttribute(client, attributeType, selectedId, customValue, creatorId = null) {
  assertManagedAttributeType(attributeType);
  if (selectedId != null && customValue != null) {
    throw new ValidationError(`Choose an approved ${attributeType} or provide a custom value, not both`);
  }
  if (selectedId != null) {
    if (typeof selectedId !== 'string' || !UUID.test(selectedId)) {
      throw new ValidationError(`${attributeType}Id must be a valid UUID`);
    }
    const { rows } = await client.query(
      `SELECT id, value, status FROM managed_catalog_values
       WHERE id = $1 AND attribute_type = $2 FOR SHARE`,
      [selectedId, attributeType]
    );
    if (!rows[0] || rows[0].status !== 'approved') {
      throw new ValidationError(`Select an approved ${attributeType} from the catalog`);
    }
    return rows[0];
  }
  if (customValue == null || customValue === '') return null;
  const value = validateManagedAttributeValue(customValue);
  const { rows } = await client.query(
    `INSERT INTO managed_catalog_values (attribute_type, value, status, created_by)
     VALUES ($1, $2, 'pending_custom', $3)
     ON CONFLICT (attribute_type, normalized_value) DO UPDATE
       SET status = CASE WHEN managed_catalog_values.status = 'rejected'
                         THEN 'pending_custom' ELSE managed_catalog_values.status END,
           reviewed_by = CASE WHEN managed_catalog_values.status = 'rejected'
                              THEN NULL ELSE managed_catalog_values.reviewed_by END,
           reviewed_at = CASE WHEN managed_catalog_values.status = 'rejected'
                              THEN NULL ELSE managed_catalog_values.reviewed_at END,
           rejection_reason = CASE WHEN managed_catalog_values.status = 'rejected'
                                   THEN NULL ELSE managed_catalog_values.rejection_reason END
     RETURNING id, value, status`,
    [attributeType, value, creatorId]
  );
  return { ...rows[0], value };
}

/** FR-15b: return custom values waiting for admin review. */
async function getManagedAttributeApprovalQueue() {
  const { rows } = await db.query(
    `SELECT id, attribute_type, value, status, created_at
     FROM managed_catalog_values
     WHERE status = 'pending_custom'
     ORDER BY created_at, id LIMIT 200`
  );
  return rows;
}

/** FR-15b: approve a custom value so it becomes available to filters. */
async function approveManagedAttributeValue(valueId, reviewerId) {
  const { rows } = await db.query(
    `UPDATE managed_catalog_values
     SET status = 'approved', reviewed_by = $2, reviewed_at = now(), rejection_reason = NULL
     WHERE id = $1 AND status = 'pending_custom'
     RETURNING id, attribute_type, value, status`,
    [valueId, reviewerId]
  );
  if (rows[0]) return rows[0];
  const { rows: existing } = await db.query('SELECT id FROM managed_catalog_values WHERE id = $1', [valueId]);
  if (!existing[0]) throw new NotFoundError('managed catalog value', valueId);
  throw new ValidationError('Only a pending custom value can be approved');
}

/** FR-15b: rejected values stay out of public choices and may be resubmitted later. */
async function rejectManagedAttributeValue(valueId, reviewerId, reason) {
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) {
    throw new ValidationError('A rejection reason of at most 500 characters is required');
  }
  const { rows } = await db.query(
    `UPDATE managed_catalog_values
     SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), rejection_reason = $3
     WHERE id = $1 AND status = 'pending_custom'
     RETURNING id, attribute_type, value, status, rejection_reason`,
    [valueId, reviewerId, reason.trim()]
  );
  if (rows[0]) return rows[0];
  const { rows: existing } = await db.query('SELECT id FROM managed_catalog_values WHERE id = $1', [valueId]);
  if (!existing[0]) throw new NotFoundError('managed catalog value', valueId);
  throw new ValidationError('Only a pending custom value can be rejected');
}

module.exports = {
  CONDITION_TYPES,
  MANAGED_ATTRIBUTE_TYPES,
  listMainCategories,
  listSubCategories,
  createMainCategory,
  createSubCategory,
  listConditionTypes,
  assertReplicaDisclosureIfNeeded,
  assertNotRentalListing,
  getMeasurementFieldDefs,
  lockSubCategoryForListing,
  setMeasurementFieldDefs,
  listManagedAttributeValues,
  createManagedAttributeValue,
  resolveListingAttribute,
  getManagedAttributeApprovalQueue,
  approveManagedAttributeValue,
  rejectManagedAttributeValue,
};
