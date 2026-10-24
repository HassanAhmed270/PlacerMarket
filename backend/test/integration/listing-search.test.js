const db = require('../../src/db.service');
const queue = require('../../src/lib/queue');
const listings = require('../../src/modules/listings.service');
const revisions = require('../../src/modules/listingRevisions.service');
const orders = require('../../src/modules/orders.service');
const listingSearch = require('../../src/modules/listingSearch.service');
const { createFixture } = require('./fixtures');

describe('FR-80a listing search indexing on PostgreSQL', () => {
  let worker;
  let fixtures = [];

  beforeAll(async () => {
    worker = queue.createQueueClient({ connectionString: process.env.DATABASE_URL, worker: true });
    await worker.start();
    await worker.boss.work(
      queue.QUEUES.LISTING_SEARCH,
      { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 0.5, notifyPollingIntervalSeconds: 0.5 },
      async ([job]) => listingSearch.processListingSearchJob(job.data)
    );
  });

  afterAll(async () => {
    if (worker) await worker.stop();
  });

  beforeEach(() => { fixtures = []; });

  afterEach(async () => {
    for (const fixture of fixtures) {
      await waitForListingSearchJobs(fixture.listingId);
      await db.query('DELETE FROM orders WHERE listing_id = $1', [fixture.listingId]);
      await db.query('DELETE FROM offers WHERE listing_id = $1', [fixture.listingId]);
      await db.query('DELETE FROM conversations WHERE listing_id = $1', [fixture.listingId]);
      await db.query('DELETE FROM search_synonyms WHERE created_by = $1 OR updated_by = $1', [fixture.otherUserId]);
      await fixture.cleanup();
    }
  });

  async function makePublishedFixture({ askingPrice = 100 } = {}) {
    const fixture = await createFixture({ askingPrice, listingStatus: 'pending_review' });
    fixtures.push(fixture);
    for (const [slot, order] of [['front', 0], ['back', 1], ['other', 2]]) {
      await db.query(
        `INSERT INTO listing_images
           (listing_id, image_url, display_order, slot, processing_state, label_confirmed_at)
         VALUES ($1, $2, $3, $4, 'ready', now())`,
        [fixture.listingId, `https://images.invalid/${fixture.suffix}/${slot}.jpg`, order, slot]
      );
    }
    await listings.approveListing(fixture.listingId, fixture.otherUserId);
    await waitForListingSearchJobs(fixture.listingId);
    return fixture;
  }

  async function waitForListingSearchJobs(listingId, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { rows } = await db.query(
        `SELECT count(*) FILTER (WHERE state NOT IN ('completed', 'failed'))::int AS pending,
                count(*) FILTER (WHERE state = 'failed')::int AS failed
         FROM pgboss.job WHERE name = $1 AND data->>'listingId' = $2`,
        [queue.QUEUES.LISTING_SEARCH, listingId]
      );
      if (rows[0].failed) throw new Error(`Listing-search job failed for listing ${listingId}.`);
      if (rows[0].pending === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for listing-search jobs for listing ${listingId}.`);
  }

  async function indexedListing(listingId) {
    const { rows } = await db.query('SELECT * FROM listing_search WHERE listing_id = $1', [listingId]);
    return rows[0] || null;
  }

  test('admin synonym terms are normalized, editable, and removable', async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const terms = {
      sourceTerm: `shalwar ${fixture.suffix}`,
      targetTerm: `trousers ${fixture.suffix}`,
    };
    const created = await listingSearch.createSearchSynonym(terms, fixture.otherUserId);
    const duplicate = await listingSearch.createSearchSynonym({
      sourceTerm: terms.sourceTerm.toUpperCase(),
      targetTerm: terms.targetTerm.toUpperCase(),
    }, fixture.otherUserId);
    expect(duplicate.id).toBe(created.id);
    expect(await listingSearch.listSearchSynonyms()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.id })])
    );

    const updated = await listingSearch.updateSearchSynonym(created.id, {
      sourceTerm: `shalwar kameez ${fixture.suffix}`,
      targetTerm: `traditional dress ${fixture.suffix}`,
    }, fixture.otherUserId);
    expect(updated.sourceTerm).toBe(`shalwar kameez ${fixture.suffix}`);
    await listingSearch.deleteSearchSynonym(created.id);
    expect(await listingSearch.listSearchSynonyms()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.id })])
    );
  });

  test('publish and moderated price/attribute revisions enqueue versioned, idempotent updates', async () => {
    const fixture = await makePublishedFixture();
    const published = await indexedListing(fixture.listingId);
    expect(published).toMatchObject({
      listing_id: fixture.listingId,
      title: `Fixture listing ${fixture.suffix}`,
      asking_price: '100.00',
      is_reserved: false,
    });
    expect(published.search_vector).toBeTruthy();
    expect(published.search_text).toContain(fixture.suffix);

    const { rows: listingRows } = await db.query(
      'SELECT search_version FROM listings WHERE id = $1', [fixture.listingId]
    );
    const duplicate = await listingSearch.processListingSearchJob({
      listingId: fixture.listingId,
      searchVersion: listingRows[0].search_version,
    });
    expect(duplicate.outcome).toBe('indexed');
    expect(await indexedListing(fixture.listingId)).toMatchObject({ asking_price: '100.00' });

    await revisions.submitListingRevision(fixture.listingId, fixture.userId, { askingPrice: 90 });
    await waitForListingSearchJobs(fixture.listingId);
    expect(await indexedListing(fixture.listingId)).toMatchObject({ asking_price: '90.00' });

    const { rows: colorRows } = await db.query(
      `SELECT id FROM managed_catalog_values
       WHERE attribute_type = 'color' AND normalized_value = 'black' AND status = 'approved' LIMIT 1`
    );
    const revision = await revisions.submitListingRevision(fixture.listingId, fixture.userId, {
      title: 'Roman Urdu stitched suit',
      colorId: colorRows[0].id,
    });
    await revisions.approveListingRevision(revision.id, fixture.otherUserId);
    await waitForListingSearchJobs(fixture.listingId);
    const indexed = await indexedListing(fixture.listingId);
    expect(indexed).toMatchObject({ title: 'Roman Urdu stitched suit', color: 'Black' });
    expect(indexed.search_text).toContain('Black');
    expect(indexed.search_vector).toBeTruthy();
  });

  test('pause, resume, unpublish, and seller removal keep the index aligned with publication', async () => {
    const fixture = await makePublishedFixture();
    expect(await indexedListing(fixture.listingId)).not.toBeNull();
    const pendingRevision = await revisions.submitListingRevision(fixture.listingId, fixture.userId, {
      title: 'Approved while paused',
    });

    await listings.setOwnListingPaused(fixture.listingId, fixture.userId, true);
    await waitForListingSearchJobs(fixture.listingId);
    expect(await indexedListing(fixture.listingId)).toBeNull();
    await expect(revisions.approveListingRevision(pendingRevision.id, fixture.otherUserId))
      .resolves.toMatchObject({ status: 'approved' });
    await waitForListingSearchJobs(fixture.listingId);

    await listings.setOwnListingPaused(fixture.listingId, fixture.userId, false);
    await waitForListingSearchJobs(fixture.listingId);
    expect(await indexedListing(fixture.listingId)).toMatchObject({ title: 'Approved while paused' });

    await listings.rejectOrUnpublishListing(fixture.listingId, {
      reviewerId: fixture.otherUserId, reason: 'Search sync test',
    });
    await waitForListingSearchJobs(fixture.listingId);
    expect(await indexedListing(fixture.listingId)).toBeNull();

    const removable = await makePublishedFixture();
    await listings.removeOwnListing(removable.listingId, removable.userId);
    await waitForListingSearchJobs(removable.listingId);
    expect(await indexedListing(removable.listingId)).toBeNull();
  });

  test('checkout reservation is indexed and delivery marks the listing sold and removes it', async () => {
    const fixture = await makePublishedFixture();
    const { rows: conversationRows } = await db.query(
      `INSERT INTO conversations (listing_id, buyer_id, seller_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [fixture.listingId, fixture.otherUserId, fixture.userId]
    );
    const { rows: offerRows } = await db.query(
      `INSERT INTO offers (conversation_id, listing_id, proposed_by, amount, status)
       VALUES ($1, $2, $3, 100, 'accepted') RETURNING id`,
      [conversationRows[0].id, fixture.listingId, fixture.otherUserId]
    );
    const { rows: orderRows } = await db.query(
      `INSERT INTO orders
         (accepted_offer_id, listing_id, buyer_id, seller_id, agreed_item_price,
          delivery_address, payment_method_preference, status)
       VALUES ($1, $2, $3, $4, 100, '', 'cash', 'bag') RETURNING id`,
      [offerRows[0].id, fixture.listingId, fixture.otherUserId, fixture.userId]
    );

    await orders.checkoutFromBag(orderRows[0].id, fixture.otherUserId, {
      deliveryAddress: 'Integration test address',
      paymentMethodPreference: 'cash',
      deliveryFee: 0,
    });
    await waitForListingSearchJobs(fixture.listingId);
    expect(await indexedListing(fixture.listingId)).toMatchObject({ is_reserved: true });

    await orders.setOrderStatus(orderRows[0].id, 'handed_to_delivery');
    await waitForListingSearchJobs(fixture.listingId);
    expect(await indexedListing(fixture.listingId)).toMatchObject({ is_reserved: true });
    await orders.setOrderStatus(orderRows[0].id, 'out_for_delivery');
    await waitForListingSearchJobs(fixture.listingId);
    expect(await indexedListing(fixture.listingId)).toMatchObject({ is_reserved: true });

    await orders.setOrderStatus(orderRows[0].id, 'delivered');
    await waitForListingSearchJobs(fixture.listingId);
    expect(await indexedListing(fixture.listingId)).toBeNull();
    const { rows: listingRows } = await db.query('SELECT status FROM listings WHERE id = $1', [fixture.listingId]);
    expect(listingRows[0].status).toBe('sold');
  });

  test('concurrent publish/unpublish uses version checks and the rebuild reflects live published rows', async () => {
    const fixture = await createFixture({ listingStatus: 'pending_review' });
    fixtures.push(fixture);
    for (const [slot, order] of [['front', 0], ['back', 1], ['other', 2]]) {
      await db.query(
        `INSERT INTO listing_images
           (listing_id, image_url, display_order, slot, processing_state, label_confirmed_at)
         VALUES ($1, $2, $3, $4, 'ready', now())`,
        [fixture.listingId, `https://images.invalid/${fixture.suffix}/${slot}.jpg`, order, slot]
      );
    }

    const result = await Promise.allSettled([
      listings.approveListing(fixture.listingId, fixture.otherUserId),
      listings.rejectOrUnpublishListing(fixture.listingId, {
        reviewerId: fixture.otherUserId, reason: 'Concurrent unpublish',
      }),
    ]);
    expect(result.some((item) => item.status === 'fulfilled')).toBe(true);
    await waitForListingSearchJobs(fixture.listingId);
    const { rows: statusRows } = await db.query('SELECT status FROM listings WHERE id = $1', [fixture.listingId]);
    expect(['rejected', 'unpublished']).toContain(statusRows[0].status);
    expect(await indexedListing(fixture.listingId)).toBeNull();

    const published = await makePublishedFixture();
    await db.query(
      `UPDATE listings SET title = 'Rebuilt search title', search_version = search_version + 1
       WHERE id = $1`,
      [published.listingId]
    );
    const resultRebuild = await listingSearch.rebuildListingSearch();
    expect(resultRebuild.indexed).toBe(1);
    const indexed = await indexedListing(published.listingId);
    expect(indexed.title).toBe('Rebuilt search title');
    expect(indexed.search_text).toContain('Rebuilt search title');
    expect((await indexedListing(fixture.listingId))).toBeNull();

    await db.query('DELETE FROM listing_search WHERE listing_id = $1', [published.listingId]);
    const missingIndexSweep = await listingSearch.reconcileListingSearch();
    expect(missingIndexSweep.enqueued).toBe(1);
    await waitForListingSearchJobs(published.listingId);
    expect(await indexedListing(published.listingId)).toMatchObject({ title: 'Rebuilt search title' });

    await db.query(
      'UPDATE listings SET search_version = search_version + 1 WHERE id = $1',
      [published.listingId]
    );
    const reconciliation = await listingSearch.reconcileListingSearch();
    expect(reconciliation.enqueued).toBe(1);
    await waitForListingSearchJobs(published.listingId);
    const { rows: current } = await db.query(
      'SELECT search_version FROM listings WHERE id = $1', [published.listingId]
    );
    expect((await indexedListing(published.listingId)).search_version).toBe(current[0].search_version);
  });
});
