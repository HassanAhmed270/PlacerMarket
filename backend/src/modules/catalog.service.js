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

module.exports = {
  CONDITION_TYPES,
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
};
