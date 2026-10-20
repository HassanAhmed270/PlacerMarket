const db = require('../../src/db.service');
const users = require('../../src/modules/users.service');
const catalog = require('../../src/modules/catalog.service');
const listings = require('../../src/modules/listings.service');
const { ForbiddenError, ValidationError } = require('../../src/lib/errors');
const discovery = require('../../src/modules/discovery.service');
const { createFixture } = require('./fixtures');

let fixture;
let registrationPhone;
let createdCityId;
let createdSubCategoryId;
let createdMainCategoryId;

async function addListingPhotos(listing, count) {
  await listings.addListingImages(
    listing.listingId,
    listing.userId,
    Array.from({ length: count }, (_, index) => `https://images.invalid/${listing.suffix}-${index}.jpg`)
  );
}

beforeEach(async () => {
  fixture = await createFixture();
  registrationPhone = null;
  createdCityId = null;
  createdSubCategoryId = null;
  createdMainCategoryId = null;
});

afterEach(async () => {
  if (registrationPhone) await db.query('DELETE FROM users WHERE phone = $1', [registrationPhone]);
  if (createdSubCategoryId) await db.query('DELETE FROM sub_categories WHERE id = $1', [createdSubCategoryId]);
  if (createdMainCategoryId) await db.query('DELETE FROM main_categories WHERE id = $1', [createdMainCategoryId]);
  if (createdCityId) await db.query('DELETE FROM cities WHERE id = $1', [createdCityId]);
  await fixture.cleanup();
});

