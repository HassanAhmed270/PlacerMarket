jest.mock('../../src/db.service', () => ({
  withTransaction: jest.fn(),
}));
jest.mock('../../src/modules/catalog.service', () => ({
  assertNotRentalListing: jest.fn(),
  assertReplicaDisclosureIfNeeded: jest.fn(),
  getMeasurementFieldDefs: jest.fn(),
  lockSubCategoryForListing: jest.fn(),
  resolveListingAttribute: jest.fn(async (_client, _type, id, value) => {
    if (!id && !value) return null;
    return { id: id || 'attribute-id', value: value || 'Approved value' };
  }),
  listConditionTypes: jest.fn(() => ['brand_new', 'pre_owned', 'custom_made', 'replica']),
  listSubCategories: jest.fn(),
}));
jest.mock('../../src/modules/users.service', () => ({
  isIdVerificationRequired: jest.fn(),
  isIdVerified: jest.fn(),
  isApprovedSeller: jest.fn(),
}));

const db = require('../../src/db.service');
const catalog = require('../../src/modules/catalog.service');
const users = require('../../src/modules/users.service');
const listings = require('../../src/modules/listings.service');
const { ForbiddenError } = require('../../src/lib/errors');

describe('listings.service submission flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    users.isIdVerificationRequired.mockResolvedValue(false);
    users.isApprovedSeller.mockResolvedValue(true);
  });

  test('FR-19: seller submission checks ownership, photos, and moves a draft into review', async () => {
    const listing = {
      id: 'listing-1', seller_id: 'seller-1', status: 'draft', asking_price: '10.00',
    };
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [listing] })
        .mockResolvedValueOnce({ rows: [{ count: 3, unprocessed: 0, front: 1, back: 1, other: 1 }] })
        .mockResolvedValueOnce({ rows: [{ ...listing, status: 'pending_review', requires_id_verification: false }] }),
    };
    db.withTransaction.mockImplementation((callback) => callback(client));

    const submitted = await listings.submitListingForReview('listing-1', 'seller-1');

    expect(submitted.status).toBe('pending_review');
    expect(users.isApprovedSeller).toHaveBeenCalledWith('seller-1');
    expect(users.isIdVerificationRequired).toHaveBeenCalledWith('10.00');
    expect(client.query).toHaveBeenNthCalledWith(1, expect.stringContaining('FOR UPDATE'), ['listing-1']);
    expect(client.query).toHaveBeenNthCalledWith(2, expect.stringContaining('FROM listing_images'), ['listing-1']);
    expect(client.query).toHaveBeenNthCalledWith(
      3, expect.stringContaining("status = 'pending_review'"), [false, 'listing-1']
    );
  });

  test('FR-08: seller submission is refused when approval is inactive', async () => {
    users.isApprovedSeller.mockResolvedValue(false);

    await expect(listings.submitListingForReview('listing-1', 'seller-1'))
      .rejects.toBeInstanceOf(ForbiddenError);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('FR-15: createListing validates a non-empty bounded title and rejects retired fields', async () => {
    await expect(listings.createListing('seller-1', {
      title: ' '.repeat(2), mainCategoryId: 'main', subCategoryId: 'sub', condition: 'brand_new', askingPrice: 10,
    })).rejects.toThrow('title is required');
    await expect(listings.createListing('seller-1', {
      title: 'x'.repeat(151), mainCategoryId: 'main', subCategoryId: 'sub', condition: 'brand_new', askingPrice: 10,
    })).rejects.toThrow('150 characters');
    await expect(listings.createListing('seller-1', {
      title: 'Valid title', mainCategoryId: 'main', subCategoryId: 'sub', condition: 'brand_new', askingPrice: 10,
      listingType: 'sale',
    })).rejects.toThrow('Unsupported or retired listing field: listingType');
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('FR-15a: createListing resolves either field name or definition ID and rejects ambiguous selectors', async () => {
    catalog.getMeasurementFieldDefs.mockResolvedValue([
      { id: 'field-1', field_name: 'chest', required: true, is_active: true },
      { id: 'field-2', field_name: 'sleeve', required: false, is_active: true },
    ]);
    const client = { query: jest.fn((sql) => Promise.resolve({
      rows: String(sql).includes('INSERT INTO listings') ? [{ id: 'listing-1' }] : [],
    })) };
    db.withTransaction.mockImplementation((callback) => callback(client));
    await listings.createListing('seller-1', {
      title: ' Listing title ', mainCategoryId: 'main', subCategoryId: 'sub', condition: 'brand_new', askingPrice: 10,
      measurements: [{ fieldDefId: 'field-1', value: 40 }, { fieldName: 'sleeve', value: 20 }],
    });
    expect(client.query.mock.calls[0][1][4]).toBe('Listing title');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO listing_measurements'), ['listing-1', 'field-1', 40]);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO listing_measurements'), ['listing-1', 'field-2', 20]);

    await expect(listings.createListing('seller-1', {
      title: 'Another title', mainCategoryId: 'main', subCategoryId: 'sub', condition: 'brand_new', askingPrice: 10,
      measurements: [{ fieldName: 'chest', fieldDefId: 'field-1', value: 40 }],
    })).rejects.toThrow('exactly one of fieldName or fieldDefId');
  });

  test('FR-15a: createListing rejects unknown and inactive measurement definitions', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'listing-1' }] }) };
    db.withTransaction.mockImplementation((callback) => callback(client));
    catalog.getMeasurementFieldDefs.mockResolvedValueOnce([
      { id: 'field-1', field_name: 'chest', required: false, is_active: true },
    ]);
    const input = { title: 'Valid title', mainCategoryId: 'main', subCategoryId: 'sub', condition: 'brand_new', askingPrice: 10 };
    await expect(listings.createListing('seller-1', { ...input, measurements: [{ fieldName: 'unknown', value: 1 }] }))
      .rejects.toThrow('Unknown measurement field');
    catalog.getMeasurementFieldDefs.mockResolvedValueOnce([
      { id: 'field-1', field_name: 'chest', required: false, is_active: false },
    ]);
    await expect(listings.createListing('seller-1', { ...input, measurements: [{ fieldDefId: 'field-1', value: 1 }] }))
      .rejects.toThrow('is inactive');
  });
});
