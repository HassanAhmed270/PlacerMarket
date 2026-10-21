const { createEmailSender } = require('../../src/lib/adapters/emailSender');
const { createChallengeVerifier } = require('../../src/lib/adapters/challengeVerifier');

describe('credential adapters require explicit fake opt-in', () => {
  test('email fake is unavailable by default and in production', async () => {
    expect(() => createEmailSender({ adapter: 'fake' })).toThrow('explicitly enable');
    expect(() => createEmailSender({ adapter: 'fake', allowFake: true, production: true }))
      .toThrow('explicit non-production opt-in');
    const email = createEmailSender({ adapter: 'fake', allowFake: true });
    await expect(email.send({ to: 'buyer@example.test', subject: 'Code', text: 'redacted-test-code' }))
      .resolves.toEqual({ accepted: true });
    expect(email.getSentMessages()).toHaveLength(1);
    expect(Object.keys(email.getSentMessages()[0])).toEqual(['to', 'subject', 'text']);
  });

  test('challenge fake is unavailable by default and in production', async () => {
    expect(() => createChallengeVerifier({ adapter: 'fake' })).toThrow('explicitly enable');
    expect(() => createChallengeVerifier({ adapter: 'fake', allowFake: true, production: true }))
      .toThrow('explicit non-production opt-in');
    const verifier = createChallengeVerifier({ adapter: 'fake', allowFake: true });
    await expect(verifier.verify('test-only')).resolves.toEqual({ verified: true, source: 'explicit-test-fake' });
  });

  test('production accepts only an injected live adapter', () => {
    const liveSender = { kind: 'live', send: jest.fn() };
    const liveVerifier = { kind: 'live', verify: jest.fn() };
    expect(createEmailSender({ adapter: liveSender, production: true })).toBe(liveSender);
    expect(createChallengeVerifier({ adapter: liveVerifier, production: true })).toBe(liveVerifier);
    expect(() => createEmailSender({ adapter: { kind: 'fake', send() {} }, allowFake: true, production: true }))
      .toThrow('explicit non-production opt-in');
  });
});
