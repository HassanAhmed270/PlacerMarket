const {
  listingUrlKey,
  canonicalListingUrl,
  parseListingUrlKey,
} = require('../../src/lib/listingUrls');

describe('FR-82c canonical listing URLs', () => {
  test('builds a slug and short ID key and parses it without treating the slug as identity', () => {
    const listing = { slug: 'navy-silk-dress', short_id: '123456789abc' };
    expect(listingUrlKey(listing)).toBe('navy-silk-dress-123456789abc');
    expect(canonicalListingUrl(listing, 'https://market.example/'))
      .toBe('https://market.example/listing/navy-silk-dress-123456789abc');
    expect(parseListingUrlKey('old-title-123456789abc')).toEqual({
      shortId: '123456789abc',
      requestedSlug: 'old-title',
    });
  });

  test('continues to accept legacy UUID listing keys', () => {
    expect(parseListingUrlKey('123e4567-e89b-42d3-a456-426614174000'))
      .toEqual({ listingId: '123e4567-e89b-42d3-a456-426614174000' });
    expect(parseListingUrlKey('not-a-listing-key')).toBeNull();
  });
});
