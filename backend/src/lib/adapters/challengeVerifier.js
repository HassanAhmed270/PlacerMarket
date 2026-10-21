function createChallengeVerifier({ adapter, allowFake = false, production = false } = {}) {
  if (adapter && typeof adapter.verify === 'function') {
    if (adapter.kind === 'fake' && (production || allowFake !== true)) {
      throw new Error('Credential configuration error: fake challenge verifier requires explicit non-production opt-in.');
    }
    if (adapter.kind !== 'live' && adapter.kind !== 'fake') {
      throw new Error('Credential configuration error: challenge verifier must declare live or fake adapter kind.');
    }
    return adapter;
  }
  if (adapter === 'fake' && production) {
    throw new Error('Credential configuration error: fake challenge verifier requires explicit non-production opt-in.');
  }
  if (production) throw new Error('Credential configuration error: a live challenge verifier is required in production.');
  if (adapter !== 'fake' || allowFake !== true) {
    throw new Error('Credential configuration error: select a live challenge verifier or explicitly enable the fake adapter.');
  }

  return Object.freeze({
    async verify() { return { verified: true, source: 'explicit-test-fake' }; },
  });
}

module.exports = { createChallengeVerifier };
