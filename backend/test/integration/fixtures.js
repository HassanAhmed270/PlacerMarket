const db = require('../../src/db.service');
require('../../src/modules/notifications.service');

async function createFixture({ askingPrice = 10, listingStatus = 'draft' } = {}) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const { rows: cityRows } = await db.query('INSERT INTO cities (name) VALUES ($1) RETURNING id', [`Probe city ${suffix}`]);
  const { rows: userRows } = await db.query(
    `INSERT INTO users (full_name, phone, password_hash, city_id, role)
     VALUES ($1, $2, 'fixture-hash', $3, 'seller') RETURNING id`,
    [`Fixture seller ${suffix}`, `+1555${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 1000)}`, cityRows[0].id]
  );
  const userId = userRows[0].id;
  await db.query(
    `INSERT INTO seller_profiles (user_id, display_alias, is_approved, approved_at)
     VALUES ($1, $2, true, now())`,
    [userId, `Fixture alias ${suffix}`]
  );
  const { rows: otherUserRows } = await db.query(
    `INSERT INTO users (full_name, phone, password_hash, city_id, role)
     VALUES ($1, $2, 'fixture-hash', $3, 'seller') RETURNING id`,
    [`Other fixture seller ${suffix}`, `+1556${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 1000)}`, cityRows[0].id]
  );
  const otherUserId = otherUserRows[0].id;
  await db.query(
    `INSERT INTO seller_profiles (user_id, display_alias, is_approved, approved_at)
     VALUES ($1, $2, true, now())`,
    [otherUserId, `Other fixture alias ${suffix}`]
  );
  const { rows: categoryRows } = await db.query(
    'INSERT INTO main_categories (name) VALUES ($1) RETURNING id', [`Fixture main ${suffix}`]
  );
  const { rows: subCategoryRows } = await db.query(
    'INSERT INTO sub_categories (main_category_id, name) VALUES ($1, $2) RETURNING id',
    [categoryRows[0].id, `Fixture sub ${suffix}`]
  );
  const { rows: listingRows } = await db.query(
    `INSERT INTO listings (seller_id, main_category_id, sub_category_id, condition, title, asking_price, status)
     VALUES ($1, $2, $3, 'brand_new', $4, $5, $6) RETURNING id`,
    [userId, categoryRows[0].id, subCategoryRows[0].id, `Fixture listing ${suffix}`, askingPrice, listingStatus]
  );
  const { rows: applicationRows } = await db.query(
    'INSERT INTO seller_applications (user_id) VALUES ($1) RETURNING id', [userId]
  );
  const { rows: fieldRows } = await db.query(
    `INSERT INTO measurement_field_defs (sub_category_id, field_name, display_order)
     VALUES ($1, 'chest', 1) RETURNING id`,
    [subCategoryRows[0].id]
  );

  return {
    userId,
    otherUserId,
    suffix,
    cityId: cityRows[0].id,
    categoryId: categoryRows[0].id,
    subCategoryId: subCategoryRows[0].id,
    listingId: listingRows[0].id,
    applicationId: applicationRows[0].id,
    fieldDefId: fieldRows[0].id,
    async cleanup() {
      await global.drainIntegrationListeners(5000);
      await db.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM notifications WHERE user_id = $1', [otherUserId]);
      await db.query('DELETE FROM listing_images WHERE listing_id IN (SELECT id FROM listings WHERE seller_id = $1)', [userId]);
      await db.query('DELETE FROM listing_evidence WHERE listing_id IN (SELECT id FROM listings WHERE seller_id = $1)', [userId]);
      await db.query('DELETE FROM listing_measurements WHERE listing_id IN (SELECT id FROM listings WHERE seller_id = $1)', [userId]);
      await db.query('DELETE FROM listings WHERE seller_id = $1', [userId]);
      await db.query('DELETE FROM measurement_field_defs WHERE sub_category_id = $1', [subCategoryRows[0].id]);
      await db.query('DELETE FROM seller_applications WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM seller_profiles WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM seller_profiles WHERE user_id = $1', [otherUserId]);
      await db.query('DELETE FROM users WHERE id = $1', [userId]);
      await db.query('DELETE FROM users WHERE id = $1', [otherUserId]);
      await db.query('DELETE FROM sub_categories WHERE id = $1', [subCategoryRows[0].id]);
      await db.query('DELETE FROM main_categories WHERE id = $1', [categoryRows[0].id]);
      await db.query('DELETE FROM cities WHERE id = $1', [cityRows[0].id]);
    },
  };
}

module.exports = { createFixture };
