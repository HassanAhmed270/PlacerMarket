function createFakeStorage() {
  const objects = new Map();
  return {
    async put(buffer, { key } = {}) { const id = key || `fake/${objects.size}`; objects.set(id, Buffer.from(buffer)); return { key: id }; },
    async get(key) { if (!objects.has(key)) throw Object.assign(new Error('Not found'), { code: 'ENOENT' }); return Buffer.from(objects.get(key)); },
    async delete(key) { objects.delete(key); },
    async exists(key) { return objects.has(key); },
    async signedRead(key) { if (!objects.has(key)) throw new Error('Not found'); return `/fake-private/${encodeURIComponent(key)}`; },
    objects,
  };
}

module.exports = { createFakeStorage };
