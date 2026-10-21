const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('node:crypto');

function encryptionKey(secret = process.env.EMAIL_QUEUE_ENCRYPTION_SECRET) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('EMAIL_QUEUE_ENCRYPTION_SECRET requires at least 32 bytes of key material.');
  }
  return createHash('sha256').update('poshaak-email-queue-v1\0').update(secret).digest();
}

function encryptEmailPayload(payload, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Object.freeze({
    version: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  });
}

function decryptEmailPayload(envelope, secret) {
  if (!envelope || envelope.version !== 1) throw new TypeError('Unsupported encrypted email payload.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(envelope.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  const payload = JSON.parse(plaintext);
  if (!payload || typeof payload.to !== 'string' || typeof payload.subject !== 'string' || typeof payload.text !== 'string') {
    throw new TypeError('Invalid decrypted email payload.');
  }
  return payload;
}

module.exports = { encryptEmailPayload, decryptEmailPayload };
