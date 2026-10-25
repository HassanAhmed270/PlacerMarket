const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const db = require('../db.service');
const { createStorageAdapter } = require('../lib/storage');
const { ValidationError, ForbiddenError, NotFoundError } = require('../lib/errors');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Map([
  ['image/jpeg', (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))],
]);
const VARIANTS = Object.freeze({ thumbnail: 240, medium: 640, large: 1600 });
const storage = createStorageAdapter();

/** FR-74b: produce the replaceable placeholder watermark overlay for public variants. */
function watermarkSvg(width, height) {
  const markWidth = Math.max(24, Math.min(180, width - 8));
  const markHeight = Math.max(12, Math.min(36, height - 8));
  return Buffer.from(`<svg width="${markWidth}" height="${markHeight}"><rect width="100%" height="100%" fill="#000" fill-opacity=".28"/><text x="6" y="${markHeight - 6}" fill="white" font-size="${Math.min(22, markHeight - 4)}" font-family="sans-serif">POSHAAK</text></svg>`);
}

/** FR-74: recognize supported image formats from their bytes, never the request header. */
function detectedMime(buffer) {
  for (const [mime, matches] of ALLOWED_MIME) if (matches(buffer)) return mime;
  return null;
}

function mediaKey(bytes, variant) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  return { key: `${digest.slice(0, 2)}/${digest}/${variant}`, digest };
}

/** FR-74: verify a short-lived HMAC capability for a private object read. */
function verifyPrivateSignature(key, expires, signature, secret = process.env.MEDIA_SIGNING_SECRET) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || !/^\d{1,12}$/.test(String(expires)) || Number(expires) < Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac('sha256', secret).update(`${key}\n${expires}`).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return false; }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** FR-74: decode an upload, remove metadata by re-encoding, and create watermarked WebP variants. */
async function transformImage(input, sharpFactory = require('sharp')) {
  const mime = detectedMime(input);
  if (!mime || input.length > MAX_IMAGE_BYTES) throw new ValidationError('Unsupported image payload');
  const metadata = await sharpFactory(input, { limitInputPixels: 40_000_000, failOn: 'warning' }).metadata();
  if (!['jpeg', 'png'].includes(metadata.format) || !metadata.width || !metadata.height || metadata.width < 32 || metadata.height < 32) {
    throw new ValidationError('Image dimensions or format are not supported');
  }
  const variants = {};
  for (const [name, width] of Object.entries(VARIANTS)) {
    const converted = await sharpFactory(input, { limitInputPixels: 40_000_000 })
      .rotate().resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 }).toBuffer();
    const size = await sharpFactory(converted).metadata();
    variants[name] = await sharpFactory(converted)
      .composite([{ input: watermarkSvg(size.width, size.height), gravity: 'southeast' }])
      .webp({ quality: 82 }).toBuffer();
  }
  variants.social = await sharpFactory(input, { limitInputPixels: 40_000_000 }).rotate()
    .resize(1200, 630, { fit: 'cover', position: 'attention' })
    .composite([{ input: watermarkSvg(1200, 630), gravity: 'southeast' }]).webp({ quality: 82 }).toBuffer();
  return variants;
}

/** FR-74: worker entry point for retryable, idempotent listing image processing. */
async function processListingImage(imageId) {
  const { rows } = await db.query(
    `UPDATE listing_images SET processing_state = 'processing'
     WHERE id = $1 AND processing_state IN ('pending', 'failed', 'processing')
     RETURNING id, original_key`, [imageId]
  );
  const image = rows[0];
  if (!image) return null;
  try {
    const input = await storage.get(image.original_key);
    const outputs = await transformImage(input);
    const keys = {};
    for (const [name, output] of Object.entries(outputs)) {
      const named = mediaKey(output, name);
      await storage.put(output, { key: named.key, contentType: 'image/webp' });
      keys[name] = named.key;
    }
    const digest = createHash('sha256').update(input).digest('hex');
    const mediumHash = keys.medium.split('/')[1];
    await db.query(
      `UPDATE listing_images SET processing_state = 'ready', thumbnail_key = $2, medium_key = $3,
       large_key = $4, social_key = $5, content_hash = $6, image_url = $7 WHERE id = $1`,
      [image.id, keys.thumbnail, keys.medium, keys.large, keys.social, digest,
        `/api/media/images/${image.id}/medium/${mediumHash}.webp`]
    );
    return { id: image.id, contentHash: digest };
  } catch (error) {
    await db.query("UPDATE listing_images SET processing_state = 'failed' WHERE id = $1", [image.id]);
    throw error;
  }
}

