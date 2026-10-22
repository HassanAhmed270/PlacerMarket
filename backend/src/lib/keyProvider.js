const { ServiceUnavailableError } = require('./errors');

function parseKeyMap(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('PAYOUT_ENCRYPTION_KEYS_JSON is required.');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('PAYOUT_ENCRYPTION_KEYS_JSON must be valid JSON.'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
    throw new Error('PAYOUT_ENCRYPTION_KEYS_JSON must map key IDs to base64 keys.');
  }
  const keys = new Map();
  for (const [id, encoded] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('PAYOUT_ENCRYPTION_KEYS_JSON contains an invalid key ID or base64 key.');
    }
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('Each payout encryption key must decode to exactly 32 bytes.');
    keys.set(id, key);
  }
  return keys;
}

function createKeyProvider({ activeKeyId, keys }) {
  if (!(keys instanceof Map) || !keys.size || typeof activeKeyId !== 'string' || !keys.has(activeKeyId)) {
    throw new Error('PAYOUT_ENCRYPTION_ACTIVE_KEY_ID must identify a configured payout key.');
  }
  return Object.freeze({
    activeKeyId,
    getActiveKey() { return Buffer.from(keys.get(activeKeyId)); },
    getKey(keyId) {
      const key = keys.get(keyId);
      if (!key) throw new ServiceUnavailableError('Payout encryption is temporarily unavailable.');
      return Buffer.from(key);
    },
    hasKey(keyId) { return keys.has(keyId); },
    keyIds() { return [...keys.keys()]; },
  });
}

function keyProviderFromEnv(env = process.env) {
  const keys = parseKeyMap(env.PAYOUT_ENCRYPTION_KEYS_JSON);
  return createKeyProvider({ activeKeyId: env.PAYOUT_ENCRYPTION_ACTIVE_KEY_ID, keys });
}

module.exports = { createKeyProvider, keyProviderFromEnv, parseKeyMap };
