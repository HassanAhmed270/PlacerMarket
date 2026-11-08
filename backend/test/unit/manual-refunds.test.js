const { ADMIN_ONLY_ACTIONS, hasPermission, ROLES } = require('../../src/lib/roles');
const users = require('../../src/modules/users.service');

describe('FR-69, SEC-39 manual refund security gates', () => {
  test('SEC-39: refund request and decision grants are supported as separate step-up actions', () => {
    expect(users.STEP_UP_ACTIONS).toEqual(expect.arrayContaining(['refund.request', 'refund.decide']));
    expect(users.STEP_UP_ACTIONS).not.toContain('refund.approve');
  });

  test('SEC-39: refund permissions are Admin-only for request, decision, and balance access', () => {
    for (const action of ['refund.request', 'refund.decide', 'refund.view_balance']) {
      expect(ADMIN_ONLY_ACTIONS.has(action)).toBe(true);
      expect(hasPermission(ROLES.ADMIN, action)).toBe(true);
      expect(hasPermission(ROLES.MODERATOR, action)).toBe(false);
      expect(hasPermission(ROLES.BUYER, action)).toBe(false);
    }
  });
});
