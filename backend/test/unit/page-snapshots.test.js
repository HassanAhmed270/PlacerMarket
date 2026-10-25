const snapshots = require('../../src/modules/pageSnapshots.service');
const { createCdnPurger, createFakeCdnPurger } = require('../../src/lib/adapters/cdnPurger');
const queue = require('../../src/lib/queue');

function listing(overrides = {}) {
  return {
    id: '123e4567-e89b-42d3-a456-426614174000',
    short_id: '123e4567e89b',
    slug: 'bridal-suit',
    title: 'Seller title',
    description: 'Hand-stitched bridal suit',
    condition: 'replica',
    asking_price: '87500.00',
    status: 'published',
    seo_choice: 'custom',
    seo_title: 'Designer Bridal Suit',
    seo_description: 'Designer bridal suit in red.',
    main_category: 'Women',
    sub_category: 'Bridal',
    city_name: 'Lahore',
    brand: 'Example Brand',
    color: 'Red',
    fabric_material: 'Silk',
    image_id: 'image-id',
    social_key: 'ab/abcdef1234567890/social',
    ...overrides,
  };
}

describe('FR-81a, FR-82b public snapshots', () => {
  test('renders complete listing metadata, social image, replica title and live-price Product offer without ratings', () => {
    const html = snapshots.renderListingPage(listing(), { baseUrl: 'https://market.example' });
    expect(html).toContain('<title>Replica Designer Bridal Suit</title>');
    expect(html).toContain('<meta name="description" content="Designer bridal suit in red.">');
    expect(html).toContain('<link rel="canonical" href="https://market.example/listing/bridal-suit-123e4567e89b">');
    expect(html).toContain('property="og:image" content="https://market.example/api/media/images/image-id/social/abcdef1234567890.webp"');
    expect(html).toContain('og:image:width" content="1200"');
    const [, rawJsonLd] = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    const [product, breadcrumb] = JSON.parse(rawJsonLd);
    expect(product).toMatchObject({
      '@type': 'Product',
      name: 'Replica Seller title',
      brand: { '@type': 'Brand', name: 'Example Brand' },
      color: 'Red',
      itemCondition: 'https://schema.org/NewCondition',
      offers: {
        '@type': 'Offer',
        price: '87500.00',
        priceCurrency: 'PKR',
        availability: 'https://schema.org/InStock',
      },
    });
    expect(breadcrumb['@type']).toBe('BreadcrumbList');
    expect(html).not.toMatch(/aggregateRating|ratingValue|reviewCount/i);
  });

  test('applies the SEO noindex matrix to search, filtered pages and sold/paused/removed listings', () => {
    expect(snapshots.isNoindex({ pageType: 'home' })).toBe(false);
    expect(snapshots.isNoindex({ pageType: 'main_category' })).toBe(false);
    expect(snapshots.isNoindex({ pathname: '/search' })).toBe(true);
    for (const filter of ['sort=price_asc', 'minPrice=10', 'condition=replica', 'color=red', 'brand=label', 'fabric=silk']) {
      expect(snapshots.isNoindex({
        pathname: '/category/women/bridal',
        searchParams: new URLSearchParams(filter),
      })).toBe(true);
    }
    for (const status of ['sold', 'paused', 'removed', 'unpublished']) {
      expect(snapshots.isNoindex({ pageType: 'listing', status })).toBe(true);
      const html = snapshots.renderListingPage(listing({ status }), { baseUrl: 'https://market.example' });
      expect(html).toContain('<meta name="robots" content="noindex,follow">');
    }
  });

  test('sold pages select only the six newest same-sub-category items within thirty percent', () => {
    const choices = Array.from({ length: 7 }, (_value, index) => ({
      id: String(index),
      status: 'published',
      sub_category_id: 'sub-1',
      asking_price: '100',
    }));
    choices.push(
      { id: 'boundary-low', status: 'published', sub_category_id: 'sub-1', asking_price: '70' },
      { id: 'boundary-high', status: 'published', sub_category_id: 'sub-1', asking_price: '130' },
      { id: 'outside', status: 'published', sub_category_id: 'sub-1', asking_price: '131' },
      { id: 'other-sub', status: 'published', sub_category_id: 'sub-2', asking_price: '100' },
      { id: 'sold', status: 'sold', sub_category_id: 'sub-1', asking_price: '100' }
    );
    const sold = { sub_category_id: 'sub-1', asking_price: '100' };
    expect(snapshots.similarListings(sold, choices.slice(7, 9)).map(({ id }) => id))
      .toEqual(['boundary-low', 'boundary-high']);
    expect(snapshots.similarListings(sold, choices).map(({ id }) => id))
      .toEqual(['0', '1', '2', '3', '4', '5']);
  });

  test('rebuild queue requests are versioned, ordered, and share the listing transaction', async () => {
    const enqueue = jest.spyOn(queue, 'enqueue').mockResolvedValue('job-id');
    const client = { query: jest.fn() };
    try {
      await snapshots.enqueueListingSnapshotSync(client, listing().id, 9);
      expect(enqueue).toHaveBeenCalledWith(queue.QUEUES.PAGE_SNAPSHOTS, {
        listingId: listing().id, searchVersion: '9',
      }, expect.objectContaining({
        idempotencyKey: `listing:${listing().id}:9`,
        orderingKey: 'public-site-snapshots',
        transaction: client,
      }));
    } finally {
      enqueue.mockRestore();
    }
  });

  test('worker startup enqueues a full build so empty/new installs receive home and crawler snapshots', async () => {
    const enqueue = jest.spyOn(queue, 'enqueue').mockResolvedValue('startup-job');
    try {
      await snapshots.enqueueFullSnapshotRebuild();
      expect(enqueue).toHaveBeenCalledWith(queue.QUEUES.PAGE_SNAPSHOTS, { kind: 'full' }, expect.objectContaining({
        orderingKey: 'public-site-snapshots',
        idempotencyKey: expect.stringMatching(/^worker-startup:/),
      }));
    } finally {
      enqueue.mockRestore();
    }
  });

  test('fake CDN purge adapter records paths and production rejects fakes', async () => {
    const fake = createFakeCdnPurger();
    await fake.purge(['/listing/example', '/sitemap.xml']);
    expect(fake.getPurges()).toEqual([['/listing/example', '/sitemap.xml']]);
    expect(() => createCdnPurger({ adapter: fake, allowFake: true, production: true }))
      .toThrow('requires explicit non-production opt-in');
    await expect(fake.purge(['not-absolute'])).rejects.toThrow('absolute URL paths');
  });
});
