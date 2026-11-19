const nextTestPhone = require('../helpers/testPhone');

describe('FR-86 delivery city integration phone fixtures', () => {
  test('generates 10,000 unique phone values', () => {
    const phones = Array.from({ length: 10000 }, nextTestPhone);
    expect(phones.length - new Set(phones).size).toBe(0);
  });

  test('generates 100,000 unique phone values', () => {
    const phones = Array.from({ length: 100000 }, nextTestPhone);
    expect(new Set(phones).size).toBe(phones.length);
  });

  test('isolated module instances generate phone values that never collide', () => {
    let firstInstance;
    let secondInstance;
    jest.isolateModules(() => {
      firstInstance = require('../helpers/testPhone');
    });
    jest.isolateModules(() => {
      secondInstance = require('../helpers/testPhone');
    });

    const phones = [
      ...Array.from({ length: 1000 }, firstInstance),
      ...Array.from({ length: 1000 }, secondInstance),
    ];
    expect(new Set(phones).size).toBe(phones.length);
  });

  test('generates phone values in the international format and database length', () => {
    const phones = Array.from({ length: 1000 }, nextTestPhone);
    for (const phone of phones) {
      expect(phone).toMatch(/^\+?[1-9]\d{7,19}$/);
      expect(phone.length).toBeLessThanOrEqual(20);
    }
  });
});
