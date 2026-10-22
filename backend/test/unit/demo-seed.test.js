const { requireDevelopmentTarget } = require('../../scripts/demo-seed');

describe('Stage 8 demo seed safety', () => {
  test('requires the explicit non-production fake opt-in', () => {
    expect(() => requireDevelopmentTarget({ DEMO_DATABASE_URL: 'postgres://localhost/poshaak_demo' }))
      .toThrow('DEV_FAKES=1');
    expect(() => requireDevelopmentTarget({ NODE_ENV: 'production', DEV_FAKES: '1', DEMO_DATABASE_URL: 'postgres://localhost/poshaak_demo' }))
      .toThrow('non-production');
  });

  test('accepts only clearly named local development databases and rejects test targets', () => {
    const env = { NODE_ENV: 'development', DEV_FAKES: '1' };
    expect(requireDevelopmentTarget({ ...env, DEMO_DATABASE_URL: 'postgres://localhost/poshaak_demo' }))
      .toBe('postgres://localhost/poshaak_demo');
    expect(() => requireDevelopmentTarget({ ...env, DEMO_DATABASE_URL: 'postgres://db.example.test/poshaak_dev' }))
      .toThrow('localhost');
    expect(() => requireDevelopmentTarget({ ...env, DEMO_DATABASE_URL: 'postgres://localhost/testing_only' }))
      .toThrow('localhost database');
  });
});
