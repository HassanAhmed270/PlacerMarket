const { randomBytes, createHmac } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const media = require('../../src/modules/media.service');
const { createLocalDiskStorage } = require('../../src/lib/storage/localDiskStorage');
const { createFakeStorage } = require('../../src/lib/storage/fakeStorage');
const { createStorageAdapter } = require('../../src/lib/storage');

describe('FR-74 media safety', () => {
  test('accepts only JPEG and PNG magic bytes, not a claimed MIME type or SVG', () => {
    expect(media.detectedMime(Buffer.from([0xff, 0xd8, 0xff, 0, 1]))).toBe('image/jpeg');
    expect(media.detectedMime(Buffer.from([137,80,78,71,13,10,26,10,0]))).toBe('image/png');
    expect(media.detectedMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(media.detectedMime(Buffer.from('not an image'))).toBeNull();
  });

  test('FR-74b: placeholder watermark is explicit and replaceable', () => {
    expect(media.watermarkSvg(320, 240).toString()).toContain('POSHAAK');
  });

  test('decodes and re-encodes image variants as WebP without carrying EXIF metadata', async () => {
    const input = await sharp({ create: { width: 48, height: 40, channels: 3, background: '#edcba0' } })
      .jpeg().withMetadata({ exif: { IFD0: { ImageDescription: 'private test metadata' } } }).toBuffer();
    const variants = await media.transformImage(input);
    expect(Object.keys(variants)).toEqual(['thumbnail', 'medium', 'large', 'social']);
    for (const output of Object.values(variants)) {
      const metadata = await sharp(output).metadata();
      expect(metadata.format).toBe('webp');
      expect(metadata.exif).toBeUndefined();
    }
    const social = await sharp(variants.social).metadata();
    expect([social.width, social.height]).toEqual([1200, 630]);
  }, 30000);

  test('local storage refuses traversal and supports private bytes; fake exists only by explicit opt-in', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'poshaak-media-'));
    const secret = randomBytes(32).toString('hex');
    const previousSecret = process.env.MEDIA_SIGNING_SECRET;
    process.env.MEDIA_SIGNING_SECRET = secret;
    try {
      const store = createLocalDiskStorage({ root });
      const key = `ab/${'a'.repeat(64)}/original`;
      await store.put(Buffer.from('private'), { key });
      expect(await store.get(key)).toEqual(Buffer.from('private'));
      await expect(store.get('../outside')).rejects.toThrow('Invalid storage key');
      const signed = new URL(await store.signedRead(key), 'http://local.test');
      const signature = signed.searchParams.get('signature');
      expect(media.verifyPrivateSignature(key, signed.searchParams.get('expires'), signature, secret)).toBe(true);
      expect(media.verifyPrivateSignature('../outside', signed.searchParams.get('expires'), signature, secret)).toBe(false);
      expect(media.verifyPrivateSignature(key, '1', signature, secret)).toBe(false);
      expect(createFakeStorage().put).toBeInstanceOf(Function);
      expect(createStorageAdapter({ env: { NODE_ENV: 'test', DEV_FAKES: '1' } })).toHaveProperty('signedRead');
      expect(() => createStorageAdapter({ env: { NODE_ENV: 'production', DEV_FAKES: '1' } })).toThrow('forbidden in production');
    } finally {
      if (previousSecret === undefined) delete process.env.MEDIA_SIGNING_SECRET;
      else process.env.MEDIA_SIGNING_SECRET = previousSecret;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
