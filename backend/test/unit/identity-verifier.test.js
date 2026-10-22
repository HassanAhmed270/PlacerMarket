const { createIdentityVerifier } = require('../../src/lib/adapters/identityVerifier');

describe('FR-66a: manual identity verifier adapter', () => {
  test('uses the manual Admin implementation by default', async () => {
    const adapter = createIdentityVerifier();
    expect(adapter.kind).toBe('manual');
    await expect(adapter.verify({ sellerId: 'seller', adminId: 'admin', note: 'Reviewed' }))
      .resolves.toEqual({ verified: true, method: 'manual_admin' });
  });

  test('fake identity verification requires DEV_FAKES=1 and is forbidden in production', async () => {
    expect(() => createIdentityVerifier({ adapter: 'fake', env: {} })).toThrow('DEV_FAKES=1');
    expect(() => createIdentityVerifier({ adapter: 'fake', env: { DEV_FAKES: '1', NODE_ENV: 'production' } }))
      .toThrow('DEV_FAKES=1');
    const fake = createIdentityVerifier({ adapter: 'fake', env: { DEV_FAKES: '1', NODE_ENV: 'test' } });
    expect(fake.kind).toBe('fake');
    await expect(fake.verify()).resolves.toEqual({ verified: true, method: 'explicit_test_fake' });
  });
});
