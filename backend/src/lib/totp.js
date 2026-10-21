const { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { ServiceUnavailableError } = require('./errors');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function encryptionKey(secret = process.env.STAFF_TOTP_ENCRYPTION_SECRET) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new ServiceUnavailableError('Staff authenticator is temporarily unavailable.');
  }
  return createHash('sha256').update('poshaak-staff-totp-v1\0').update(secret).digest();
}

function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value) {
  if (typeof value !== 'string' || !/^[A-Z2-7]+=*$/i.test(value)) throw new TypeError('Invalid authenticator secret.');
  let bits = 0;
  let accumulator = 0;
  const output = [];
  for (const char of value.toUpperCase().replace(/=+$/, '')) {
    accumulator = (accumulator << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      output.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function generateTotpSecret() {
  return encodeBase32(randomBytes(20));
}

function encryptStaffTotpSecret(secret, { keyVersion = 'v1', encryptionSecret } = {}) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(encryptionSecret), nonce);
  const encryptedSecret = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return {
    encryptedSecret,
    nonce,
    authTag: cipher.getAuthTag(),
    keyVersion,
  };
}

function decryptStaffTotpSecret(record, encryptionSecret) {
  if (!record || !Buffer.isBuffer(record.encrypted_secret) || !Buffer.isBuffer(record.nonce) || !Buffer.isBuffer(record.auth_tag)) {
    throw new TypeError('Invalid stored authenticator credential.');
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(encryptionSecret), record.nonce);
  decipher.setAuthTag(record.auth_tag);
  return Buffer.concat([decipher.update(record.encrypted_secret), decipher.final()]).toString('utf8');
}

function totpAt(secret, counter) {
  const key = decodeBase32(secret);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1000000).padStart(6, '0');
}

function generateTotpCode(secret, now = Date.now()) {
  if (!Number.isFinite(now) || now < 0) throw new TypeError('TOTP time must be a non-negative timestamp.');
  return totpAt(secret, Math.floor(now / 30000));
}

function matchingTotpStep(secret, code, { now = Date.now(), window = 1 } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code) || !Number.isSafeInteger(window) || window < 0 || window > 2) return null;
  const currentCounter = Math.floor(now / 30000);
  const candidate = Buffer.from(code);
  for (let offset = -window; offset <= window; offset += 1) {
    if (currentCounter + offset < 0) continue;
    if (timingSafeEqual(candidate, Buffer.from(totpAt(secret, currentCounter + offset)))) return currentCounter + offset;
  }
  return null;
}

function verifyTotpCode(secret, code, options) {
  return matchingTotpStep(secret, code, options) !== null;
}

module.exports = {
  generateTotpSecret, generateTotpCode, encryptStaffTotpSecret,
  decryptStaffTotpSecret, matchingTotpStep, verifyTotpCode,
};
