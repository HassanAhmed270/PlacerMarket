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
const { NotFoundError, ValidationError, NotImplementedError } = require('../lib/errors');

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
async function getMeasurementFieldDefs(subCategoryId) {
  const { rows } = await db.query(
    'SELECT * FROM measurement_field_defs WHERE sub_category_id = $1 ORDER BY display_order',
    [subCategoryId]
  );
  return rows;
}

/** FR-15a: admin replaces the measurement field set for a sub-category. */
async function setMeasurementFieldDefs(subCategoryId, fieldDefs, adminId) {
  // The schema has no `required` column. Reject that contract explicitly before
  // deleting current definitions; do not silently lose the caller's setting.
  if (fieldDefs.some((def) => Object.prototype.hasOwnProperty.call(def, 'required'))) {
    throw new NotImplementedError('Persisting measurement required flags requires a schema/API decision');
  }

  // fieldDefs: [{ fieldName, unit }, ...] — admin-defined, extensible over time.
  return db.withTransaction(async (client) => {
    await client.query('DELETE FROM measurement_field_defs WHERE sub_category_id = $1', [subCategoryId]);
    for (const [i, def] of fieldDefs.entries()) {
      await client.query(
        `INSERT INTO measurement_field_defs (sub_category_id, field_name, unit, display_order)
         VALUES ($1, $2, $3, $4)`,
        [subCategoryId, def.fieldName, def.unit, i]
      );
    }
    const { rows } = await client.query(
      'SELECT * FROM measurement_field_defs WHERE sub_category_id = $1 ORDER BY display_order',
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
  setMeasurementFieldDefs,
};
