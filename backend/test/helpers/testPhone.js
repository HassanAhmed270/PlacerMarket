let phoneSequence = 0;

function nextTestPhone() {
  phoneSequence += 1;
  return `+155${String(process.pid).padStart(6, '0')}${String(phoneSequence).padStart(6, '0')}`;
}

module.exports = nextTestPhone;
