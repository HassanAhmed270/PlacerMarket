const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { keyProviderFromEnv } = require('./keyProvider');

const ALGORITHM = 'aes-256-gcm';
const VERSION = 1;

function additionalData(sellerId) {
  if (typeof sellerId !== 'string' || !sellerId) throw new TypeError('A seller ID is required for payout encryption.');
  return Buffer.from(`poshaak:payout-details:v${VERSION}:${sellerId}`, 'utf8');
}

function encryptPayoutDetails(details, sellerId, keyProvider = keyProviderFromEnv()) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) throw new TypeError('Payout details must be an object.');
  const keyId = keyProvider.activeKeyId;
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, keyProvider.getActiveKey(), nonce);
  cipher.setAAD(additionalData(sellerId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(details), 'utf8'), cipher.final()]);
  return Object.freeze({
    version: VERSION,
    algorithm: ALGORITHM,
    keyId,
    nonce: nonce.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  });
}

function decryptPayoutDetails(envelope, sellerId, keyProvider = keyProviderFromEnv()) {
  if (!envelope || envelope.version !== VERSION || envelope.algorithm !== ALGORITHM || typeof envelope.keyId !== 'string') {
    throw new TypeError('Unsupported encrypted payout details.');
  }
  const decode = (value) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('Invalid encrypted payout details.');
    return Buffer.from(value, 'base64url');
  };
  const nonce = decode(envelope.nonce);
  const tag = decode(envelope.tag);
  const ciphertext = decode(envelope.ciphertext);
  if (nonce.length !== 12 || tag.length !== 16) throw new TypeError('Invalid encrypted payout details.');
  const decipher = createDecipheriv(ALGORITHM, keyProvider.getKey(envelope.keyId), nonce);
  decipher.setAAD(additionalData(sellerId));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  const details = JSON.parse(plaintext);
  if (!details || typeof details !== 'object' || Array.isArray(details)) throw new TypeError('Invalid decrypted payout details.');
  return details;
}

module.exports = { encryptPayoutDetails, decryptPayoutDetails, ALGORITHM, VERSION };
