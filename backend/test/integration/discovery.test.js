const request = require('supertest');
const db = require('../../src/db.service');
const app = require('../../src/app');
const { signAccessToken } = require('../../src/lib/jwt');
const { createFixture } = require('./fixtures');

let fixture;
let previousJwtSecret;
let previousPublicBaseUrl;

beforeEach(async () => {
  fixture = await createFixture({ askingPrice: 100 });
  previousJwtSecret = process.env.JWT_ACCESS_SECRET;
  previousPublicBaseUrl = process.env.PUBLIC_BASE_URL;
});

afterEach(async () => {
  try {
    if (fixture) await fixture.cleanup();
  } finally {
    if (previousJwtSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = previousJwtSecret;
    if (previousPublicBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousPublicBaseUrl;
  }
});

async function createPublishedListing(title, price, createdAt) {
  const { rows } = await db.query(
    `INSERT INTO listings
       (seller_id, main_category_id, sub_category_id, condition, title, asking_price, status, created_at)
     VALUES ($1, $2, $3, 'brand_new', $4, $5, 'published', $6)
     RETURNING id`,
    [fixture.userId, fixture.categoryId, fixture.subCategoryId, title, price, createdAt]
  );
  return rows[0].id;
}

function authenticateAsFixtureSeller() {
  const secret = 'integration-discovery-access-secret-with-32-bytes';
  process.env.JWT_ACCESS_SECRET = secret;
  return signAccessToken(fixture.userId, { secret });
}

describe('FR-22 through FR-27 public discovery', () => {
  test('FR-82c: canonical listing detail redirects an old slug and returns SEO recommendation and choice', async () => {
    process.env.PUBLIC_BASE_URL = 'https://market.example';
    await db.query(
      "UPDATE listings SET status = 'published', title = 'Current Navy Dress' WHERE id = $1",
      [fixture.listingId]
    );
    const { rows } = await db.query(
      'SELECT slug, short_id FROM listings WHERE id = $1', [fixture.listingId]
    );
    const oldKey = `previous-title-${rows[0].short_id}`;
    const currentKey = `${rows[0].slug}-${rows[0].short_id}`;

    const redirect = await request(app)
      .get(`/api/discovery/listings/${oldKey}`)
      .redirects(0)
      .expect(301);
    expect(redirect.headers.location).toBe(`/api/discovery/listings/${currentKey}`);

    const detail = await request(app).get(redirect.headers.location).expect(200);
    expect(detail.body).toMatchObject({
      canonicalKey: currentKey,
      canonicalUrl: `https://market.example/listing/${currentKey}`,
      seo: {
        recommendation: { title: expect.any(String), description: expect.any(String) },
        choice: { type: 'recommended' },
        note: expect.stringMatching(/recommendation based on the seller's details/i),
      },
    });
    expect(detail.body.seo.choice.description).not.toMatch(/PKR|Rs\.?/i);
  });

  test('FR-22, FR-25: listing status/detail distinguish available, paused, sold, reserved and removed states', async () => {
    await db.query("UPDATE listings SET status = 'published' WHERE id = $1", [fixture.listingId]);

    const available = await request(app).get(`/api/discovery/listings/${fixture.listingId}/status`).expect(200);
    expect(available.body).toMatchObject({ status: 'available', liveStatus: 'available', available: true });
    expect(available.headers['cache-control']).toBe('public, max-age=10');
    expect(available.headers['set-cookie']).toBeUndefined();

    const detail = await request(app).get(`/api/discovery/listings/${fixture.listingId}`).expect(200);
    expect(detail.body).toMatchObject({
      asking_price: '100.00', status: 'available', liveStatus: 'available', seller: {
        joinDate: expect.any(String), averageRating: 0, ratingCount: 0,
      },
    });
    expect(Object.keys(detail.body.seller).sort()).toEqual(['averageRating', 'joinDate', 'ratingCount']);
    expect(detail.headers['cache-control']).toBe('public, max-age=10');
    expect(detail.headers['set-cookie']).toBeUndefined();

    await db.query("UPDATE listings SET status = 'paused' WHERE id = $1", [fixture.listingId]);
    const pausedDetail = await request(app).get(`/api/discovery/listings/${fixture.listingId}`).expect(200);
    expect(pausedDetail.body).toMatchObject({ unavailable: true, liveStatus: 'unavailable' });
    expect(pausedDetail.headers['x-robots-tag']).toBe('noindex');
    const pausedStatus = await request(app).get(`/api/discovery/listings/${fixture.listingId}/status`).expect(200);
    expect(pausedStatus.body).toMatchObject({ unavailable: true, liveStatus: 'unavailable' });

    await db.query("UPDATE listings SET status = 'published' WHERE id = $1", [fixture.listingId]);
    const { rows: conversationRows } = await db.query(
      `INSERT INTO conversations (listing_id, buyer_id, seller_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [fixture.listingId, fixture.otherUserId, fixture.userId]
    );
    const conversationId = conversationRows[0].id;
    const { rows: offerRows } = await db.query(
      `INSERT INTO offers (conversation_id, listing_id, proposed_by, amount, status)
       VALUES ($1, $2, $3, 100, 'accepted') RETURNING id`,
      [conversationId, fixture.listingId, fixture.otherUserId]
    );
    const offerId = offerRows[0].id;
    let orderId;
    try {
      const { rows: orderRows } = await db.query(
        `INSERT INTO orders
           (accepted_offer_id, listing_id, buyer_id, seller_id, agreed_item_price,
            delivery_address, payment_method_preference, status)
         VALUES ($1, $2, $3, $4, 100, 'fixture address', 'cash', 'order_placed')
         RETURNING id`,
        [offerId, fixture.listingId, fixture.otherUserId, fixture.userId]
      );
      orderId = orderRows[0].id;
      const reserved = await request(app).get(`/api/discovery/listings/${fixture.listingId}/status`).expect(200);
      expect(reserved.body).toMatchObject({ liveStatus: 'reserved', reserved: true, available: false });

      await db.query("UPDATE listings SET status = 'sold' WHERE id = $1", [fixture.listingId]);
      const similarIds = [];
      const baseCreatedAt = Date.now();
      for (let index = 0; index < 7; index += 1) {
        similarIds.push(await createPublishedListing(
          `Similar item ${index}`, index === 6 ? 131 : 70 + index * 10,
          new Date(baseCreatedAt + index * 1000)
        ));
      }
      await createPublishedListing('Outside price range', 131, new Date(baseCreatedAt + 10000));
      const soldDetail = await request(app).get(`/api/discovery/listings/${fixture.listingId}`).expect(200);
      expect(soldDetail.body).toMatchObject({ sold: true, liveStatus: 'sold' });
      expect(soldDetail.headers['x-robots-tag']).toBe('noindex');
      expect(soldDetail.body.similarItems).toHaveLength(6);
      expect(soldDetail.body.similarItems.map((item) => item.id)).toEqual(similarIds.slice(0, 6).reverse());
      expect(soldDetail.body.similarItems.map((item) => item.id)).not.toContain(similarIds[6]);
      const soldStatus = await request(app).get(`/api/discovery/listings/${fixture.listingId}/status`).expect(200);
      expect(soldStatus.body).toMatchObject({ liveStatus: 'sold', sold: true });

      await db.query("UPDATE listings SET status = 'unpublished' WHERE id = $1", [fixture.listingId]);
      await request(app).get(`/api/discovery/listings/${fixture.listingId}`).expect(410);
      await request(app).get(`/api/discovery/listings/${fixture.listingId}/status`).expect(410);
    } finally {
      if (orderId) await db.query('DELETE FROM orders WHERE id = $1', [orderId]);
      await db.query('DELETE FROM offers WHERE id = $1', [offerId]);
      await db.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
    }
  });

  test('FR-22a, FR-26: favorites require login, add/remove idempotently, and paginate by keyset', async () => {
    await db.query("UPDATE listings SET status = 'published' WHERE id = $1", [fixture.listingId]);
    const secondId = await createPublishedListing('Second favorite', 110, new Date());
    const thirdId = await createPublishedListing('Third favorite', 120, new Date(Date.now() + 1000));

    await request(app).get('/api/discovery/favorites').expect(401).expect('Cache-Control', 'private, no-store');

    const token = authenticateAsFixtureSeller();
    for (const id of [fixture.listingId, secondId, thirdId]) {
      await request(app).post(`/api/discovery/listings/${id}/favorite`)
        .set('Authorization', `Bearer ${token}`).expect(204);
      await request(app).post(`/api/discovery/listings/${id}/favorite`)
        .set('Authorization', `Bearer ${token}`).expect(204);
    }

    const firstPage = await request(app).get('/api/discovery/favorites?limit=1')
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(firstPage.headers['cache-control']).toBe('private, no-store');
    expect(firstPage.body.items).toHaveLength(1);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));
    const secondPage = await request(app).get('/api/discovery/favorites')
      .query({ limit: 1, cursor: firstPage.body.nextCursor })
      .set('Authorization', `Bearer ${token}`).expect(200);
    const thirdPage = await request(app).get('/api/discovery/favorites')
      .query({ limit: 1, cursor: secondPage.body.nextCursor })
      .set('Authorization', `Bearer ${token}`).expect(200);
    const listedIds = [
      firstPage.body.items[0].id, secondPage.body.items[0].id, thirdPage.body.items[0].id,
    ];
    expect(new Set(listedIds)).toEqual(new Set([fixture.listingId, secondId, thirdId]));
    expect(thirdPage.body.nextCursor).toBeNull();

    await request(app).delete(`/api/discovery/listings/${secondId}/favorite`)
      .set('Authorization', `Bearer ${token}`).expect(204);
    await request(app).delete(`/api/discovery/listings/${secondId}/favorite`)
      .set('Authorization', `Bearer ${token}`).expect(204);
    const { rows } = await db.query('SELECT count(*)::int AS count FROM favorites WHERE user_id = $1 AND listing_id = $2', [fixture.userId, secondId]);
    expect(rows[0].count).toBe(0);
  });

  test('FR-27: public share URL is available without login and does not set cookies', async () => {
    process.env.PUBLIC_BASE_URL = 'https://market.example/';
    const { rows } = await db.query(
      'SELECT slug, short_id FROM listings WHERE id = $1', [fixture.listingId]
    );
    const response = await request(app)
      .get(`/api/discovery/listings/${fixture.listingId}/share-url`)
      .expect(200);
    expect(response.body.url).toBe(`https://market.example/listing/${rows[0].slug}-${rows[0].short_id}`);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('public, max-age=10');
  });
});
