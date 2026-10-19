const users = require('../../src/modules/users.service');
const catalog = require('../../src/modules/catalog.service');
const listings = require('../../src/modules/listings.service');
const discovery = require('../../src/modules/discovery.service');
const db = require('../../src/db.service');

async function createListingFixture({ askingPrice = 1, withMeasurement = false } = {}) {
  const { rows: userRows } = await db.query(
    `INSERT INTO users (full_name, phone, password_hash, role)
     VALUES ($1, $2, 'probe-hash', 'seller') RETURNING id`,
    [`Probe Seller ${Date.now()}`, `+1555${Date.now()}`]
  );
  const { rows: categoryRows } = await db.query(
    'INSERT INTO main_categories (name) VALUES ($1) RETURNING id', [`Probe ${Date.now()}`]
  );
  const { rows: subCategoryRows } = await db.query(
    'INSERT INTO sub_categories (main_category_id, name) VALUES ($1, $2) RETURNING id',
    [categoryRows[0].id, `Probe ${Date.now()}`]
  );
  const { rows: listingRows } = await db.query(
    `INSERT INTO listings (seller_id, main_category_id, sub_category_id, condition, title, asking_price)
     VALUES ($1, $2, $3, 'brand_new', 'Probe listing', $4) RETURNING id`,
    [userRows[0].id, categoryRows[0].id, subCategoryRows[0].id, askingPrice]
  );
  if (withMeasurement) {
    await db.query(
      'INSERT INTO measurement_field_defs (sub_category_id, field_name) VALUES ($1, $2)',
      [subCategoryRows[0].id, 'chest']
    );
  }
  return { userId: userRows[0].id, listingId: listingRows[0].id, subCategoryId: subCategoryRows[0].id };
}

describe('known schema/code mismatches (expected failures)', () => {
  test.failing('user registration writes users.name but the schema requires users.full_name', async () => {
    const user = await users.registerUser({
      name: 'Probe User', phone: `+1555${Date.now()}`, email: null,
      passwordHash: 'hash', cityId: null,
    });
    expect(user.full_name).toBe('Probe User');
  });

  test.failing('seller application submission uses columns absent from seller_applications', async () => {
    const result = await users.submitSellerApplication('00000000-0000-0000-0000-000000000001', {
      name: 'Probe Seller', phone: '555', cityId: null,
    });
    expect(result.status).toBe('pending');
  });

  test.failing('seller application review writes decision_reason instead of rejection_reason', async () => {
    const { rows: userRows } = await db.query(
      `INSERT INTO users (full_name, phone, password_hash) VALUES ($1, $2, 'probe-hash') RETURNING id`,
      [`Review Probe ${Date.now()}`, `+1666${Date.now()}`]
    );
    const { rows } = await db.query(
      'INSERT INTO seller_applications (user_id) VALUES ($1) RETURNING id', [userRows[0].id]
    );
    await users.reviewSellerApplication(rows[0].id, { decision: 'rejected', reason: 'probe', reviewerId: userRows[0].id });
    expect(true).toBe(false);
  });

  test.failing('seller payout update uses payout_details and payout values absent from schema', async () => {
    await users.updateSellerPayoutMethod('00000000-0000-0000-0000-000000000001', {
      method: 'bank_transfer', details: 'probe',
    });
    expect(true).toBe(false);
  });

  test.failing('seller public card reads display_name instead of seller_profiles.display_alias', async () => {
    const { rows } = await db.query(
      `INSERT INTO users (full_name, phone, password_hash, role) VALUES ($1, $2, 'probe-hash', 'seller') RETURNING id`,
      [`Card Probe ${Date.now()}`, `+1777${Date.now()}`]
    );
    await db.query('INSERT INTO seller_profiles (user_id, display_alias) VALUES ($1, $2)', [rows[0].id, 'Probe alias']);
    const card = await discovery.getSellerPublicCard(rows[0].id);
    expect(card.displayName).toBe('Probe alias');
  });

  test.failing('measurement field definitions order by missing sort_order', async () => {
    const rows = await catalog.getMeasurementFieldDefs('00000000-0000-0000-0000-000000000001');
    expect(rows).toEqual([]);
  });

  test.failing('listing create and measurement write mismatch required title and field columns', async () => {
    const fixture = await createListingFixture({ withMeasurement: true });
    await listings.createListing(fixture.userId, {
      mainCategoryId: (await db.query('SELECT main_category_id FROM listings WHERE id = $1', [fixture.listingId])).rows[0].main_category_id,
      subCategoryId: fixture.subCategoryId,
      condition: 'brand_new', askingPrice: 1, measurements: [{ fieldName: 'chest', value: 1 }],
    });
    expect(true).toBe(false);
  });

  test.failing('listing image insertion uses url and sort_order instead of image_url and display_order', async () => {
    const fixture = await createListingFixture();
    await listings.addListingImages(fixture.listingId, ['https://example.invalid/image']);
    expect(true).toBe(false);
  });

  test.failing('authenticity evidence insertion uses columns absent from listing_evidence', async () => {
    const fixture = await createListingFixture();
    await listings.submitAuthenticityEvidence(fixture.listingId, fixture.userId, ['https://example.invalid/evidence']);
    expect(true).toBe(false);
  });

  test.failing('listing moderation uses invalid status values and columns absent from listings', async () => {
    const fixture = await createListingFixture();
    await listings.approveListing(fixture.listingId, fixture.userId);
    expect(true).toBe(false);
  });

  test.failing('listing ID hold uses held_pending_id, absent from listing_status enum', async () => {
    const fixture = await createListingFixture();
    await listings.holdListingPendingIdVerification(fixture.listingId, fixture.userId, 'probe');
    expect(true).toBe(false);
  });

  test.failing('listing rejection writes decision_reason instead of rejection_reason', async () => {
    const fixture = await createListingFixture();
    await listings.rejectOrUnpublishListing(fixture.listingId, { reviewerId: fixture.userId, reason: 'probe' });
    expect(true).toBe(false);
  });

  test.failing('seller suspension writes users.status instead of users.is_suspended', async () => {
    await users.suspendSeller('00000000-0000-0000-0000-000000000001', { adminId: null, reason: 'probe' });
    expect(true).toBe(false);
  });

  test.failing('listing search filters on live, absent from listing_status enum', async () => {
    const rows = await discovery.searchListings('probe');
    expect(rows).toEqual([]);
  });
});
