function assertPurger(adapter) {
  if (!adapter || typeof adapter.purge !== 'function') {
    throw new TypeError('CDN purge adapter must implement purge(paths).');
  }
  return adapter;
}

function createFakeCdnPurger() {
  const purges = [];
  return Object.freeze({
    kind: 'fake',
    async purge(paths) {
      if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string' || !path.startsWith('/'))) {
        throw new TypeError('CDN purge paths must be absolute URL paths.');
      }
      purges.push(paths.slice());
      return { purged: paths.length };
    },
    getPurges() { return purges.map((paths) => paths.slice()); },
  });
}

function createCdnPurger({ adapter, adapterModule, allowFake = false, production = false } = {}) {
  if (adapter && typeof adapter.purge === 'function') {
    if (adapter.kind === 'fake' && (production || !allowFake)) {
      throw new Error('CDN configuration error: fake CDN purger requires explicit non-production opt-in.');
    }
    if (adapter.kind !== 'live' && adapter.kind !== 'fake') {
      throw new Error('CDN configuration error: CDN purger must declare live or fake adapter kind.');
    }
    return assertPurger(adapter);
  }
  if (adapter === 'live' && typeof adapterModule === 'string' && adapterModule.trim()) {
    const provider = require(adapterModule);
    if (typeof provider.createCdnPurger !== 'function') {
      throw new Error('CDN configuration error: live adapter module must export createCdnPurger().');
    }
    const liveAdapter = provider.createCdnPurger();
    if (!liveAdapter || liveAdapter.kind !== 'live') {
      throw new Error('CDN configuration error: live adapter module must return a live CDN purger.');
    }
    return assertPurger(liveAdapter);
  }
  if (production && adapter !== 'live') {
    throw new Error('CDN configuration error: a live CDN purger is required in production.');
  }
  if (adapter === 'live') {
    throw new Error('CDN configuration error: CDN_PURGE_ADAPTER_MODULE is required for the live adapter.');
  }
  if (adapter === 'fake' && !production && allowFake) return createFakeCdnPurger();
  if (!production && adapter === undefined) return createFakeCdnPurger();
  throw new Error('CDN configuration error: select a live CDN purger or explicitly enable the fake adapter.');
}

module.exports = { assertPurger, createFakeCdnPurger, createCdnPurger };
