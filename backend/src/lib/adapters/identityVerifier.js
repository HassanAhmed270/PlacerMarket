function createManualAdminIdentityVerifier() {
  return Object.freeze({
    kind: 'manual',
    async verify() { return { verified: true, method: 'manual_admin' }; },
  });
}

function createFakeIdentityVerifier({ env = process.env } = {}) {
  if (env.NODE_ENV === 'production' || env.DEV_FAKES !== '1') {
    throw new Error('Identity verification fake requires explicit non-production DEV_FAKES=1 opt-in.');
  }
  return Object.freeze({
    kind: 'fake',
    async verify() { return { verified: true, method: 'explicit_test_fake' }; },
  });
}

function createIdentityVerifier({ adapter = 'manual-admin', env = process.env } = {}) {
  if (adapter && typeof adapter.verify === 'function') {
    if (adapter.kind === 'fake' && (env.NODE_ENV === 'production' || env.DEV_FAKES !== '1')) {
      throw new Error('Identity verification fake requires explicit non-production DEV_FAKES=1 opt-in.');
    }
    if (!['manual', 'fake'].includes(adapter.kind)) throw new Error('IdentityVerifier must declare manual or fake kind.');
    return adapter;
  }
  if (adapter === 'manual-admin') return createManualAdminIdentityVerifier();
  if (adapter === 'fake') return createFakeIdentityVerifier({ env });
  throw new Error('IdentityVerifier requires the manual-admin adapter or an explicitly enabled fake.');
}

module.exports = { createIdentityVerifier, createManualAdminIdentityVerifier, createFakeIdentityVerifier };
