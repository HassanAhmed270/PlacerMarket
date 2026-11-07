const { validateAdminOrderListQuery } = require('../../src/modules/delivery.service');

describe('FR-68 Admin order list query validation', () => {
  test('FR-68: defaults the limit to 20 and caps it at 50', () => {
    expect(validateAdminOrderListQuery({})).toEqual({
      limit: 20,
      status: null,
      before: null,
    });
    expect(validateAdminOrderListQuery({ limit: '500' }).limit).toBe(50);
  });

  test('FR-68: accepts a UUID cursor and rejects malformed paging fields', () => {
    const before = '123e4567-e89b-42d3-a456-426614174000';
    expect(validateAdminOrderListQuery({ before, limit: '2' })).toEqual({
      limit: 2,
      status: null,
      before,
    });
    expect(() => validateAdminOrderListQuery({ limit: '0' })).toThrow('limit must be a positive integer.');
    expect(() => validateAdminOrderListQuery({ before: 'not-a-uuid' })).toThrow(
      'before must be a reservation-backed order UUID.'
    );
    expect(() => validateAdminOrderListQuery({ status: ['funded'] })).toThrow(
      'status must be a single order_status value.'
    );
  });
});
