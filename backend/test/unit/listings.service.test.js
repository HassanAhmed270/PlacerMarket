jest.mock('../../src/db.service', () => ({
  withTransaction: jest.fn(),
}));
jest.mock('../../src/modules/catalog.service', () => ({
  assertNotRentalListing: jest.fn(),
  assertReplicaDisclosureIfNeeded: jest.fn(),
  listConditionTypes: jest.fn(() => ['brand_new', 'pre_owned', 'custom_made', 'replica']),
  listSubCategories: jest.fn(),
}));
jest.mock('../../src/modules/users.service', () => ({
  isIdVerificationRequired: jest.fn(),
  isIdVerified: jest.fn(),
  isApprovedSeller: jest.fn(),
}));

const db = require('../../src/db.service');
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
        .mockResolvedValueOnce({ rows: [{ count: 3 }] })
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
});
