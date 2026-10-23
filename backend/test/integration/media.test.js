const request = require('supertest');
const sharp = require('sharp');
const db = require('../../src/db.service');
const app = require('../../src/app');
const media = require('../../src/modules/media.service');
const { signAccessToken } = require('../../src/lib/jwt');
const { getSharedRedisClient, setSharedRedisClient } = require('../../src/lib/redis');
const { createFixture } = require('./fixtures');

describe('FR-74 private listing media', () => {
  let fixture;
  beforeEach(async () => { fixture = await createFixture(); });
  afterEach(async () => { if (fixture) await fixture.cleanup(); });

  test('FR-74, FR-74c: upload validates bytes, stores private originals, processes variants, and gates reads', async () => {
    const previousJwt = process.env.JWT_ACCESS_SECRET;
    const previousMedia = process.env.MEDIA_SIGNING_SECRET;
    const previousRedis = getSharedRedisClient();
    process.env.JWT_ACCESS_SECRET = 'integration-media-upload-jwt-secret-at-least-32-bytes';
    process.env.MEDIA_SIGNING_SECRET = 'integration-media-signing-secret-material-32-bytes';
    setSharedRedisClient({ isOpen: true, eval: async () => [1, 1] });
    let originalKey;
    let variants = [];
    try {
      const token = signAccessToken(fixture.userId, { secret: process.env.JWT_ACCESS_SECRET });
      const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#d0a080' } }).png().toBuffer();
      const uploaded = await request(app).post(`/api/media/listings/${fixture.listingId}/images?slot=front`)
        .set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/octet-stream').send(png).expect(202);
      expect(uploaded.body).toMatchObject({ slot: 'front', processing_state: 'pending' });
      expect(JSON.stringify(uploaded.body)).not.toMatch(/original_key|private-media/);
      let result = await db.query('SELECT original_key, processing_state FROM listing_images WHERE id = $1', [uploaded.body.id]);
      originalKey = result.rows[0].original_key;
      expect(originalKey).toMatch(/^[a-f0-9]{2}\/[a-f0-9]{64}\/original$/);
      expect(await media.storage.exists(originalKey)).toBe(true);
      await media.processListingImage(uploaded.body.id);
      result = await db.query(
        'SELECT processing_state, image_url, thumbnail_key, medium_key, large_key, social_key, content_hash FROM listing_images WHERE id = $1',
        [uploaded.body.id]
      );
      const image = result.rows[0];
      expect(image.processing_state).toBe('ready');
      expect(image.image_url).toMatch(/\/medium\/[a-f0-9]{64}\.webp$/);
      variants = [image.thumbnail_key, image.medium_key, image.large_key, image.social_key];
      expect(image.content_hash).toMatch(/^[a-f0-9]{64}$/);
      const variantPath = `/api/media/images/${uploaded.body.id}/medium/${image.medium_key.split('/')[1]}.webp`;
      await request(app).get(variantPath).expect(404);
      await db.query("UPDATE listings SET status = 'pending_review' WHERE id = $1", [fixture.listingId]);
      const moderatorPath = `/api/media/moderation-images/${uploaded.body.id}/medium/${image.medium_key.split('/')[1]}.webp`;
      await request(app).get(moderatorPath).set('Authorization', `Bearer ${token}`).expect(403);
      await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [fixture.otherUserId]);
      const moderatorToken = signAccessToken(fixture.otherUserId, { secret: process.env.JWT_ACCESS_SECRET });
      await request(app).get(moderatorPath).set('Authorization', `Bearer ${moderatorToken}`)
        .expect(200).expect('Content-Type', /image\/webp/).expect('Cache-Control', /private, no-store/);
      await db.query("UPDATE listings SET status = 'published' WHERE id = $1", [fixture.listingId]);
      const publicResponse = await request(app).get(variantPath).expect(200).expect('Content-Type', /image\/webp/);
      expect(publicResponse.headers['cache-control']).toMatch(/immutable/);
      await request(app).get(`/api/media/private?key=${encodeURIComponent(originalKey)}`).expect(404);
      const ownerLink = await request(app).get(`/api/media/images/${uploaded.body.id}/original-url`)
        .set('Authorization', `Bearer ${token}`).expect(200);
      const privateUrl = new URL(ownerLink.body.url, 'http://local.test');
      await request(app).get(`${privateUrl.pathname}${privateUrl.search}`).expect(200).expect('Content-Type', /application\/octet-stream/);
    } finally {
      if (originalKey) await media.storage.delete(originalKey);
      for (const key of variants) await media.storage.delete(key);
      setSharedRedisClient(previousRedis);
      if (previousJwt === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = previousJwt;
      if (previousMedia === undefined) delete process.env.MEDIA_SIGNING_SECRET;
      else process.env.MEDIA_SIGNING_SECRET = previousMedia;
    }
  });
});
