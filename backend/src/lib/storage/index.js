const path = require('node:path');
const { createLocalDiskStorage } = require('./localDiskStorage');
const { createFakeStorage } = require('./fakeStorage');

const METHODS = ['put', 'get', 'delete', 'exists', 'signedRead'];

function assertStorageAdapter(adapter) {
  if (!adapter || METHODS.some((name) => typeof adapter[name] !== 'function')) {
    throw new TypeError('Storage adapter must implement put/get/delete/exists/signedRead');
  }
  return adapter;
}

function createStorageAdapter({ env = process.env, root } = {}) {
  if (env.NODE_ENV === 'production' && env.DEV_FAKES === '1') throw new Error('DEV_FAKES is forbidden in production');
  if (env.MEDIA_STORAGE_ADAPTER === 'fake') {
    if (env.NODE_ENV === 'production' || (env.DEV_FAKES !== '1' && env.ALLOW_FAKE_ADAPTERS !== 'true')) {
      throw new Error('Fake media storage requires explicit non-production opt-in.');
    }
    return assertStorageAdapter(createFakeStorage());
  }
  if (env.MEDIA_STORAGE_ADAPTER && env.MEDIA_STORAGE_ADAPTER !== 'local-disk') {
    throw new Error('MEDIA_STORAGE_ADAPTER must be local-disk or an explicitly enabled fake.');
  }
  const webRoot = path.resolve(__dirname, '../../../public');
  const selectedRoot = path.resolve(root || env.MEDIA_STORAGE_ROOT || path.resolve(process.cwd(), '..', 'private-media'));
  if (selectedRoot === webRoot || selectedRoot.startsWith(`${webRoot}${path.sep}`)) {
    throw new Error('MEDIA_STORAGE_ROOT must be outside the public web root');
  }
  return assertStorageAdapter(createLocalDiskStorage({ root: selectedRoot }));
}

module.exports = { createStorageAdapter, assertStorageAdapter };
