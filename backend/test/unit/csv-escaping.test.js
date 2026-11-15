const { csvCell } = require('../../src/modules/sellerPayouts.service');

describe('FR-48: payout CSV cell escaping', () => {
  test.each(['=', '+', '-', '@', '\t'])(
    'prefix %j is escaped to prevent spreadsheet formulas',
    (prefix) => {
      expect(csvCell(`${prefix}value`)).toBe(`'${prefix}value`);
    }
  );

  test('a leading carriage return is quoted after formula protection', () => {
    expect(csvCell('\rvalue')).toBe(`"'\rvalue"`);
  });

  test('quotes fields containing commas, quotes, and newlines', () => {
    expect(csvCell('one,two')).toBe('"one,two"');
    expect(csvCell('say "hello"')).toBe('"say ""hello"""');
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
    expect(csvCell('line one\rline two')).toBe('"line one\rline two"');
  });

  test('null and undefined values become empty cells', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
});
