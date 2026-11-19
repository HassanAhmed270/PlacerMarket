const crypto = require('node:crypto');
const nodeProcess = require('node:process');

const PHONE_PREFIX = '+1';
const PHONE_COUNTER_WIDTH = 6;
const MAX_PHONE_LENGTH = 20;
const PROCESS_ID = String(nodeProcess.pid);
const tokenWidth = MAX_PHONE_LENGTH - PHONE_PREFIX.length - PROCESS_ID.length - PHONE_COUNTER_WIDTH;
const moduleSequenceWidth = Math.min(3, tokenWidth - 1);

if (moduleSequenceWidth < 1) {
  throw new Error('Process ID leaves no room for a unique test phone module token.');
}

const moduleSequenceKey = Symbol.for('placermarket.testPhone.moduleSequence');
const moduleSequence = (nodeProcess[moduleSequenceKey] || 0) + 1;
if (moduleSequence >= 10 ** moduleSequenceWidth) {
  throw new Error('Test phone module sequence exhausted.');
}
nodeProcess[moduleSequenceKey] = moduleSequence;

const randomTokenWidth = tokenWidth - moduleSequenceWidth;
const moduleToken = [
  String(moduleSequence).padStart(moduleSequenceWidth, '0'),
  String(crypto.randomInt(0, 10 ** randomTokenWidth)).padStart(randomTokenWidth, '0'),
].join('');

let phoneSequence = 0;

function nextTestPhone() {
  if (phoneSequence >= 10 ** PHONE_COUNTER_WIDTH) {
    throw new Error('Test phone sequence exhausted.');
  }
  const sequence = phoneSequence;
  phoneSequence += 1;
  return `${PHONE_PREFIX}${PROCESS_ID}${moduleToken}${String(sequence).padStart(PHONE_COUNTER_WIDTH, '0')}`;
}

module.exports = nextTestPhone;
