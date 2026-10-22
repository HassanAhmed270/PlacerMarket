const { parseEnv } = require('node:util');
const { requireDevelopmentTarget, serializeDemoEnv } = require('../../scripts/demo-seed');

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

  test('Stage 0b: writes payout JSON in an env-file form that Node parses without altering it', () => {
    const expected = JSON.stringify({ 'demo-v1': Buffer.alloc(32, 7).toString('base64') });
    const text = serializeDemoEnv({ PAYOUT_ENCRYPTION_KEYS_JSON: expected });
    const parsed = parseEnv(text);
    expect(parsed.PAYOUT_ENCRYPTION_KEYS_JSON).toBe(expected);
    expect(JSON.parse(parsed.PAYOUT_ENCRYPTION_KEYS_JSON)).toEqual({ 'demo-v1': Buffer.alloc(32, 7).toString('base64') });
  });
});
