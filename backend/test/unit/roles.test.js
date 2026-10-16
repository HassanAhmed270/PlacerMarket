const { ROLES, hasPermission } = require('../../src/lib/roles');

describe('lib/roles FR-05a permission matrix', () => {
  test('Admin can do everything', () => {
    expect(hasPermission(ROLES.ADMIN, 'fee.configure')).toBe(true);
    expect(hasPermission(ROLES.ADMIN, 'user.suspend')).toBe(true);
    expect(hasPermission(ROLES.ADMIN, 'listing.approve')).toBe(true);
  });

  test('Moderator/Ops CAN review/approve listings and disputes, and seller applications', () => {
    expect(hasPermission(ROLES.MODERATOR, 'listing.review')).toBe(true);
    expect(hasPermission(ROLES.MODERATOR, 'listing.approve')).toBe(true);
    expect(hasPermission(ROLES.MODERATOR, 'dispute.resolve')).toBe(true);
    expect(hasPermission(ROLES.MODERATOR, 'seller_application.approve')).toBe(true);
  });

  test('Moderator/Ops CANNOT configure fees or suspend users (FR-05a explicit carve-out)', () => {
    expect(hasPermission(ROLES.MODERATOR, 'fee.configure')).toBe(false);
    expect(hasPermission(ROLES.MODERATOR, 'user.suspend')).toBe(false);
    expect(hasPermission(ROLES.MODERATOR, 'operations.view')).toBe(false);
  });

  test('Buyer/Seller have no admin permissions', () => {
    expect(hasPermission(ROLES.BUYER, 'listing.approve')).toBe(false);
    expect(hasPermission(ROLES.SELLER, 'dispute.resolve')).toBe(false);
  });
});