describe('known schema and service mismatches', () => {
  test('registration persists the supplied name in the user full_name field', async () => {
    registrationPhone = `+1999${Date.now().toString().slice(-9)}`;
    const created = await users.registerUser({
      name: 'Registered Probe', phone: registrationPhone, email: null,
      passwordHash: 'fixture-hash', cityId: fixture.cityId,
    });
    const stored = await db.query('SELECT full_name FROM users WHERE id = $1', [created.id]);
    expect(stored.rows[0]).toEqual({ full_name: 'Registered Probe' });
  });

  test.failing('seller application submission creates a pending application for the existing user', async () => {
    await users.submitSellerApplication(fixture.userId, {
      name: 'Fixture seller', phone: '+15550000000', cityId: fixture.cityId,
    });
    const stored = await db.query(
      'SELECT user_id, status FROM seller_applications WHERE user_id = $1 AND id <> $2 ORDER BY created_at DESC LIMIT 1',
      [fixture.userId, fixture.applicationId]
    );
    expect(stored.rows[0]).toEqual({ user_id: fixture.userId, status: 'pending' });
  });

  test('seller application rejection stores its rejection reason', async () => {
    const result = await users.reviewSellerApplication(fixture.applicationId, {
      decision: 'rejected', reason: 'Does not meet criteria', reviewerId: fixture.userId,
    });
    const stored = await db.query('SELECT status, rejection_reason FROM seller_applications WHERE id = $1', [fixture.applicationId]);
    expect(result.status).toBe('rejected');
    expect(stored.rows[0]).toEqual({ status: 'rejected', rejection_reason: 'Does not meet criteria' });
  });

  test('seller application approval promotes the user and creates a profile', async () => {
    await db.query('DELETE FROM seller_profiles WHERE user_id = $1', [fixture.userId]);
    await db.query("UPDATE users SET role = 'buyer' WHERE id = $1", [fixture.userId]);
    const result = await users.reviewSellerApplication(fixture.applicationId, {
      decision: 'approved', reviewerId: fixture.userId,
    });
    const { rows } = await db.query(
      `SELECT u.role, sp.user_id FROM users u LEFT JOIN seller_profiles sp ON sp.user_id = u.id WHERE u.id = $1`,
      [fixture.userId]
    );
    expect(result.status).toBe('approved');
    expect(rows[0]).toEqual({ role: 'seller', user_id: fixture.userId });
  });

  test.failing('seller public card returns the configured display alias', async () => {
    const card = await discovery.getSellerPublicCard(fixture.userId);
    expect(card.displayName).toBe(`Fixture alias ${fixture.suffix}`);
  });

  test('measurement definition lookup returns fields ordered by display_order', async () => {
    await db.query(
      `INSERT INTO measurement_field_defs (sub_category_id, field_name, display_order)
       VALUES ($1, 'sleeve', 0)`,
      [fixture.subCategoryId]
    );
    const fields = await catalog.getMeasurementFieldDefs(fixture.subCategoryId);
    expect(fields.map((field) => field.field_name)).toEqual(['sleeve', 'chest']);
  });

  test('measurement definition replacement persists supported fields in display order', async () => {
    const definitions = await catalog.setMeasurementFieldDefs(fixture.subCategoryId, [
      { fieldName: 'waist', unit: 'inches' },
      { fieldName: 'sleeve', unit: 'cm' },
    ], fixture.userId);

    expect(definitions).toEqual([
      expect.objectContaining({ field_name: 'waist', unit: 'inches', display_order: 0 }),
      expect.objectContaining({ field_name: 'sleeve', unit: 'cm', display_order: 1 }),
    ]);
  });

  test('measurement required flags fail before replacing existing definitions', async () => {
    const before = await catalog.getMeasurementFieldDefs(fixture.subCategoryId);
    const error = await catalog.setMeasurementFieldDefs(fixture.subCategoryId, [
      { fieldName: 'waist', unit: 'inches', required: true },
    ], fixture.userId).catch((caught) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe('Persisting measurement required flags requires a schema/API decision');

    const existing = await catalog.getMeasurementFieldDefs(fixture.subCategoryId);
    expect(existing).toEqual(before);
    expect(existing).toEqual([expect.objectContaining({ id: fixture.fieldDefId, field_name: 'chest' })]);
  });

  test('duplicate measurement field names fail with 23505 and preserve original definitions', async () => {
    const before = await catalog.getMeasurementFieldDefs(fixture.subCategoryId);
    await expect(catalog.setMeasurementFieldDefs(fixture.subCategoryId, [
      { fieldName: 'waist', unit: 'inches' }, { fieldName: 'waist', unit: 'cm' },
    ], fixture.userId)).rejects.toMatchObject({ code: '23505' });
    expect(await catalog.getMeasurementFieldDefs(fixture.subCategoryId)).toEqual(before);
  });

  test('measurement definitions can be replaced with an empty array when unused', async () => {
    const replaced = await catalog.setMeasurementFieldDefs(fixture.subCategoryId, [], fixture.userId);
    expect(replaced).toEqual([]);
    expect(await catalog.getMeasurementFieldDefs(fixture.subCategoryId)).toEqual([]);
  });

  test('measurement replacement with a referencing listing measurement fails 23503 and rolls back', async () => {
    await db.query('INSERT INTO listing_measurements (listing_id, field_def_id, value) VALUES ($1, $2, 41)',
      [fixture.listingId, fixture.fieldDefId]);
    const beforeDefs = await catalog.getMeasurementFieldDefs(fixture.subCategoryId);
    await expect(catalog.setMeasurementFieldDefs(fixture.subCategoryId, [], fixture.userId))
      .rejects.toMatchObject({ code: '23503' });
    expect(await catalog.getMeasurementFieldDefs(fixture.subCategoryId)).toEqual(beforeDefs);
    const { rows } = await db.query(
      'SELECT field_def_id, value FROM listing_measurements WHERE listing_id = $1', [fixture.listingId]
    );
    expect(rows).toEqual([{ field_def_id: fixture.fieldDefId, value: '41.00' }]);
  });

  test('known mismatch pin: payout method fails with PostgreSQL error 42703', async () => {
    await expect(users.updateSellerPayoutMethod(fixture.userId, {
      method: 'bank_transfer', details: 'fixture details',
    })).rejects.toMatchObject({ code: '42703' });
  });

  test('FR-08a: listing status enum does not contain the retired identity hold value', async () => {
    const { rows } = await db.query(
      "SELECT enumlabel FROM pg_enum WHERE enumtypid = 'listing_status'::regtype"
    );
    expect(rows.map((row) => row.enumlabel)).not.toContain('held_pending_id');
  });

  test('user and city service functions return persisted values and expected errors', async () => {
    const citiesBefore = await users.listCities();
    const createdCity = await users.createCity({ name: `City ${fixture.suffix}` }, fixture.userId);
    createdCityId = createdCity.id;
    expect(await users.listCities()).toEqual(expect.arrayContaining([expect.objectContaining({ id: createdCity.id })]));
    expect(citiesBefore.some((row) => row.id === createdCity.id)).toBe(false);
    expect(await users.getUserRole(fixture.userId)).toBe('seller');
    await expect(users.getUserRole('00000000-0000-0000-0000-000000000000'))
      .rejects.toMatchObject({ name: 'NotFoundError', statusCode: 404 });
    await expect(users.assertCityVerified(fixture.userId)).resolves.toBeUndefined();
    await db.query('UPDATE users SET city_id = NULL WHERE id = $1', [fixture.userId]);
    await expect(users.assertCityVerified(fixture.userId)).rejects.toMatchObject({
      name: 'ValidationError', statusCode: 400,
    });
    await db.query('UPDATE users SET city_id = $2 WHERE id = $1', [fixture.userId, fixture.cityId]);
    await expect(users.assertCityVerified('00000000-0000-0000-0000-000000000000'))
      .rejects.toMatchObject({ name: 'NotFoundError', statusCode: 404 });
  });

  test('seller application queue filters by status and profile gates reflect persisted state', async () => {
    expect(await users.getSellerApplicationQueue({ status: 'pending' }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: fixture.applicationId, status: 'pending' })]));
    expect(await users.isApprovedSeller(fixture.userId)).toBe(true);
    await db.query("UPDATE users SET role = 'buyer' WHERE id = $1", [fixture.userId]);
    expect(await users.isApprovedSeller(fixture.userId)).toBe(false);
    await db.query("UPDATE users SET role = 'seller' WHERE id = $1", [fixture.userId]);
    expect(await users.isIdVerificationRequired(100000)).toBe(true);
    expect(await users.isIdVerificationRequired(1)).toBe(false);
    expect(await users.isIdVerified(fixture.userId)).toBe(false);
    await users.markIdVerified(fixture.userId, fixture.userId);
    expect(await users.isIdVerified(fixture.userId)).toBe(true);
    expect((await users.getSellerProfile(fixture.userId)).user_id).toBe(fixture.userId);
    await expect(users.getSellerProfile('00000000-0000-0000-0000-000000000000'))
      .rejects.toMatchObject({ name: 'NotFoundError', statusCode: 404 });
  });

  test('sub-category listing scopes to its main category and creation persists', async () => {
    const otherCategory = await catalog.createMainCategory({ name: `Other ${fixture.suffix}` }, fixture.userId);
    createdMainCategoryId = otherCategory.id;
    const before = await catalog.listSubCategories(fixture.categoryId);
    const created = await catalog.createSubCategory(fixture.categoryId, { name: `Added ${fixture.suffix}` }, fixture.userId);
    createdSubCategoryId = created.id;
    const rows = await catalog.listSubCategories(fixture.categoryId);
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id, main_category_id: fixture.categoryId })]));
    expect(rows).toHaveLength(before.length + 1);
    expect(await catalog.listSubCategories(otherCategory.id)).toEqual([]);
  });

  test('FR-14, FR-15: listing creation persists title and replica disclosure and starts as draft', async () => {
    const created = await listings.createListing(fixture.userId, {
      title: 'Replica probe listing', mainCategoryId: fixture.categoryId,
      subCategoryId: fixture.subCategoryId, condition: 'replica',
      replicaDisclosure: 'This is a replica item.', askingPrice: 10,
    });
    const { rows } = await db.query(
      'SELECT title, replica_disclosure, status FROM listings WHERE id = $1', [created.id]
    );
    expect(rows[0]).toEqual({
      title: 'Replica probe listing', replica_disclosure: 'This is a replica item.', status: 'draft',
    });
  });

  test('FR-15a: listing measurements store the configured field definition ID', async () => {
    const created = await listings.createListing(fixture.userId, {
      title: 'Measured probe listing', mainCategoryId: fixture.categoryId,
      subCategoryId: fixture.subCategoryId, condition: 'brand_new', askingPrice: 10,
      measurements: [{ fieldName: 'chest', value: 40 }],
    });
    const stored = await db.query(
      'SELECT field_def_id, value FROM listing_measurements WHERE listing_id = $1', [created.id]
    );
    expect(stored.rows).toEqual([{ field_def_id: fixture.fieldDefId, value: '40.00' }]);
  });

  test('FR-16: listing images persist through image_url and display_order', async () => {
    await listings.addListingImages(fixture.listingId, fixture.userId, ['https://images.invalid/probe.jpg']);
    const stored = await db.query(
      'SELECT image_url, display_order FROM listing_images WHERE listing_id = $1', [fixture.listingId]
    );
    expect(stored.rows).toEqual([{ image_url: 'https://images.invalid/probe.jpg', display_order: 0 }]);
  });

  test('FR-17: authenticity evidence persists evidence_url with nullable evidence_type', async () => {
    await listings.submitAuthenticityEvidence(fixture.listingId, fixture.userId, ['https://files.invalid/probe.jpg']);
    const stored = await db.query(
      'SELECT evidence_url, evidence_type FROM listing_evidence WHERE listing_id = $1', [fixture.listingId]
    );
    expect(stored.rows).toEqual([{ evidence_url: 'https://files.invalid/probe.jpg', evidence_type: null }]);
  });

  test('SEC-12, FR-17: only the listing seller can submit authenticity evidence', async () => {
    await expect(listings.submitAuthenticityEvidence(
      fixture.listingId, '00000000-0000-0000-0000-000000000000', ['https://files.invalid/other.jpg']
    )).rejects.toBeInstanceOf(ForbiddenError);
    const { rows } = await db.query(
      'SELECT evidence_url FROM listing_evidence WHERE listing_id = $1', [fixture.listingId]
    );
    expect(rows).toEqual([]);
  });

  test('FR-19a: approval publishes a submitted listing with reviewer and timestamp', async () => {
    await addListingPhotos(fixture, 3);
    await listings.submitListingForReview(fixture.listingId, fixture.userId);
    const approved = await listings.approveListing(fixture.listingId, fixture.userId);
    expect(approved.status).toBe('published');
    expect(approved.reviewed_by).toBe(fixture.userId);
    expect(approved.published_at).toBeInstanceOf(Date);
    const { rows } = await db.query(
      'SELECT status, reviewed_by, published_at FROM listings WHERE id = $1', [fixture.listingId]
    );
    expect(rows[0]).toEqual({
      status: 'published', reviewed_by: fixture.userId, published_at: expect.any(Date),
    });
  });

  test('FR-21: rejection stores its reason for a listing in the review queue', async () => {
    await addListingPhotos(fixture, 3);
    await listings.submitListingForReview(fixture.listingId, fixture.userId);
    const rejected = await listings.rejectOrUnpublishListing(fixture.listingId, {
      reviewerId: fixture.userId, reason: 'Missing details',
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejection_reason).toBe('Missing details');
    const { rows } = await db.query(
      'SELECT status, rejection_reason FROM listings WHERE id = $1', [fixture.listingId]
    );
    expect(rows[0]).toEqual({ status: 'rejected', rejection_reason: 'Missing details' });
  });

  test('FR-21: unpublishing a published listing stores its reason and valid status', async () => {
    await db.query("UPDATE listings SET status = 'published' WHERE id = $1", [fixture.listingId]);
    const unpublished = await listings.rejectOrUnpublishListing(fixture.listingId, {
      reviewerId: fixture.userId, reason: 'Policy violation',
    });
    expect(unpublished.status).toBe('unpublished');
    expect(unpublished.rejection_reason).toBe('Policy violation');
    const { rows } = await db.query(
      'SELECT status, rejection_reason FROM listings WHERE id = $1', [fixture.listingId]
    );
    expect(rows[0]).toEqual({ status: 'unpublished', rejection_reason: 'Policy violation' });
  });

  test('FR-19, FR-74: three photos submit a draft into the moderation queue', async () => {
    await addListingPhotos(fixture, 3);
    await listings.submitAuthenticityEvidence(fixture.listingId, fixture.userId, ['https://files.invalid/receipt.jpg']);
    const submitted = await listings.submitListingForReview(fixture.listingId, fixture.userId);
    expect(submitted.status).toBe('pending_review');
    expect(submitted.requires_id_verification).toBe(false);
    const queued = await listings.getModerationQueue();
    expect(queued).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: fixture.listingId, status: 'pending_review', is_high_value: false, has_evidence_submitted: true,
      }),
    ]));
  });

  test('FR-74: submission rejects fewer than three photos and leaves the draft unchanged', async () => {
    await addListingPhotos(fixture, 2);
    await expect(listings.submitListingForReview(fixture.listingId, fixture.userId))
      .rejects.toBeInstanceOf(ValidationError);
    const { rows } = await db.query('SELECT status FROM listings WHERE id = $1', [fixture.listingId]);
    expect(rows[0].status).toBe('draft');
  });

  test('FR-74: six photos are accepted and a seventh addition is rejected', async () => {
    await addListingPhotos(fixture, 6);
    await expect(listings.addListingImages(
      fixture.listingId, fixture.userId, ['https://images.invalid/seventh.jpg']
    )).rejects.toBeInstanceOf(ValidationError);
    const { rows } = await db.query(
      'SELECT image_url, display_order FROM listing_images WHERE listing_id = $1 ORDER BY display_order',
      [fixture.listingId]
    );
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.display_order)).toEqual([0, 1, 2, 3, 4, 5]);
    await expect(listings.submitListingForReview(fixture.listingId, fixture.userId))
      .resolves.toMatchObject({ status: 'pending_review' });
  });

  test('FR-74: submission rejects more than six persisted photos', async () => {
    await db.query(
      `INSERT INTO listing_images (listing_id, image_url, display_order)
       SELECT $1, 'https://images.invalid/direct-' || n || '.jpg', n - 1
       FROM generate_series(1, 7) AS n`,
      [fixture.listingId]
    );
    await expect(listings.submitListingForReview(fixture.listingId, fixture.userId))
      .rejects.toBeInstanceOf(ValidationError);
    const { rows } = await db.query('SELECT status FROM listings WHERE id = $1', [fixture.listingId]);
    expect(rows[0].status).toBe('draft');
  });

  test('SEC-12, FR-16: another seller cannot add photos to the listing', async () => {
    await expect(listings.addListingImages(
      fixture.listingId,
      fixture.otherUserId,
      ['https://images.invalid/unauthorized.jpg']
    )).rejects.toBeInstanceOf(ForbiddenError);
    const { rows } = await db.query('SELECT id FROM listing_images WHERE listing_id = $1', [fixture.listingId]);
    expect(rows).toEqual([]);
  });

  test('FR-16, FR-19: photo additions stop after draft submission for review', async () => {
    await addListingPhotos(fixture, 3);
    await listings.submitListingForReview(fixture.listingId, fixture.userId);
    await expect(listings.addListingImages(
      fixture.listingId, fixture.userId, ['https://images.invalid/late-edit.jpg']
    )).rejects.toBeInstanceOf(ValidationError);
    const { rows } = await db.query(
      'SELECT status, (SELECT count(*)::int FROM listing_images WHERE listing_id = $1) AS photo_count FROM listings WHERE id = $1',
      [fixture.listingId]
    );
    expect(rows[0]).toEqual({ status: 'pending_review', photo_count: 3 });
  });

  test('FR-19, FR-74: approval rejects a pending listing without three photos', async () => {
    await db.query("UPDATE listings SET status = 'pending_review' WHERE id = $1", [fixture.listingId]);
    await expect(listings.approveListing(fixture.listingId, fixture.userId))
      .rejects.toBeInstanceOf(ValidationError);
    const { rows } = await db.query('SELECT status FROM listings WHERE id = $1', [fixture.listingId]);
    expect(rows[0].status).toBe('pending_review');
  });

  test('FR-08a, FR-19b: a high-value listing remains pending until email verification is implemented', async () => {
    const { rows: settings } = await db.query(
      "SELECT value::numeric AS threshold FROM platform_settings WHERE key = 'high_value_threshold_pkr'"
    );
    await db.query('UPDATE listings SET asking_price = $2 WHERE id = $1', [fixture.listingId, settings[0].threshold]);
    await addListingPhotos(fixture, 3);
    const submitted = await listings.submitListingForReview(fixture.listingId, fixture.userId);
    expect(submitted.requires_id_verification).toBe(true);
    await expect(listings.approveListing(fixture.listingId, fixture.userId))
      .rejects.toBeInstanceOf(ForbiddenError);
    const { rows: stillPending } = await db.query('SELECT status FROM listings WHERE id = $1', [fixture.listingId]);
    expect(stillPending[0].status).toBe('pending_review');
    await users.markIdVerified(fixture.userId, fixture.userId);
    await expect(listings.approveListing(fixture.listingId, fixture.userId))
      .rejects.toBeInstanceOf(ForbiddenError);
    const { rows: stillPendingAfterLegacyFlag } = await db.query(
      'SELECT status FROM listings WHERE id = $1', [fixture.listingId]
    );
    expect(stillPendingAfterLegacyFlag[0].status).toBe('pending_review');
  });

  test('FR-18, FR-19a: granting a verified badge persists reviewer metadata independently', async () => {
    const granted = await listings.setVerifiedBadge(fixture.listingId, {
      granted: true, reviewerId: fixture.userId,
    });
    expect(granted.is_verified).toBe(true);
    expect(granted.verified_by).toBe(fixture.userId);
    expect(granted.verified_at).toBeInstanceOf(Date);
    expect(granted.status).toBe('draft');
  });

  test('FR-20: seller edits supported content but cannot assign system-controlled fields', async () => {
    const updated = await listings.updateOwnListing(fixture.listingId, fixture.userId, {
      title: 'Corrected fixture title', description: 'Updated description', askingPrice: 25,
    });
    expect(updated).toMatchObject({
      title: 'Corrected fixture title', description: 'Updated description', asking_price: '25.00',
      status: 'draft', seller_id: fixture.userId,
    });
    await expect(listings.updateOwnListing(fixture.listingId, fixture.userId, { status: 'published' }))
      .rejects.toBeInstanceOf(ValidationError);
    const { rows } = await db.query('SELECT status, seller_id FROM listings WHERE id = $1', [fixture.listingId]);
    expect(rows[0]).toEqual({ status: 'draft', seller_id: fixture.userId });
  });

  test('FR-20: a different seller cannot edit listing content', async () => {
    await expect(listings.updateOwnListing(
      fixture.listingId, fixture.otherUserId, { title: 'Unauthorized edit' }
    )).rejects.toBeInstanceOf(ForbiddenError);
    const { rows } = await db.query('SELECT title FROM listings WHERE id = $1', [fixture.listingId]);
    expect(rows[0].title).toBe(`Fixture listing ${fixture.suffix}`);
  });

  test('FR-20, FR-73: published edits are refused without pending-version storage', async () => {
    await db.query("UPDATE listings SET status = 'published' WHERE id = $1", [fixture.listingId]);
    await expect(listings.updateOwnListing(fixture.listingId, fixture.userId, {
      title: 'Must stay unpublished until moderation',
    })).rejects.toMatchObject({
      name: 'ValidationError', message: expect.stringContaining('pending-version storage'),
    });
    const { rows } = await db.query('SELECT title, status FROM listings WHERE id = $1', [fixture.listingId]);
    expect(rows[0]).toEqual({ title: `Fixture listing ${fixture.suffix}`, status: 'published' });
  });

  test('FR-21a: only rejected listings can be resubmitted and their rejection reason remains visible', async () => {
    await expect(listings.resubmitListing(fixture.listingId, fixture.userId))
      .rejects.toBeInstanceOf(ValidationError);
    await addListingPhotos(fixture, 3);
    await listings.submitListingForReview(fixture.listingId, fixture.userId);
    await listings.rejectOrUnpublishListing(fixture.listingId, {
      reviewerId: fixture.userId, reason: 'Please correct the title',
    });
    await listings.updateOwnListing(fixture.listingId, fixture.userId, { title: 'Corrected title' });
    const resubmitted = await listings.resubmitListing(fixture.listingId, fixture.userId);
    expect(resubmitted).toMatchObject({ status: 'pending_review', rejection_reason: 'Please correct the title' });
    await expect(listings.resubmitListing(fixture.listingId, fixture.userId))
      .rejects.toBeInstanceOf(ValidationError);
  });

  test('FR-08: seller suspension blocks seller listing operations and sets the suspended flag', async () => {
    const suspended = await users.suspendSeller(fixture.userId, { adminId: fixture.userId, reason: 'probe' });
    const stored = await db.query('SELECT is_suspended FROM users WHERE id = $1', [fixture.userId]);
    expect(suspended.is_suspended).toBe(true);
    expect(stored.rows[0].is_suspended).toBe(true);
    expect(await users.isApprovedSeller(fixture.userId)).toBe(false);
    await expect(listings.createListing(fixture.userId, {
      title: 'Suspended seller listing', mainCategoryId: fixture.categoryId,
      subCategoryId: fixture.subCategoryId, condition: 'brand_new', askingPrice: 10,
    })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listings.addListingImages(
      fixture.listingId, fixture.userId, ['https://images.invalid/suspended.jpg']
    )).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listings.submitListingForReview(fixture.listingId, fixture.userId))
      .rejects.toBeInstanceOf(ForbiddenError);
    await expect(listings.updateOwnListing(fixture.listingId, fixture.userId, { title: 'Blocked edit' }))
      .rejects.toBeInstanceOf(ForbiddenError);
    await expect(listings.submitAuthenticityEvidence(
      fixture.listingId, fixture.userId, ['https://files.invalid/suspended.jpg']
    )).rejects.toBeInstanceOf(ForbiddenError);
  });

  test.failing('listing search finds published listings', async () => {
    await db.query("UPDATE listings SET status = 'published', description = 'searchable probe phrase' WHERE id = $1", [fixture.listingId]);
    const results = await discovery.searchListings('searchable probe phrase');
    expect(results.map((row) => row.id)).toContain(fixture.listingId);
  });
});
