const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

function keyPath(root, key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{2}\/[a-f0-9]{64}(?:\/[a-z]+)?$/i.test(key)) {
    throw new Error('Invalid storage key');
  }
  const resolved = path.resolve(root, key);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Invalid storage key');
  return resolved;
}

function createLocalDiskStorage({ root = process.env.MEDIA_STORAGE_ROOT || path.resolve(process.cwd(), '..', 'private-media') } = {}) {
  const absoluteRoot = path.resolve(root);
  return {
    async put(buffer, { key, contentType = 'application/octet-stream' } = {}) {
      if (!Buffer.isBuffer(buffer)) throw new TypeError('Storage accepts a Buffer');
      const actualKey = key || `${randomBytes(1).toString('hex')}/${randomBytes(32).toString('hex')}`;
      const target = keyPath(absoluteRoot, actualKey);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      try { await fs.writeFile(target, buffer, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await fs.readFile(target);
        if (!existing.equals(buffer)) throw new Error('Immutable storage key collision');
      }
      return { key: actualKey, contentType };
    },
    async get(key) { return fs.readFile(keyPath(absoluteRoot, key)); },
    async delete(key) { await fs.rm(keyPath(absoluteRoot, key), { force: true }); },
    async exists(key) { try { await fs.access(keyPath(absoluteRoot, key)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } },
    async signedRead(key, { expiresInSeconds = 300 } = {}) {
      const { createHmac } = require('node:crypto');
      const secret = process.env.MEDIA_SIGNING_SECRET;
      if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw new Error('MEDIA_SIGNING_SECRET must be at least 32 bytes');
      const expires = Math.floor(Date.now() / 1000) + Math.min(Math.max(expiresInSeconds, 1), 300);
      const signature = createHmac('sha256', secret).update(`${key}\n${expires}`).digest('base64url');
      return `/api/media/private?key=${encodeURIComponent(key)}&expires=${expires}&signature=${signature}`;
    },
  };
}

module.exports = { createLocalDiskStorage, keyPath };
