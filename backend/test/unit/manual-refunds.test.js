const { ADMIN_ONLY_ACTIONS, hasPermission, ROLES } = require('../../src/lib/roles');
const users = require('../../src/modules/users.service');
const escrowPayments = require('../../src/modules/escrowPayments.service');

describe('FR-69, SEC-39 manual refund security gates', () => {
  test('SEC-39: refund request and decision grants are supported as separate step-up actions', () => {
    expect(users.STEP_UP_ACTIONS).toEqual(expect.arrayContaining(['refund.request', 'refund.decide']));
    expect(users.STEP_UP_ACTIONS).not.toContain('refund.approve');
  });

  test('SEC-39: refund permissions are Admin-only for read, request, decision, and balance access', () => {
    for (const action of ['refund.view', 'refund.request', 'refund.decide', 'refund.view_balance']) {
      expect(ADMIN_ONLY_ACTIONS.has(action)).toBe(true);
      expect(hasPermission(ROLES.ADMIN, action)).toBe(true);
      expect(hasPermission(ROLES.MODERATOR, action)).toBe(false);
      expect(hasPermission(ROLES.BUYER, action)).toBe(false);
    }
  });

  test('FR-69: refund retry requires the payout-release guard callback', async () => {
    await expect(
      escrowPayments.retryFailedRefund('123e4567-e89b-42d3-a456-426614174000', 'admin-1')
    ).rejects.toThrow(TypeError);
  });
});
