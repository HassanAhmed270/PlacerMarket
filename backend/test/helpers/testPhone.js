const crypto = require('node:crypto');

const PHONE_PREFIX = '+1';
const PHONE_COUNTER_WIDTH = 6;
const moduleToken = [
  String(crypto.randomInt(0, 100000)).padStart(5, '0'),
  String(crypto.randomInt(0, 1000000)).padStart(6, '0'),
].join('');

let phoneSequence = 0;

function nextTestPhone() {
  if (phoneSequence >= 10 ** PHONE_COUNTER_WIDTH) {
    throw new Error('Test phone sequence exhausted.');
  }
  const sequence = phoneSequence;
  phoneSequence += 1;
  return `${PHONE_PREFIX}${moduleToken}${String(sequence).padStart(PHONE_COUNTER_WIDTH, '0')}`;
}

module.exports = nextTestPhone;
