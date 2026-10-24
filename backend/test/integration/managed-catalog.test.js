const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const db = require('../../src/db.service');
const app = require('../../src/app');
const catalog = require('../../src/modules/catalog.service');
const listings = require('../../src/modules/listings.service');
const listingRevisions = require('../../src/modules/listingRevisions.service');
const discovery = require('../../src/modules/discovery.service');
const { signAccessToken } = require('../../src/lib/jwt');
const { upSection } = require('../../db/generate-schema-snapshot');
const { createFixture } = require('./fixtures');

describe('FR-15b managed listing attributes on PostgreSQL', () => {
  let fixture;
  let previousJwtSecret;
  const jwtSecret = 'integration-managed-catalog-secret-with-32-bytes';

  beforeEach(async () => {
    fixture = await createFixture();
    previousJwtSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = jwtSecret;
  });

  afterEach(async () => {
    try {
      if (fixture) await fixture.cleanup();
    } finally {
      if (previousJwtSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = previousJwtSecret;
    }
  });

  test('listing creation accepts approved picks and pending custom values; admin can approve and reject with a dedicated permission', async () => {
    const colors = await catalog.listManagedAttributeValues('color');
    const color = colors.find((item) => item.value === 'Black');
    expect(colors.length).toBeGreaterThanOrEqual(20);
    expect(color).toBeDefined();
    const fabricName = `Custom fabric ${fixture.suffix}`;
    const brandName = `Custom brand ${fixture.suffix}`;
    const listing = await listings.createListing(fixture.userId, {
      title: `Managed attributes ${fixture.suffix}`,
      mainCategoryId: fixture.categoryId,
      subCategoryId: fixture.subCategoryId,
      condition: 'brand_new',
      askingPrice: 50,
      colorId: color.id,
      fabricMaterial: fabricName,
      brand: brandName,
    });
    expect(listing).toMatchObject({
      color_id: color.id,
      color: 'Black',
      fabric_material: fabricName,
      brand: brandName,
    });

    const { rows: customValues } = await db.query(
      `SELECT id, attribute_type, status FROM managed_catalog_values
       WHERE value = ANY($1::text[]) ORDER BY attribute_type`,
      [[fabricName, brandName]]
    );
    expect(customValues).toEqual(expect.arrayContaining([
      expect.objectContaining({ attribute_type: 'fabric', status: 'pending_custom' }),
      expect.objectContaining({ attribute_type: 'brand', status: 'pending_custom' }),
    ]));
    const customBrand = customValues.find((value) => value.attribute_type === 'brand');
    const customFabric = customValues.find((value) => value.attribute_type === 'fabric');

    await db.query("UPDATE listings SET status = 'published', published_at = now() WHERE id = $1", [listing.id]);
    const revisionFabricName = `Revision fabric ${fixture.suffix}`;
    const revision = await listingRevisions.submitListingRevision(listing.id, fixture.userId, {
      colorId: color.id,
      fabricMaterial: revisionFabricName,
    });
    expect(revision.proposed_color_id).toBe(color.id);
    const { rows: revisionFabricRows } = await db.query(
      `SELECT value, status FROM managed_catalog_values WHERE id = $1`,
      [revision.proposed_fabric_id]
    );
    expect(revisionFabricRows[0]).toEqual({ value: revisionFabricName, status: 'pending_custom' });

    await expect(discovery.filterListings({ brandId: customBrand.id })).resolves.toEqual([]);

    const sellerToken = signAccessToken(fixture.userId, { secret: jwtSecret });
    await request(app).get('/api/catalog/attribute-approval-queue')
      .set('Authorization', `Bearer ${sellerToken}`).expect(403);
    await db.query("UPDATE users SET role = 'buyer' WHERE id = $1", [fixture.otherUserId]);
    const buyerToken = signAccessToken(fixture.otherUserId, { secret: jwtSecret });
    await request(app).get('/api/catalog/attribute-approval-queue')
      .set('Authorization', `Bearer ${buyerToken}`).expect(403);
    await db.query("UPDATE users SET role = 'moderator' WHERE id = $1", [fixture.otherUserId]);
    const moderatorToken = signAccessToken(fixture.otherUserId, { secret: jwtSecret });
    await request(app).get('/api/catalog/attribute-approval-queue')
      .set('Authorization', `Bearer ${moderatorToken}`).expect(403);

    await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [fixture.otherUserId]);
    const { rows: adminRows } = await db.query('SELECT role FROM users WHERE id = $1', [fixture.otherUserId]);
    expect(adminRows[0].role).toBe('admin');
    const adminToken = signAccessToken(fixture.otherUserId, { secret: jwtSecret });
    const managedBrandName = `Managed brand ${fixture.suffix}`;
    const managedBrand = await request(app).post('/api/catalog/attributes/brand')
      .set('Authorization', `Bearer ${adminToken}`).send({ value: managedBrandName }).expect(201);
    expect(managedBrand.body).toMatchObject({
      attribute_type: 'brand', value: managedBrandName, status: 'approved',
    });
    const queueResponse = await request(app).get('/api/catalog/attribute-approval-queue')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(queueResponse.status).toBe(200);
    const queue = queueResponse;
    expect(queue.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: customFabric.id, value: fabricName, status: 'pending_custom' }),
      expect.objectContaining({ id: customBrand.id, value: brandName, status: 'pending_custom' }),
    ]));

    await request(app).post(`/api/catalog/attributes/${customFabric.id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`).send({}).expect(200);
    await request(app).post(`/api/catalog/attributes/${customBrand.id}/reject`)
      .set('Authorization', `Bearer ${adminToken}`).send({ reason: 'Not a brand name' }).expect(200);

    await expect(discovery.filterListings({ fabricId: customFabric.id }))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: listing.id })]));
    await expect(discovery.filterListings({ brandId: customBrand.id })).resolves.toEqual([]);
    const approvedFabrics = await catalog.listManagedAttributeValues('fabric');
    expect(approvedFabrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: customFabric.id, value: fabricName }),
    ]));
    const approvedBrands = await catalog.listManagedAttributeValues('brand');
    expect(approvedBrands).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: customBrand.id })]));
  });

  test('015 migration backfills legacy text case-insensitively and queues unmatched values', async () => {
    const schema = `managed_catalog_test_${crypto.randomUUID().replaceAll('-', '')}`;
    const client = await db.pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query('CREATE TABLE users (id UUID PRIMARY KEY)');
      await client.query(`CREATE TABLE listings (
        id UUID PRIMARY KEY, color VARCHAR(50), fabric_material VARCHAR(100), brand VARCHAR(100)
      )`);
      await client.query(`CREATE TABLE listing_revisions (
        id UUID PRIMARY KEY, proposed_color VARCHAR(50), proposed_fabric_material VARCHAR(100), proposed_brand VARCHAR(100)
      )`);
      const userId = crypto.randomUUID();
      const listingId = crypto.randomUUID();
      const revisionId = crypto.randomUUID();
      await client.query('INSERT INTO users (id) VALUES ($1)', [userId]);
      await client.query(
        `INSERT INTO listings (id, color, fabric_material, brand)
         VALUES ($1, 'nAvY bLuE', 'silK', 'Vintage House')`,
        [listingId]
      );
      await client.query(
        `INSERT INTO listing_revisions (id, proposed_color, proposed_fabric_material, proposed_brand)
         VALUES ($1, 'Electric Blue', NULL, NULL)`,
        [revisionId]
      );
      const migrationFile = path.join(__dirname, '../../db/migrations/015_managed_listing_attributes.sql');
      const migration = fs.readFileSync(migrationFile, 'utf8');
      await client.query(upSection(migration, path.basename(migrationFile)));

      const { rows: backfilledListings } = await client.query(
        `SELECT color.status AS color_status, fabric.status AS fabric_status, brand.status AS brand_status
         FROM listings listing
         JOIN managed_catalog_values color ON color.id = listing.color_id
         JOIN managed_catalog_values fabric ON fabric.id = listing.fabric_id
         JOIN managed_catalog_values brand ON brand.id = listing.brand_id
         WHERE listing.id = $1`,
        [listingId]
      );
      expect(backfilledListings[0]).toEqual({
        color_status: 'approved',
        fabric_status: 'approved',
        brand_status: 'pending_custom',
      });
      const { rows: backfilledRevision } = await client.query(
        `SELECT value.value, value.status FROM listing_revisions revision
         JOIN managed_catalog_values value ON value.id = revision.proposed_color_id
         WHERE revision.id = $1`,
        [revisionId]
      );
      expect(backfilledRevision[0]).toEqual({ value: 'Electric Blue', status: 'pending_custom' });
    } finally {
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
  });
});
