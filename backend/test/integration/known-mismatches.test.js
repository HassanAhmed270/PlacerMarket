const db = require('../../src/db.service');
const users = require('../../src/modules/users.service');
const catalog = require('../../src/modules/catalog.service');
const listings = require('../../src/modules/listings.service');
const discovery = require('../../src/modules/discovery.service');
const { createFixture } = require('./fixtures');

let fixture;
let registrationPhone;

beforeEach(async () => {
  fixture = await createFixture();
  registrationPhone = null;
});

afterEach(async () => {
  if (registrationPhone) await db.query('DELETE FROM users WHERE phone = $1', [registrationPhone]);
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
    await expect(catalog.setMeasurementFieldDefs(fixture.subCategoryId, [
      { fieldName: 'waist', unit: 'inches', required: true },
    ], fixture.userId)).rejects.toThrow(
      'Persisting measurement required flags requires a schema/API decision'
    );

    const existing = await catalog.getMeasurementFieldDefs(fixture.subCategoryId);
    expect(existing).toEqual([expect.objectContaining({ id: fixture.fieldDefId, field_name: 'chest' })]);
  });

  test.failing('listing creation persists its title and replica disclosure', async () => {
    const created = await listings.createListing(fixture.userId, {
      title: 'Replica probe listing', mainCategoryId: fixture.categoryId,
      subCategoryId: fixture.subCategoryId, condition: 'replica',
      replicaDisclosure: 'This is a replica item.', askingPrice: 10,
    });
    expect(created.title).toBe('Replica probe listing');
    expect(created.replica_disclosure).toBe('This is a replica item.');
  });

  test.failing('listing measurement is stored against the configured field definition', async () => {
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

  test.failing('listing images persist through image_url and display_order', async () => {
    await listings.addListingImages(fixture.listingId, ['https://images.invalid/probe.jpg']);
    const stored = await db.query(
      'SELECT image_url, display_order FROM listing_images WHERE listing_id = $1', [fixture.listingId]
    );
    expect(stored.rows).toEqual([{ image_url: 'https://images.invalid/probe.jpg', display_order: 0 }]);
  });

  test.failing('authenticity evidence persists through evidence_url', async () => {
    await listings.submitAuthenticityEvidence(fixture.listingId, fixture.userId, ['https://files.invalid/probe.jpg']);
    const stored = await db.query(
      'SELECT evidence_url FROM listing_evidence WHERE listing_id = $1', [fixture.listingId]
    );
    expect(stored.rows).toEqual([{ evidence_url: 'https://files.invalid/probe.jpg' }]);
  });

  test.failing('listing approval publishes the listing and records its reviewer', async () => {
    const approved = await listings.approveListing(fixture.listingId, fixture.userId);
    expect(approved.status).toBe('published');
    expect(approved.reviewed_by).toBe(fixture.userId);
    expect(approved.published_at).toBeInstanceOf(Date);
  });

  test.failing('listing rejection stores its rejection reason', async () => {
    const rejected = await listings.rejectOrUnpublishListing(fixture.listingId, {
      reviewerId: fixture.userId, reason: 'Missing details',
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejection_reason).toBe('Missing details');
  });

  test('seller suspension updates the is_suspended flag', async () => {
    const suspended = await users.suspendSeller(fixture.userId, { adminId: fixture.userId, reason: 'probe' });
    const stored = await db.query('SELECT is_suspended FROM users WHERE id = $1', [fixture.userId]);
    expect(suspended.is_suspended).toBe(true);
    expect(stored.rows[0].is_suspended).toBe(true);
  });

  test.failing('listing search finds published listings', async () => {
    await db.query("UPDATE listings SET status = 'published', description = 'searchable probe phrase' WHERE id = $1", [fixture.listingId]);
    const results = await discovery.searchListings('searchable probe phrase');
    expect(results.map((row) => row.id)).toContain(fixture.listingId);
  });
});
