const nextTestPhone = require('../helpers/testPhone');

describe('FR-86 delivery city integration phone fixtures', () => {
  test('generates 10,000 unique phone values', () => {
    const phones = Array.from({ length: 10000 }, nextTestPhone);
    expect(phones.length - new Set(phones).size).toBe(0);
  });
});
