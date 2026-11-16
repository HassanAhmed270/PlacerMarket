const { dateOnly } = require('../../src/modules/sellerPayouts.service');

describe('FR-48: payout DATE formatting', () => {
  test('formats a local-midnight Date from local calendar parts', () => {
    expect(dateOnly(new Date(2026, 10, 16, 0, 0, 0))).toBe('2026-11-16');
  });

  test('formats a Date at 23:59 from local calendar parts', () => {
    expect(dateOnly(new Date(2026, 10, 16, 23, 59, 0))).toBe('2026-11-16');
  });

  test('formats a YYYY-MM-DD string', () => {
    expect(dateOnly('2026-11-16')).toBe('2026-11-16');
  });

  test('returns null for null and undefined', () => {
    expect(dateOnly(null)).toBeNull();
    expect(dateOnly(undefined)).toBeNull();
  });
});
