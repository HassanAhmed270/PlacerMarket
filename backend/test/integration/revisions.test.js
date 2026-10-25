jest.mock('../../src/middleware/rateLimit', () => ({
  createConfiguredRateLimiters: () => new Proxy({}, {
    get: () => (_req, _res, next) => next(),
  }),
  createRateLimiter: () => (_req, _res, next) => next(),
}));

const db = require('../../src/db.service');
const request = require('supertest');
const app = require('../../src/app');
const revisions = require('../../src/modules/listingRevisions.service');
const discovery = require('../../src/modules/discovery.service');
const negotiation = require('../../src/modules/negotiation.service');
const orders = require('../../src/modules/orders.service');
const { ForbiddenError, ValidationError } = require('../../src/lib/errors');
const { signAccessToken } = require('../../src/lib/jwt');
const { createFixture } = require('./fixtures');

describe('FR-73 moderated listing revisions', () => {
  let fixture;
  beforeEach(async () => {
    fixture = await createFixture();
    await db.query("UPDATE listings SET status = 'published', published_at = now(), title = 'Public title', asking_price = 100, content_version = 1 WHERE id = $1", [fixture.listingId]);
  });
  afterEach(async () => { if (fixture) await fixture.cleanup(); });

  test('FR-73e: a decrease at the 30 percent boundary applies immediately with one audit revision', async () => {
    const { rows: setting } = await db.query(
      "SELECT value FROM platform_settings WHERE key = 'instant_price_decrease_max_percent'"
    );
    expect(setting[0].value).toBe('30');
    const result = await revisions.submitListingRevision(fixture.listingId, fixture.userId, { askingPrice: 70 });
    expect(result).toMatchObject({ status: 'approved', base_content_version: '1' });
    expect(result.reviewed_at).toBeTruthy();
    const { rows } = await db.query(
      'SELECT asking_price, content_version FROM listings WHERE id = $1', [fixture.listingId]
    );
    expect(rows[0]).toMatchObject({ asking_price: '70.00', content_version: '2' });
    const { rows: audit } = await db.query(
      'SELECT status, proposed_asking_price FROM listing_revisions WHERE id = $1', [result.id]
    );
    expect(audit[0]).toMatchObject({ status: 'approved', proposed_asking_price: '70.00' });
  });

  test('FR-73e: a 90 percent decrease remains pending moderation', async () => {
    const result = await revisions.submitListingRevision(fixture.listingId, fixture.userId, { askingPrice: 10 });
    expect(result).toMatchObject({ status: 'pending_review', base_content_version: '1' });
    const { rows } = await db.query(
      'SELECT asking_price, content_version FROM listings WHERE id = $1', [fixture.listingId]
    );
    expect(rows[0]).toMatchObject({ asking_price: '100.00', content_version: '1' });
  });

  test('FR-73e: a concurrent instant decrease and revision submission have a consistent content version', async () => {
    const results = await Promise.allSettled([
      revisions.submitListingRevision(fixture.listingId, fixture.userId, { askingPrice: 70 }),
      revisions.submitListingRevision(fixture.listingId, fixture.userId, { description: 'Revised description' }),
    ]);
    const decrease = results[0];
    const revision = results[1];
    const { rows: listingRows } = await db.query(
      'SELECT asking_price, content_version FROM listings WHERE id = $1', [fixture.listingId]
    );
    const { rows: pendingRows } = await db.query(
      "SELECT base_content_version FROM listing_revisions WHERE listing_id = $1 AND status = 'pending_review'",
      [fixture.listingId]
    );

    if (decrease.status === 'fulfilled') {
      expect(revision.status).toBe('fulfilled');
      expect(decrease.value.status).toBe('approved');
      expect(listingRows[0]).toMatchObject({ asking_price: '70.00', content_version: '2' });
      expect(pendingRows).toHaveLength(1);
      expect(pendingRows[0].base_content_version).toBe('2');
    } else {
      expect(decrease.reason.statusCode).toBe(409);
      expect(revision.status).toBe('fulfilled');
      expect(revision.value.status).toBe('pending_review');
      expect(listingRows[0]).toMatchObject({ asking_price: '100.00', content_version: '1' });
      expect(pendingRows).toHaveLength(1);
      expect(pendingRows[0].base_content_version).toBe('1');
    }
  });

  test('FR-29: offers are disabled by default and accepting one never creates a bag entry', async () => {
    const previousFlag = process.env.OFFERS_ENABLED;
    const previousJwtSecret = process.env.JWT_ACCESS_SECRET;
    delete process.env.OFFERS_ENABLED;
    process.env.JWT_ACCESS_SECRET = 'integration-offers-disabled-jwt-secret-at-least-32-bytes';
    let conversation;
    let offerId;
    let createBagEntry;
    try {
      conversation = await negotiation.startConversation(fixture.listingId, fixture.otherUserId);
      const { rows: offerRows } = await db.query(
        `INSERT INTO offers (conversation_id, listing_id, proposed_by, amount, status)
         VALUES ($1, $2, $3, 50, 'pending') RETURNING id`,
        [conversation.id, fixture.listingId, fixture.otherUserId]
      );
      offerId = offerRows[0].id;
      const token = signAccessToken(fixture.otherUserId, { secret: process.env.JWT_ACCESS_SECRET });
      createBagEntry = jest.spyOn(orders, 'createBagEntry');
      for (const [path, body] of [
        [`/api/negotiation/conversations/${conversation.id}/offers`, { listingId: fixture.listingId, amount: 50 }],
        [`/api/negotiation/offers/${offerId}/counter`, { amount: 50 }],
        [`/api/negotiation/offers/${offerId}/accept`, {}],
      ]) {
        const response = await request(app).post(path).set('Authorization', `Bearer ${token}`).send(body);
        expect(response.status).toBe(503);
        expect(response.body).toEqual({ error: 'Offers are disabled' });
      }
      await expect(negotiation.acceptOffer(offerId, fixture.otherUserId))
        .rejects.toThrow('Offers are disabled');
      expect(createBagEntry).not.toHaveBeenCalled();
    } finally {
      if (createBagEntry) createBagEntry.mockRestore();
      if (offerId) await db.query('DELETE FROM offers WHERE id = $1', [offerId]);
      if (conversation) await db.query('DELETE FROM conversations WHERE id = $1', [conversation.id]);
      if (previousFlag === undefined) delete process.env.OFFERS_ENABLED;
      else process.env.OFFERS_ENABLED = previousFlag;
      if (previousJwtSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = previousJwtSecret;
    }
  });

  test('FR-73: one pending revision keeps public data unchanged; concurrent submissions serialize and seller can withdraw/resubmit', async () => {
    const results = await Promise.allSettled([
      revisions.submitListingRevision(fixture.listingId, fixture.userId, { title: 'Pending title', askingPrice: 120 }),
      revisions.submitListingRevision(fixture.listingId, fixture.userId, { description: 'Pending description' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected' && result.reason.statusCode === 409)).toHaveLength(1);
    const pending = results.find((result) => result.status === 'fulfilled').value;
    const detail = await discovery.getListingDetail(fixture.listingId);
    expect(detail.title).toBe('Public title');
    expect(JSON.stringify(detail)).not.toContain(pending.id);
    await expect(revisions.getSellerRevisionHistory(fixture.listingId, fixture.otherUserId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(revisions.withdrawListingRevision(pending.id, fixture.otherUserId)).rejects.toBeInstanceOf(ForbiddenError);
    const withdrawn = await revisions.withdrawListingRevision(pending.id, fixture.userId);
    expect(withdrawn.status).toBe('withdrawn');
    await expect(revisions.submitListingRevision(fixture.listingId, fixture.userId, { askingPrice: 130 }))
      .resolves.toMatchObject({ status: 'pending_review', proposed_asking_price: '130.00' });
  });

  test('FR-73, FR-73e: approval updates public content once, checks current threshold and rejects stale versions', async () => {
    const revision = await revisions.submitListingRevision(fixture.listingId, fixture.userId, { title: 'Approved title', askingPrice: 101 });
    await db.query('UPDATE listings SET content_version = content_version + 1 WHERE id = $1', [fixture.listingId]);
    await expect(revisions.approveListingRevision(revision.id, fixture.otherUserId)).rejects.toThrow('changed after this revision');
    await db.query('UPDATE listings SET content_version = content_version - 1 WHERE id = $1', [fixture.listingId]);
    const approved = await revisions.approveListingRevision(revision.id, fixture.otherUserId);
    expect(approved).toMatchObject({ status: 'approved', reviewed_by: fixture.otherUserId });
    const { rows: notificationJobs } = await db.query(
      "SELECT id FROM pgboss.job WHERE name = 'notifications' AND data->>'eventName' = 'listing_revision.decided' AND data->'payload'->>'revisionId' = $1",
      [revision.id]
    );
    expect(notificationJobs).toHaveLength(1);
    const { rows } = await db.query('SELECT title, asking_price, content_version FROM listings WHERE id = $1', [fixture.listingId]);
    expect(rows[0]).toMatchObject({ title: 'Approved title', asking_price: '101.00', content_version: '2' });
    await expect(revisions.approveListingRevision(revision.id, fixture.otherUserId)).rejects.toThrow('already been decided');
  });

  test('FR-73e, FR-15a: approval rechecks email verification and active measurement definitions', async () => {
    const { rows: threshold } = await db.query("SELECT value::numeric AS value FROM platform_settings WHERE key = 'high_value_threshold_pkr'");
    await db.query('UPDATE users SET email_verified_at = NULL WHERE id = $1', [fixture.userId]);
    const revision = await revisions.submitListingRevision(fixture.listingId, fixture.userId, {
      title: 'Above threshold', askingPrice: Number(threshold[0].value) + 0.01,
      measurements: [{ fieldDefId: fixture.fieldDefId, value: 40 }],
    });
    await expect(revisions.approveListingRevision(revision.id, fixture.otherUserId)).rejects.toBeInstanceOf(ForbiddenError);
    await db.query('UPDATE measurement_field_defs SET is_active = false WHERE id = $1', [fixture.fieldDefId]);
    await db.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [fixture.userId]);
    await expect(revisions.approveListingRevision(revision.id, fixture.otherUserId))
      .rejects.toThrow('is inactive; correct the measurements');
    const { rows: unchanged } = await db.query('SELECT title, content_version FROM listings WHERE id = $1', [fixture.listingId]);
    expect(unchanged[0]).toMatchObject({ title: 'Public title', content_version: '1' });
  });

  test('FR-73: rejection records reviewer and reason without changing the public row', async () => {
    const revision = await revisions.submitListingRevision(fixture.listingId, fixture.userId, { description: 'Alternative' });
    const rejected = await revisions.rejectListingRevision(revision.id, fixture.otherUserId, 'Keep the current description');
    expect(rejected).toMatchObject({ status: 'rejected', reviewed_by: fixture.otherUserId, rejection_reason: 'Keep the current description' });
    const { rows } = await db.query('SELECT title, description, asking_price, content_version FROM listings WHERE id = $1', [fixture.listingId]);
    expect(rows[0]).toMatchObject({ title: 'Public title', content_version: '1' });
  });

  test('FR-82: custom SEO text remains pending until its listing revision is approved', async () => {
    const revision = await revisions.submitListingRevision(fixture.listingId, fixture.userId, {
      seoChoice: 'custom',
      seoTitle: 'Navy festive attire',
      seoDescription: 'A pre-owned navy outfit for celebrations.',
    });
    expect(revision).toMatchObject({
      status: 'pending_review',
      proposed_seo_choice: 'custom',
      proposed_seo_title: 'Navy festive attire',
    });

    const { rows: pendingListing } = await db.query(
      'SELECT seo_choice, seo_title, seo_description FROM listings WHERE id = $1',
      [fixture.listingId]
    );
    expect(pendingListing[0]).toMatchObject({
      seo_choice: 'recommended',
      seo_title: null,
      seo_description: null,
    });

    await revisions.approveListingRevision(revision.id, fixture.otherUserId);
    const { rows: approvedListing } = await db.query(
      'SELECT seo_choice, seo_title, seo_description FROM listings WHERE id = $1',
      [fixture.listingId]
    );
    expect(approvedListing[0]).toEqual({
      seo_choice: 'custom',
      seo_title: 'Navy festive attire',
      seo_description: 'A pre-owned navy outfit for celebrations.',
    });
    const detail = await discovery.getListingDetail(fixture.listingId);
    expect(detail.seo).toMatchObject({
      recommendation: { title: expect.any(String), description: expect.any(String) },
      choice: {
        type: 'custom',
        title: 'Navy festive attire',
        description: 'A pre-owned navy outfit for celebrations.',
      },
      note: expect.stringMatching(/recommendation based on the seller's details/i),
    });
  });

  test('FR-73: concurrent moderator approve/reject decisions produce exactly one transition', async () => {
    const revision = await revisions.submitListingRevision(fixture.listingId, fixture.userId, { title: 'One decision' });
    const results = await Promise.allSettled([
      revisions.approveListingRevision(revision.id, fixture.otherUserId),
      revisions.rejectListingRevision(revision.id, fixture.otherUserId, 'Not acceptable'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected' && result.reason.statusCode === 409)).toHaveLength(1);
    const { rows } = await db.query('SELECT status, count(*) OVER ()::int AS row_count FROM listing_revisions WHERE id = $1', [revision.id]);
    expect(rows).toHaveLength(1);
    expect(['approved', 'rejected']).toContain(rows[0].status);
  });

  test('FR-73: injected mid-approval failure rolls back live listing, measurements, and revision status', async () => {
    const revision = await revisions.submitListingRevision(fixture.listingId, fixture.userId, { title: 'Must roll back' });
    const suffix = Math.random().toString(16).slice(2, 10);
    const fn = `fail_revision_${suffix}`;
    const trigger = `fail_revision_trigger_${suffix}`;
    await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'approved' THEN RAISE EXCEPTION 'injected revision transition failure'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON listing_revisions FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      await expect(revisions.approveListingRevision(revision.id, fixture.otherUserId)).rejects.toThrow('injected revision transition failure');
      const { rows: current } = await db.query('SELECT title, content_version FROM listings WHERE id = $1', [fixture.listingId]);
      expect(current[0]).toMatchObject({ title: 'Public title', content_version: '1' });
      const { rows: stored } = await db.query('SELECT status FROM listing_revisions WHERE id = $1', [revision.id]);
      expect(stored[0].status).toBe('pending_review');
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON listing_revisions`);
      await db.query(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  });

  test('FR-73/SEC-12: seller history is owner-scoped and moderation routes use listing permissions', async () => {
    const previousSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = 'integration-listing-revision-jwt-secret-at-least-32-bytes';
    try {
      const revision = await revisions.submitListingRevision(fixture.listingId, fixture.userId, { description: 'Private proposal' });
      const sellerToken = signAccessToken(fixture.userId, { secret: process.env.JWT_ACCESS_SECRET });
      const otherToken = signAccessToken(fixture.otherUserId, { secret: process.env.JWT_ACCESS_SECRET });
      await request(app).get(`/api/listings/${fixture.listingId}/revisions`).set('Authorization', `Bearer ${sellerToken}`).expect(200);
      await request(app).get(`/api/listings/${fixture.listingId}/revisions`).set('Authorization', `Bearer ${otherToken}`).expect(403);
      await request(app).post(`/api/listings/revisions/${revision.id}/approve`).set('Authorization', `Bearer ${sellerToken}`).expect(403);
      await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [fixture.otherUserId]);
      const adminToken = signAccessToken(fixture.otherUserId, { secret: process.env.JWT_ACCESS_SECRET });
      await request(app).post(`/api/listings/revisions/${revision.id}/approve`).set('Authorization', `Bearer ${adminToken}`).expect(200);
    } finally {
      if (previousSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = previousSecret;
    }
  });

  test('FR-73e: equality does not require email; approval uses the latest threshold', async () => {
    const { rows: settings } = await db.query("SELECT value FROM platform_settings WHERE key = 'high_value_threshold_pkr'");
    const previous = settings[0].value;
    try {
      await db.query("UPDATE platform_settings SET value = '101' WHERE key = 'high_value_threshold_pkr'");
      await db.query('UPDATE users SET email_verified_at = NULL WHERE id = $1', [fixture.userId]);
      const equal = await revisions.submitListingRevision(fixture.listingId, fixture.userId, { askingPrice: 101 });
      await revisions.approveListingRevision(equal.id, fixture.otherUserId);
      await db.query("UPDATE listings SET content_version = content_version + 1 WHERE id = $1", [fixture.listingId]);
      const nowHigh = await revisions.submitListingRevision(fixture.listingId, fixture.userId, { askingPrice: 150 });
      await db.query("UPDATE platform_settings SET value = '140' WHERE key = 'high_value_threshold_pkr'");
      await expect(revisions.approveListingRevision(nowHigh.id, fixture.otherUserId)).rejects.toBeInstanceOf(ForbiddenError);
      await db.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [fixture.userId]);
      await revisions.approveListingRevision(nowHigh.id, fixture.otherUserId);
    } finally {
      await db.query("UPDATE platform_settings SET value = $1 WHERE key = 'high_value_threshold_pkr'", [previous]);
    }
  });

  test('FR-73: production flag defaults off and category changes are not accepted', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousFlag = process.env.LISTING_REVISIONS_ENABLED;
    process.env.NODE_ENV = 'production';
    delete process.env.LISTING_REVISIONS_ENABLED;
    try {
      await expect(revisions.submitListingRevision(fixture.listingId, fixture.userId, { title: 'No' }))
        .rejects.toThrow('disabled by the production feature flag');
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
      if (previousFlag === undefined) delete process.env.LISTING_REVISIONS_ENABLED; else process.env.LISTING_REVISIONS_ENABLED = previousFlag;
    }
    await expect(revisions.submitListingRevision(fixture.listingId, fixture.userId, { mainCategoryId: fixture.categoryId }))
      .rejects.toThrow('Unsupported revision field');
  });
});