/** FR-74: store a private original and enqueue processing for an owned listing slot. */
async function uploadListingImage({ listingId, sellerId, slot, bytes }) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > MAX_IMAGE_BYTES) throw new ValidationError('Image must be between 16 bytes and 5 MiB');
  const mime = detectedMime(bytes);
  if (!mime) throw new ValidationError('Only JPEG and PNG images are accepted');
  if (!['front', 'back', 'other', 'optional_1', 'optional_2', 'optional_3'].includes(slot)) throw new ValidationError('A valid labeled image slot is required');
  const { rows: listingRows } = await db.query('SELECT seller_id, status FROM listings WHERE id = $1', [listingId]);
  if (!listingRows[0]) throw new NotFoundError('listing', listingId);
  if (listingRows[0].seller_id !== sellerId) throw new ForbiddenError('Not your listing');
  if (!['draft', 'rejected'].includes(listingRows[0].status)) throw new ValidationError('Images can only be added before submission or after rejection');
  const { rows: approved } = await db.query("SELECT is_approved FROM seller_profiles WHERE user_id = $1", [sellerId]);
  if (!approved[0]?.is_approved) throw new ForbiddenError('Only active approved sellers can upload listing images');
  const originalKey = `${randomBytes(1).toString('hex')}/${randomBytes(32).toString('hex')}/original`;
  await storage.put(bytes, { key: originalKey, contentType: mime });
  try {
    return await db.withTransaction(async (client) => {
      const { rows: locked } = await client.query('SELECT seller_id, status FROM listings WHERE id = $1 FOR UPDATE', [listingId]);
      if (!locked[0] || locked[0].seller_id !== sellerId) throw new ForbiddenError('Not your listing');
      if (!['draft', 'rejected'].includes(locked[0].status)) throw new ValidationError('Images can only be added before submission or after rejection');
      const { rows: existing } = await client.query('SELECT count(*)::int AS count FROM listing_images WHERE listing_id = $1', [listingId]);
      if (existing[0].count >= 6) throw new ValidationError('A listing can have at most six images');
      const { rows: inserted } = await client.query(
        `INSERT INTO listing_images (listing_id, image_url, display_order, slot, processing_state, original_key)
         VALUES ($1, '', (SELECT coalesce(max(display_order), 0) + 1 FROM listing_images WHERE listing_id = $1), $2, 'pending', $3)
         RETURNING id, slot, processing_state`, [listingId, slot, originalKey]
      );
      const queue = require('../lib/queue');
      await queue.enqueue(queue.QUEUES.MEDIA, { listingImageId: inserted[0].id }, {
        idempotencyKey: `listing-image:${inserted[0].id}`, orderingKey: `listing-image:${inserted[0].id}`, transaction: client,
      });
      return inserted[0];
    });
  } catch (error) {
    await storage.delete(originalKey).catch(() => {});
    throw error;
  }
}

/** FR-74: serve only an immutable processed variant of a published listing. */
async function publicVariant(imageId, variant, contentHash) {
  const column = ({ thumbnail: 'thumbnail_key', medium: 'medium_key', large: 'large_key', social: 'social_key' })[variant];
  if (!column) return null;
  const { rows } = await db.query(
    `SELECT i.${column} AS object_key FROM listing_images i JOIN listings l ON l.id = i.listing_id
     WHERE i.id = $1 AND i.processing_state = 'ready'
       AND l.status IN ('published', 'paused', 'sold')`, [imageId]
  );
  const keyHash = rows[0]?.object_key?.split('/')[1];
  return keyHash && keyHash === contentHash ? storage.get(rows[0].object_key) : null;
}

/** FR-74a: authorized moderators can inspect processed variants before publication. */
async function moderationVariant(imageId, variant, contentHash) {
  const column = ({ thumbnail: 'thumbnail_key', medium: 'medium_key', large: 'large_key', social: 'social_key' })[variant];
  if (!column) return null;
  const { rows } = await db.query(
    `SELECT i.${column} AS object_key FROM listing_images i JOIN listings l ON l.id = i.listing_id
     WHERE i.id = $1 AND i.processing_state = 'ready' AND l.status = 'pending_review'`, [imageId]
  );
  const keyHash = rows[0]?.object_key?.split('/')[1];
  return keyHash && keyHash === contentHash ? storage.get(rows[0].object_key) : null;
}

/** FR-74: resolve a private object only when its signed read capability is valid. */
async function privateObject(key, expires, signature) {
  if (!verifyPrivateSignature(key, expires, signature)) return null;
  if (!await storage.exists(key)) return null;
  return storage.get(key);
}

/** FR-74: issue a short-lived private read capability only to the listing owner. */
async function signedOriginal(imageId, sellerId) {
  const { rows } = await db.query(
    `SELECT i.original_key FROM listing_images i JOIN listings l ON l.id = i.listing_id
     WHERE i.id = $1 AND l.seller_id = $2`, [imageId, sellerId]
  );
  if (!rows[0]) return null;
  return storage.signedRead(rows[0].original_key);
}

module.exports = { MAX_IMAGE_BYTES, detectedMime, verifyPrivateSignature, watermarkSvg, transformImage, processListingImage, uploadListingImage, publicVariant, moderationVariant, privateObject, signedOriginal, storage };
