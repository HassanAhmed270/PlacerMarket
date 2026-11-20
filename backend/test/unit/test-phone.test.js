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

  test('300 isolated module instances stay unique with a 7-digit process ID', () => {
    const processIdDescriptor = Object.getOwnPropertyDescriptor(process, 'pid');
    const moduleSequenceKey = Symbol.for('placermarket.testPhone.moduleSequence');
    const moduleSequenceDescriptor = Object.getOwnPropertyDescriptor(process, moduleSequenceKey);
    Object.defineProperty(process, 'pid', { configurable: true, value: 1234567 });

    try {
      const phones = [];
      for (let index = 0; index < 300; index += 1) {
        delete process[moduleSequenceKey];
        jest.isolateModules(() => {
          phones.push(require('../helpers/testPhone')());
        });
      }

      expect(new Set(phones).size).toBe(300);
    } finally {
      Object.defineProperty(process, 'pid', processIdDescriptor);
      if (moduleSequenceDescriptor) {
        Object.defineProperty(process, moduleSequenceKey, moduleSequenceDescriptor);
      } else {
        delete process[moduleSequenceKey];
      }
    }
  });

  test('generates phone values in the international format and database length', () => {
    const phones = Array.from({ length: 1000 }, nextTestPhone);
    for (const phone of phones) {
      expect(phone).toMatch(/^\+?[1-9]\d{7,19}$/);
      expect(phone.length).toBeLessThanOrEqual(20);
    }
  });
});
