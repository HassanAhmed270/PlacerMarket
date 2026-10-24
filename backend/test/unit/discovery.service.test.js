jest.mock('../../src/db.service', () => ({
  read: jest.fn(),
  write: jest.fn(),
}));
jest.mock('../../src/modules/users.service', () => ({
  getSellerProfile: jest.fn(),
}));
jest.mock('../../src/modules/orders.service', () => ({
  getSellerRatingSummary: jest.fn(),
}));
jest.mock('../../src/modules/listings.service', () => ({
  getListingImages: jest.fn(),
}));

const db = require('../../src/db.service');
const users = require('../../src/modules/users.service');
const orders = require('../../src/modules/orders.service');
const listings = require('../../src/modules/listings.service');
const discovery = require('../../src/modules/discovery.service');

const listingId = '123e4567-e89b-42d3-a456-426614174000';
const sellerId = '123e4567-e89b-42d3-a456-426614174001';

describe('discovery.service public listings and favorites', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('FR-25, FR-27a: published detail includes price, live status, and only rating and join date for seller', async () => {
    db.read.mockResolvedValueOnce({ rows: [{
      id: listingId, seller_id: sellerId, status: 'published', title: 'Public item',
      asking_price: '125.00', has_reservation: false, has_completed_order: false,
      main_category_id: 'category-id', sub_category_id: 'subcategory-id',
    }] });
    users.getSellerProfile.mockResolvedValue({
      display_alias: 'must not leak', created_at: new Date('2025-01-01T00:00:00Z'),
      payout_wallet_number: 'must not leak', id_verified: true,
    });
    orders.getSellerRatingSummary.mockResolvedValue({ averageRating: 4.5, ratingCount: 2 });
    listings.getListingImages.mockResolvedValue([]);

    const detail = await discovery.getListingDetail(listingId);

    expect(detail).toMatchObject({
      asking_price: '125.00', status: 'available', liveStatus: 'available', available: true,
      seller: {
        joinDate: new Date('2025-01-01T00:00:00Z'), averageRating: 4.5, ratingCount: 2,
      },
    });
    expect(Object.keys(detail.seller).sort()).toEqual(['averageRating', 'joinDate', 'ratingCount']);
    expect(detail).not.toHaveProperty('seller_id');
    expect(detail.status).not.toBe('published');
  });

  test('FR-25: sold detail includes no more than six newest in-range same-sub-category items', async () => {
    db.read
      .mockResolvedValueOnce({ rows: [{
        id: listingId, seller_id: sellerId, status: 'sold', title: 'Sold item', asking_price: '100.00',
        sub_category_id: 'subcategory-id', has_reservation: false, has_completed_order: false,
      }] })
      .mockResolvedValueOnce({ rows: [{ id: 'similar-1', has_reservation: true }] });
    users.getSellerProfile.mockResolvedValue({ created_at: new Date() });
    orders.getSellerRatingSummary.mockResolvedValue({ averageRating: 0, ratingCount: 0 });
    listings.getListingImages.mockResolvedValue([]);

    const detail = await discovery.getListingDetail(listingId);

    expect(detail).toMatchObject({ sold: true, liveStatus: 'sold', similarItems: [{ id: 'similar-1', reserved: true }] });
    expect(db.read.mock.calls[1][0]).toContain('l.asking_price BETWEEN $3::numeric * 0.7 AND $3::numeric * 1.3');
    expect(db.read.mock.calls[1][0]).toContain('ORDER BY l.created_at DESC, l.id DESC');
    expect(db.read.mock.calls[1][0]).toContain('LIMIT 6');
    expect(db.read.mock.calls[1][1]).toEqual(['subcategory-id', listingId, '100.00', expect.any(Array)]);
  });

  test('FR-26: add/remove are safe to repeat and keyset pages use a deterministic cursor', async () => {
    db.read
      .mockResolvedValueOnce({ rows: [{
        id: listingId, status: 'published', has_reservation: false, has_completed_order: false,
        favorite_created_at: '2025-03-01T00:00:00.000123Z', title: 'Saved item',
      }, {
        id: '123e4567-e89b-42d3-a456-426614174002', status: 'published',
        has_reservation: false, has_completed_order: false,
        favorite_created_at: '2025-03-01T00:00:00.000122Z', title: 'Next saved item',
      }] })
      .mockResolvedValueOnce({ rows: [] });

    await discovery.addFavorite(sellerId, listingId);
    await discovery.addFavorite(sellerId, listingId);
    await discovery.removeFavorite(sellerId, listingId);
    await discovery.removeFavorite(sellerId, listingId);
    const firstPage = await discovery.getFavorites(sellerId, { limit: 1 });

    expect(db.write).toHaveBeenNthCalledWith(1,
      expect.stringContaining('ON CONFLICT (user_id, listing_id) DO NOTHING'), [sellerId, listingId]);
    expect(db.write).toHaveBeenNthCalledWith(2,
      expect.stringContaining('ON CONFLICT (user_id, listing_id) DO NOTHING'), [sellerId, listingId]);
    expect(db.write.mock.calls[2][0]).toContain('DELETE FROM favorites');
    expect(firstPage.items).toMatchObject([{ id: listingId, liveStatus: 'available' }]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(JSON.parse(Buffer.from(firstPage.nextCursor, 'base64url').toString('utf8'))).toEqual({
      createdAt: '2025-03-01T00:00:00.000123Z', listingId,
    });

    await discovery.getFavorites(sellerId, { limit: 1, cursor: firstPage.nextCursor });
    expect(db.read.mock.calls[1][0]).toContain('(f.created_at, f.listing_id) < ($2::timestamptz, $3::uuid)');
    expect(db.read.mock.calls[1][0]).toContain('ORDER BY f.created_at DESC, f.listing_id DESC');
    expect(db.read.mock.calls[1][1]).toEqual([sellerId, '2025-03-01T00:00:00.000123Z', listingId, expect.any(Array), 2]);
  });

  test('FR-26: malformed cursors and zero-size pages are rejected', async () => {
    await expect(discovery.getFavorites(sellerId, { cursor: 'not-a-cursor' })).rejects.toThrow('Invalid favorites cursor');
    await expect(discovery.getFavorites(sellerId, { limit: 0 })).rejects.toThrow('limit must be at least 1');
    expect(db.read).not.toHaveBeenCalled();
  });
});
