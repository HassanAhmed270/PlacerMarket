function createEmailSender({ adapter, allowFake = false, production = false } = {}) {
  if (adapter && typeof adapter.send === 'function') {
    if (adapter.kind === 'fake' && (production || allowFake !== true)) {
      throw new Error('Credential configuration error: fake email sender requires explicit non-production opt-in.');
    }
    if (adapter.kind !== 'live' && adapter.kind !== 'fake') {
      throw new Error('Credential configuration error: email sender must declare live or fake adapter kind.');
    }
    return adapter;
  }
  if (adapter === 'fake' && production) {
    throw new Error('Credential configuration error: fake email sender requires explicit non-production opt-in.');
  }
  if (production) throw new Error('Credential configuration error: a live email sender is required in production.');
  if (adapter !== 'fake' || allowFake !== true) {
    throw new Error('Credential configuration error: select a live email sender or explicitly enable the fake adapter.');
  }

  const sentMessages = [];
  return Object.freeze({
    async send(message) {
      if (!message || typeof message.to !== 'string' || typeof message.subject !== 'string' || typeof message.text !== 'string') {
        throw new TypeError('Email messages require to, subject, and text fields.');
      }
      sentMessages.push(Object.freeze({ to: message.to, subject: message.subject, text: message.text }));
      return { accepted: true };
    },
    getSentMessages() { return sentMessages.slice(); },
  });
}

module.exports = { createEmailSender };
