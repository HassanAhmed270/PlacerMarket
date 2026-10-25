const db = require('../../src/db.service');
const queue = require('../../src/lib/queue');
const listings = require('../../src/modules/listings.service');
const revisions = require('../../src/modules/listingRevisions.service');
const orders = require('../../src/modules/orders.service');
const snapshots = require('../../src/modules/pageSnapshots.service');
const request = require('supertest');
const app = require('../../src/app');
const { createFixture } = require('./fixtures');

describe('FR-81a, FR-82b PostgreSQL page snapshots', () => {
  let worker;
  let purger;
  let fixtures = [];

  beforeAll(async () => {
    worker = queue.createQueueClient({ connectionString: process.env.DATABASE_URL, worker: true });
    await worker.start();
    purger = { kind: 'live', purge: jest.fn().mockResolvedValue({ purged: 1 }) };
    await worker.boss.work(
      queue.QUEUES.PAGE_SNAPSHOTS,
      { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 0.5, notifyPollingIntervalSeconds: 0.5 },
      async ([job]) => {
        const result = await snapshots.processSnapshotJob(job.data);
        if (result.outcome === 'regenerated') await purger.purge(result.paths);
      }
    );
  });

  afterAll(async () => {
    if (worker) await worker.stop();
  });

  beforeEach(() => { fixtures = []; });

  afterEach(async () => {
    for (const fixture of fixtures) {
      await waitForSnapshotJobs(fixture.listingId);
      await db.query('DELETE FROM orders WHERE listing_id = $1', [fixture.listingId]);
      await db.query('DELETE FROM offers WHERE listing_id = $1', [fixture.listingId]);
      await db.query('DELETE FROM conversations WHERE listing_id = $1', [fixture.listingId]);
      await fixture.cleanup();
      await snapshots.processSnapshotJob({ listingId: fixture.listingId, searchVersion: '1' });
    }
  });

  async function publishedFixture(askingPrice = 100) {
    const fixture = await createFixture({ askingPrice, listingStatus: 'pending_review' });
    fixtures.push(fixture);
    for (const [slot, order] of [['front', 0], ['back', 1], ['other', 2]]) {
      await db.query(
        `INSERT INTO listing_images
           (listing_id, image_url, display_order, slot, processing_state, label_confirmed_at, social_key)
         VALUES ($1, $2, $3, $4, 'ready', now(), $5)`,
        [fixture.listingId, `https://images.invalid/${fixture.suffix}/${slot}.jpg`, order, slot,
          `ab/${fixture.suffix.padStart(64, '0').slice(-64)}/social`]
      );
    }
    await listings.approveListing(fixture.listingId, fixture.otherUserId);
    await waitForSnapshotJobs(fixture.listingId);
    return fixture;
  }

  async function waitForSnapshotJobs(listingId, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { rows } = await db.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE state NOT IN ('completed', 'failed'))::int AS pending,
                count(*) FILTER (WHERE state = 'failed')::int AS failed
         FROM pgboss.job WHERE name = $1 AND data->>'listingId' = $2`,
        [queue.QUEUES.PAGE_SNAPSHOTS, listingId]
      );
      if (rows[0].failed) throw new Error(`Page-snapshot job failed for listing ${listingId}.`);
      if (rows[0].total > 0 && rows[0].pending === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for page-snapshot jobs for listing ${listingId}.`);
  }

  async function snapshotForListing(listingId) {
    const { rows: listingRows } = await db.query('SELECT slug, short_id FROM listings WHERE id = $1', [listingId]);
    return db.query(
      'SELECT * FROM page_snapshots WHERE path = $1',
      [`/listing/${listingRows[0].slug}-${listingRows[0].short_id}`]
    );
  }

  function productJsonLd(html) {
    const [, rawJsonLd] = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    return JSON.parse(rawJsonLd).find((item) => item['@type'] === 'Product');
  }

  test('publish, price change, and revision approval regenerate HTML and structured prices from live values', async () => {
    const fixture = await publishedFixture(100);
    let { rows } = await snapshotForListing(fixture.listingId);
    expect(rows[0].html).toContain('<meta property="og:title"');
    expect(rows[0].html).toContain('social/'); // existing 1200x630 social variant
    expect(rows[0].noindex).toBe(false);
    expect(productJsonLd(rows[0].html).offers.price).toBe('100.00');
    const mainPath = `/category/fixture-main-${fixture.suffix}`;
    const subPath = `${mainPath}/fixture-sub-${fixture.suffix}`;
    const cityPath = `${subPath}/city/probe-city-${fixture.suffix}`;
    const { rows: taxonomyPages } = await db.query(
      'SELECT path, page_type, html FROM page_snapshots WHERE path = ANY($1::text[])',
      [['/', mainPath, subPath, cityPath]]
    );
    expect(taxonomyPages).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/', page_type: 'home' }),
      expect.objectContaining({ path: mainPath, page_type: 'main_category' }),
      expect.objectContaining({ path: subPath, page_type: 'sub_category' }),
      expect.objectContaining({ path: cityPath, page_type: 'category_city' }),
    ]));
    expect(taxonomyPages.find((page) => page.path === '/').html).toContain('"@type":"WebSite"');
    expect(taxonomyPages.find((page) => page.path === '/').html).toContain('"@type":"Organization"');

    const { rows: currentUrl } = await db.query('SELECT slug, short_id FROM listings WHERE id = $1', [fixture.listingId]);
    await request(app).get(`/listing/previous-title-${currentUrl[0].short_id}`)
      .expect(301).expect('Location', `/listing/${currentUrl[0].slug}-${currentUrl[0].short_id}`);

    await revisions.submitListingRevision(fixture.listingId, fixture.userId, { askingPrice: 90 });
    await waitForSnapshotJobs(fixture.listingId);
    ({ rows } = await snapshotForListing(fixture.listingId));
    expect(productJsonLd(rows[0].html).offers.price).toBe('90.00');

    const revision = await revisions.submitListingRevision(fixture.listingId, fixture.userId, {
      title: 'Approved snapshot title',
    });
    await revisions.approveListingRevision(revision.id, fixture.otherUserId);
    await waitForSnapshotJobs(fixture.listingId);
    ({ rows } = await snapshotForListing(fixture.listingId));
    expect(rows[0].html).toContain('Approved snapshot title');
    expect(productJsonLd(rows[0].html).offers.price).toBe('90.00');
    expect(purger.purge).toHaveBeenCalled();

    const response = await request(app).get(rows[0].path).expect(200);
    expect(response.headers['cache-control']).toContain('max-age=10');
    expect(response.text).toBe(rows[0].html);
    const filtered = await request(app).get(`/category/fixture-main-${fixture.suffix}?sort=price_asc`).expect(200);
    expect(filtered.headers['x-robots-tag']).toBe('noindex, follow');
    expect(filtered.text).toContain('noindex,follow');
  });

  test('sold and removed snapshots are noindex, absent from the sitemap, and follow the public 200/410 rules', async () => {
    const sold = await publishedFixture(120);
    const { rows: conversation } = await db.query(
      `INSERT INTO conversations (listing_id, buyer_id, seller_id) VALUES ($1, $2, $3) RETURNING id`,
      [sold.listingId, sold.otherUserId, sold.userId]
    );
    const { rows: offer } = await db.query(
      `INSERT INTO offers (conversation_id, listing_id, proposed_by, amount, status)
       VALUES ($1, $2, $3, 120, 'accepted') RETURNING id`,
      [conversation[0].id, sold.listingId, sold.otherUserId]
    );
    const { rows: order } = await db.query(
      `INSERT INTO orders
         (accepted_offer_id, listing_id, buyer_id, seller_id, agreed_item_price,
          delivery_address, payment_method_preference, status)
       VALUES ($1, $2, $3, $4, 120, '', 'cash', 'bag') RETURNING id`,
      [offer[0].id, sold.listingId, sold.otherUserId, sold.userId]
    );
    await orders.setOrderStatus(order[0].id, 'delivered');
    await waitForSnapshotJobs(sold.listingId);
    const { rows: soldRows } = await snapshotForListing(sold.listingId);
    expect(soldRows[0]).toMatchObject({ status_code: 200, noindex: true });
    expect(soldRows[0].html).toContain('<p>Sold</p>');
    expect(soldRows[0].html).toContain('<meta name="robots" content="noindex,follow">');
    expect(soldRows[0].html).toContain('Similar items');
    const soldPage = await request(app).get(soldRows[0].path).expect(200);
    expect(soldPage.headers['x-robots-tag']).toBe('noindex, follow');

    const removed = await publishedFixture(130);
    await listings.removeOwnListing(removed.listingId, removed.userId);
    await waitForSnapshotJobs(removed.listingId);
    const { rows: removedRows } = await snapshotForListing(removed.listingId);
    expect(removedRows[0]).toMatchObject({ status_code: 410, noindex: true });
    await request(app).get(removedRows[0].path).expect(410);

    const { rows: sitemapRows } = await db.query("SELECT html FROM page_snapshots WHERE path = '/sitemap.xml'");
    expect(sitemapRows[0].html).not.toContain(soldRows[0].path);
    expect(sitemapRows[0].html).not.toContain(removedRows[0].path);
    expect(sitemapRows[0].html).toContain('/category/fixture-main-');
    const robots = await request(app).get('/robots.txt').expect(200);
    expect(robots.text).toContain('Sitemap:');
  });
});
